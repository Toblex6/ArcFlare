// src/components/checkout/CheckoutCrossChain.tsx
//
// Cross-chain checkout: the payer's own wallet signs the source-chain burn via
// Circle Bridge Kit (forwarder on, destination Arc, mint recipient = the
// invoice's merchant wallet). The server creates one durable intent bound to
// this invoice, verifies the burn and the Arc mint from receipts, and marks the
// invoice paid only after the merchant credit is proven.
//
// Non-custodial: the browser signs; this component never receives keys and the
// server never signs or broadcasts. Recovery resumes the same intent. A
// confirmed shortfall can be paid with a separate top-up.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import {
  getBridgeSourceChains,
  type BridgeSourceChain,
} from '@/lib/bridge/sourceChains';
import { sourceViemChainFor } from '@/lib/bridge/sourceViemChains';
import { ensureEvmNetwork } from '@/lib/wallet/ensureEvmNetwork';
import { friendlyBridgeError } from '@/lib/wallet/walletErrors';
import { extractBurnTxHash } from '@/lib/bridge/resumeStore';
import { trackCheckoutWallet } from '@/lib/checkout/bridgeWallet';
import { useNetwork } from '@/src/components/NetworkContext';

interface Props {
  reference: string;
  invoiceAmount: number;
  merchantSCA: string | null;
  disabled?: boolean;
  onPending?: () => void;
  onSettled?: () => void;
}

const RESUME_KEY = (reference: string) => `flarehq-checkout-bridge:${reference}`;

type Resume = { intent: string; burnTxHash: string | null; ready?: boolean };

function loadResume(reference: string): Resume | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY(reference));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.intent === 'string'
      ? {
          intent: parsed.intent,
          burnTxHash: parsed.uncertain === true ? null : parsed.burnTxHash ?? null,
          ready: parsed.ready === true && !parsed.burnTxHash && parsed.uncertain !== true,
        }
      : null;
  } catch {
    return null;
  }
}

function saveResume(reference: string, intent: string, burnTxHash: string | null, ready = false, uncertain = false): void {
  // Reserve the exact-size transaction hash slot before asking the wallet to
  // broadcast. If the tab closes during the prompt, reload remains blocked on
  // manual hash recovery; a returned hash overwrites the reserved slot.
  const storedHash = uncertain && !burnTxHash ? `0x${'0'.repeat(64)}` : burnTxHash;
  localStorage.setItem(RESUME_KEY(reference), JSON.stringify({ intent, burnTxHash: storedHash, ready, uncertain }));
}

function assertResumeStorage(reference: string): void {
  const key = `${RESUME_KEY(reference)}:storage-check`;
  localStorage.setItem(key, 'resume-check');
  localStorage.removeItem(key);
}

function clearResume(reference: string): void {
  try {
    localStorage.removeItem(RESUME_KEY(reference));
  } catch {
    // ignore
  }
}

function burnHashFromResult(result: any): string | null {
  const fromHelper = extractBurnTxHash(result);
  if (fromHelper) return fromHelper;
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const step = steps.find((s: any) => String(s?.name ?? s?.method ?? '').toLowerCase() === 'burn');
  return typeof step?.txHash === 'string' ? step.txHash : null;
}

