// src/components/checkout/CheckoutCrossChain.tsx
//
// Cross-chain checkout: the payer's own wallet signs the source-chain burn via
// Circle Bridge Kit (forwarder on, destination Arc, mint recipient = the
// invoice's merchant wallet). The server creates one durable intent bound to
// this invoice, verifies the burn and the Arc mint from receipts, and marks the
// invoice paid only after the merchant credit is proven.
//
// Non-custodial: the browser signs; this component never receives keys and the
// server never signs or broadcasts. One burn settles one invoice, and recovery
// resumes the same intent — it never asks for a second burn.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import {
  getBridgeSourceChains,
  formatBridgeBaseUnits,
  type BridgeSourceChain,
} from '@/lib/bridge/sourceChains';
import { sourceViemChainFor } from '@/lib/bridge/sourceViemChains';
import { ensureEvmNetwork } from '@/lib/wallet/ensureEvmNetwork';
import { friendlyBridgeError } from '@/lib/wallet/walletErrors';
import { extractBurnTxHash } from '@/lib/bridge/resumeStore';
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

function loadResume(reference: string): { intent: string; burnTxHash: string | null } | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY(reference));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.intent === 'string' ? { intent: parsed.intent, burnTxHash: parsed.burnTxHash ?? null } : null;
  } catch {
    return null;
  }
}

function saveResume(reference: string, intent: string, burnTxHash: string | null): void {
  try {
    localStorage.setItem(RESUME_KEY(reference), JSON.stringify({ intent, burnTxHash }));
  } catch {
    // Storage can be unavailable (private mode); the intent still exists
    // server-side and support can recover it.
  }
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
  const [resume, setResume] = useState<{ intent: string; burnTxHash: string | null } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setResume(loadResume(reference));
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
        throw new Error(confirmed?.error ?? 'This transfer could not be confirmed yet. Keep tracking it — do not start another.');
      }
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!mounted.current) return false;
      const done = await postJson(`/api/checkout/${encodeURIComponent(reference)}/bridge/complete`, { intent });
      if (done?.success && done?.state === 'completed') {
        clearResume(reference);
        setResume(null);
        onSettled?.();
        return true;
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
    setStep('Preparing your payment…');
    let intent: string | null = null;
    let burnTxHash: string | null = null;
    try {
      const created = await postJson(`/api/checkout/${encodeURIComponent(reference)}/bridge/intent`, {
        payerAddress: address,
        sourceChain: source.id,
      });
      if (!created?.success) throw new Error(created?.error ?? 'Could not start the cross-chain payment.');
      intent = created.reference;
      saveResume(reference, intent!, created.burnTxHash ?? null);
      if (created.state === 'completed') {
        clearResume(reference);
        onSettled?.();
        return;
      }
      if (created.state === 'BURN_CONFIRMED') {
        burnTxHash = created.burnTxHash ?? null;
        onPending?.();
        await complete(intent!, burnTxHash);
        return;
      }

      onPending?.();
      setStep(`Switch to ${source.label}…`);
      await ensureOnSource(source);

      setStep('Confirm the transfer in your wallet…');
      const [{ BridgeKit }, { createViemAdapterFromProvider }] = await Promise.all([
        import('@circle-fin/bridge-kit'),
        import('@circle-fin/adapter-viem-v2'),
      ]);
      const provider = await getProvider();
      if (!provider?.request) throw new Error('This wallet cannot sign the transfer. Try a different wallet.');
      const adapter = await createViemAdapterFromProvider({ provider });
      const kit: any = new (BridgeKit as any)();
      const result = await kit.bridge({
        from: { adapter, chain: source.id },
        to: {
          chain: bridgeNetwork === 'mainnet' ? 'Arc' : 'Arc_Testnet',
          recipientAddress: merchantSCA as `0x${string}`,
          useForwarder: true,
        },
        amount: created.amountDisplay,
      });

      burnTxHash = burnHashFromResult(result);
      if (!burnTxHash) {
        saveResume(reference, intent!, null);
        setResume({ intent: intent!, burnTxHash: null });
        throw new Error('The wallet did not return a transfer transaction. Check your wallet activity before trying again.');
      }
      saveResume(reference, intent!, burnTxHash);
      setStep('Verifying the transfer…');
      await complete(intent!, burnTxHash);
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
  }, [source, merchantSCA, isConnected, address, postJson, reference, onPending, onSettled, complete, ensureOnSource, getProvider, bridgeNetwork]);

  const resumePayment = useCallback(async () => {
    if (!resume || busy) return;
    setBusy(true);
    setError(null);
    setStep('Checking your transfer…');
    try {
      await complete(resume.intent, resume.burnTxHash);
    } catch (e: any) {
      setError(friendlyBridgeError(e) || e?.message || 'This transfer still needs attention.');
    } finally {
      if (mounted.current) {
        setBusy(false);
        setStep(null);
      }
    }
  }, [resume, busy, complete]);

  const grossDisplay = useMemo(() => {
    // Server is authoritative for the exact gross; this is display-only.
    const buffer = Math.ceil(invoiceAmount * 1_000_000 * 0.01);
    return formatBridgeBaseUnits(BigInt(Math.round(invoiceAmount * 1_000_000) + buffer));
  }, [invoiceAmount]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ fontSize: 11, color: '#6b5a45', margin: 0 }}>
        Pay from another network with your own wallet. You send about {grossDisplay} USDC; the merchant receives at least {invoiceAmount.toFixed(2)} USDC on Arc. FlareHQ never holds your funds.
      </p>

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

      {resume ? (
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
          {busy ? (step ?? 'Working…') : isConnected ? `Pay ${invoiceAmount.toFixed(2)} USDC cross-chain` : 'Connect a wallet above'}
        </button>
      )}

      {busy && step && <p style={{ fontSize: 11, color: '#a89684', margin: 0 }}>{step}</p>}
      {error && <p style={{ color: '#f87171', fontSize: 11, margin: 0 }}>{error}</p>}
      {resume && !busy && (
        <p style={{ fontSize: 10, color: '#6b5a45', margin: 0 }}>
          A transfer for this invoice is already in progress. Resume it; do not start another burn.
        </p>
      )}
    </div>
  );
}