export default function CheckoutCrossChain({ reference, invoiceAmount, merchantSCA, disabled, onPending, onSettled }: Props) {
  const { name: networkName } = useNetwork();
  const bridgeNetwork = networkName === 'mainnet' ? 'mainnet' : 'testnet';
  const sources = useMemo(() => getBridgeSourceChains(bridgeNetwork), [bridgeNetwork]);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const source = sources.find((s) => s.id === sourceId) ?? sources[0];

  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resume, setResume] = useState<Resume | null>(null);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [topUp, setTopUp] = useState<{ after: string; remaining: string } | null>(null);
  const [liveAmount, setLiveAmount] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setResume(loadResume(reference));
    setTopUp(null);
    setLiveAmount(null);
    setRecoveryHash('');
    return () => { mounted.current = false; };
  }, [reference]);

  useEffect(() => {
    if (sources.length && !sources.some((s) => s.id === sourceId)) setSourceId(sources[0].id);
  }, [sources, sourceId]);

  const postJson = useCallback(async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json().catch(() => ({}));
  }, []);

  const getProvider = useCallback(async (): Promise<any> => {
    try {
      if (connector) return await (connector as any).getProvider?.();
      return (window as any)?.ethereum ?? null;
    } catch {
      return null;
    }
  }, [connector]);

  const ensureOnSource = useCallback(async (src: BridgeSourceChain): Promise<void> => {
    const viemChain = sourceViemChainFor(src.chainId);
    if (!viemChain) throw new Error('This source chain is not currently supported.');
    const net = await ensureEvmNetwork({
      chain: viemChain,
      chainId,
      switchChainAsync,
      getProvider,
    });
    if (!net.ok) throw new Error(net.message);
  }, [chainId, switchChainAsync, getProvider]);

  const complete = useCallback(async (intent: string, burnTxHash: string | null): Promise<boolean> => {
    if (burnTxHash) {
      const confirmed = await postJson(`/api/checkout/${encodeURIComponent(reference)}/bridge/confirm`, { intent, burnTxHash });
      if (!confirmed?.success && confirmed?.state !== 'completed') {
        if (confirmed?.safeToRetry === true && confirmed?.reason === 'APPROVAL_ONLY') {
          // The server proved this candidate was only the USDC allowance for
          // Bridge Kit, not a burn. Keep the same intent but clear its hash so
          // Bridge Kit can submit the actual burn.
          saveResume(reference, intent, null, true);
          setResume({ intent, burnTxHash: null, ready: true });
          setError('That transaction only approved USDC spending; it did not burn USDC. Retry this same payment.');
          return false;
        }
        throw new Error(confirmed?.error ?? 'This transfer could not be confirmed yet. Keep tracking it — do not start another.');
      }
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!mounted.current) return false;
      const done = await postJson(`/api/checkout/${encodeURIComponent(reference)}/bridge/complete`, { intent });
      if (done?.success && done?.state === 'completed') {
        clearResume(reference);
        setResume(null);
        setTopUp(null);
        onSettled?.();
        return true;
      }
      if (done?.code === 'UNDERPAID' && typeof done.remainingAmountDisplay === 'string') {
        saveResume(reference, intent, burnTxHash);
        setResume({ intent, burnTxHash });
        setTopUp({ after: intent, remaining: done.remainingAmountDisplay });
        setLiveAmount(null);
        return false;
      }
      if (done?.code !== 'MINT_NOT_READY') {
        throw new Error(done?.error ?? 'This transfer needs attention. Keep this reference — do not start another.');
      }
      setStep('Moving your USDC to Arc…');
      await new Promise((r) => setTimeout(r, 10_000));
    }
    saveResume(reference, intent, burnTxHash);
    setResume({ intent, burnTxHash });
    throw new Error('Circle is still relaying your USDC to Arc. Keep tracking this payment — do not start another transfer.');
  }, [postJson, reference, onSettled]);

  const pay = useCallback(async () => {
    if (busy) return;
    if (!source || !merchantSCA) {
      setError('This invoice has no merchant wallet to receive a cross-chain payment.');
      return;
    }
    if (!isConnected || !address) {
      setError('Connect the wallet you will pay from.');
      return;
    }
    setBusy(true);
    setError(null);
    setLiveAmount(null);
    setStep('Preparing your payment…');
    let intent: string | null = null;
    let burnTxHash: string | null = null;
    try {
      // Finish wallet setup before reserving a new payment leg. Cancelling a
      // network switch should never leave the invoice with a pending intent.
      setStep(`Switch to ${source.label}…`);
      await ensureOnSource(source);
      const [{ BridgeKit }, { createViemAdapterFromProvider }] = await Promise.all([
        import('@circle-fin/bridge-kit'),
        import('@circle-fin/adapter-viem-v2'),
      ]);
      const provider = await getProvider();
      if (!provider?.request) throw new Error('This wallet cannot sign the transfer. Try a different wallet.');
      const [connectedAccount] = await provider.request({ method: 'eth_accounts' });
      if (connectedAccount?.toLowerCase() !== address.toLowerCase()) throw new Error('Reconnect the original wallet account.');
      if (!navigator.locks) throw new Error('Use a browser that supports cross-tab payment locking.');
      await navigator.locks.request(RESUME_KEY(reference), { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('This checkout is active in another tab.');
      assertResumeStorage(reference);
      const saved = loadResume(reference);
      setStep('Getting a live bridge quote…');
      const created = await postJson(`/api/checkout/${encodeURIComponent(reference)}/bridge/intent`, {
        payerAddress: address,
        sourceChain: source.id,
        ...(topUp ? { topUpAfter: topUp.after } : {}),
      });
      if (!created?.success) throw new Error(created?.error ?? 'Could not start the cross-chain payment.');
      if (typeof created.reference !== 'string') throw new Error('Could not read the payment reference.');
      const activeIntent: string = created.reference;
      intent = activeIntent;
      if (created.state === 'COMPLETED') {
        await complete(activeIntent, null);
        return;
      }
      if (created.state === 'BURN_CONFIRMED') {
        burnTxHash = created.burnTxHash ?? null;
        saveResume(reference, activeIntent, burnTxHash);
        onPending?.();
        await complete(activeIntent, burnTxHash);
        return;
      }
      const matchingResume = saved?.intent === activeIntent ? saved : null;
      if (created.reused && !matchingResume?.ready) {
        burnTxHash = matchingResume?.burnTxHash ?? created.burnTxHash ?? null;
        saveResume(reference, activeIntent, burnTxHash);
        setResume({ intent: activeIntent, burnTxHash });
        setTopUp(null);
        if (burnTxHash) await complete(activeIntent, burnTxHash);
        else throw new Error('This transfer was already prepared. Check your wallet activity and recover it with the burn transaction hash.');
        return;
      }

      const record = (state: 'ready' | 'uncertain' | 'submitted', hash: string | null) => {
        burnTxHash = hash;
        saveResume(reference, activeIntent, hash, state === 'ready', state === 'uncertain');
        setResume({ intent: activeIntent, burnTxHash: hash, ready: state === 'ready' });
      };
      record('ready', null);
      if (created.canStart !== true || !Number.isFinite(Date.parse(created.expiresAt)) || Date.parse(created.expiresAt) <= Date.now()) {
        throw new Error('The prepared quote has expired. Contact support with your invoice reference.');
      }
      const request = trackCheckoutWallet(provider.request.bind(provider), source.usdcAddress, record);
      const adapter = await createViemAdapterFromProvider({ provider: {
        request: request as Parameters<typeof createViemAdapterFromProvider>[0]['provider']['request'],
        on: provider.on?.bind(provider) ?? (() => {}),
        removeListener: provider.removeListener?.bind(provider) ?? (() => {}),
      } });
      const kit = new BridgeKit();

      onPending?.();
      setLiveAmount(created.amountDisplay);
      setStep(`Confirm ${created.amountDisplay} USDC in your wallet…`);
      setTopUp(null);
      const result = await kit.bridge({
        from: { adapter, chain: source.id as Parameters<typeof kit.bridge>[0]['from']['chain'] },
        to: {
          chain: bridgeNetwork === 'mainnet' ? 'Arc' : 'Arc_Testnet',
          recipientAddress: created.destination as `0x${string}`,
          useForwarder: true,
        },
        amount: created.amountDisplay,
      });

      burnTxHash = burnHashFromResult(result) ?? burnTxHash;
      if (!burnTxHash) {
        throw new Error('The wallet did not return a transfer transaction. Check your wallet activity before trying again.');
      }
      saveResume(reference, activeIntent, burnTxHash);
      setStep('Verifying the transfer…');
      await complete(activeIntent, burnTxHash);
      });
    } catch (e: any) {
      const msg = friendlyBridgeError(e) || e?.message || 'The cross-chain payment could not be completed.';
      setError(msg);
      if (intent && burnTxHash) setResume({ intent, burnTxHash });
    } finally {
      if (mounted.current) {
        setBusy(false);
        setStep(null);
      }
    }
  }, [busy, source, merchantSCA, isConnected, address, postJson, reference, onPending, complete, ensureOnSource, getProvider, bridgeNetwork, topUp]);

  const resumePayment = useCallback(async () => {
    if (!resume || busy) return;
    setBusy(true);
    setError(null);
    setStep('Checking your transfer…');
    try {
      const hash = recoveryHash.trim() || resume.burnTxHash;
      await complete(resume.intent, hash);
    } catch (e: any) {
      setError(friendlyBridgeError(e) || e?.message || 'This transfer still needs attention.');
    } finally {
      if (mounted.current) {
        setBusy(false);
        setStep(null);
      }
    }
  }, [resume, busy, complete, recoveryHash]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ fontSize: 11, color: '#6b5a45', margin: 0 }}>
        Pay the merchant directly from another network. The live Bridge Kit quote includes the bridge fee and a margin. FlareHQ never holds your funds.
      </p>
      {liveAmount && <p style={{ fontSize: 11, color: '#a89684', margin: 0 }}>Quoted transfer {liveAmount} USDC. Source network gas is separate.</p>}
      {topUp && <p style={{ fontSize: 11, color: '#a89684', margin: 0 }}>The merchant received a partial payment. {topUp.remaining} USDC remains unpaid. Use the original wallet and source network to top up.</p>}

      <div>
        <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 6px' }}>Source Network</p>
        <select
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          disabled={busy || disabled}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #3d2e1a', background: '#251c12', color: '#f0ece6', fontSize: 13 }}
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>

      {!merchantSCA && (
        <p style={{ color: '#f87171', fontSize: 11, margin: 0 }}>This invoice has no merchant wallet configured for settlement.</p>
      )}

      {resume && !resume.ready && !topUp && !resume.burnTxHash && (
        <label style={{ fontSize: 11, color: '#a89684' }}>
          Source burn transaction hash (if available)
          <input value={recoveryHash} onChange={(e) => setRecoveryHash(e.target.value)} disabled={busy || disabled} />
        </label>
      )}

      {resume && !resume.ready && !topUp ? (
        <button
          onClick={resumePayment}
          disabled={busy || disabled}
          style={{ width: '100%', padding: 16, borderRadius: 14, border: 'none', fontSize: 14, fontWeight: 800, cursor: busy ? 'not-allowed' : 'pointer', background: busy ? '#6b5a45' : '#c8975a', color: '#0e0b08' }}
        >
          {busy ? 'Checking…' : 'Resume this payment'}
        </button>
      ) : (
        <button
          onClick={pay}
          disabled={busy || disabled || !isConnected || !merchantSCA}
          style={{ width: '100%', padding: 16, borderRadius: 14, border: 'none', fontSize: 14, fontWeight: 800, cursor: busy || disabled || !isConnected || !merchantSCA ? 'not-allowed' : 'pointer', background: busy ? '#6b5a45' : disabled ? '#3d2e1a' : '#c8975a', color: '#0e0b08' }}
        >
          {busy ? (step ?? 'Working…') : !isConnected ? 'Connect a wallet above' : topUp ? `Top up ${topUp.remaining} USDC` : `Pay ${invoiceAmount.toFixed(2)} USDC cross-chain`}
        </button>
      )}

      {busy && step && <p style={{ fontSize: 11, color: '#a89684', margin: 0 }}>{step}</p>}
      {error && <p style={{ color: '#f87171', fontSize: 11, margin: 0 }}>{error}</p>}
      {resume && !resume.ready && !topUp && !busy && (
        <p style={{ fontSize: 10, color: '#6b5a45', margin: 0 }}>
          A transfer for this invoice is already in progress. Resume it; do not start another burn.
        </p>
      )}
    </div>
  );
}
