'use client';

// src/app/escrow-confirm/[reference]/page.tsx
//
// Public page where an EXTERNAL EOA beneficiary (no FlareHQ account) confirms
// delivery on an ACTIVE escrow directly from their own wallet — the
// beneficiary-side mirror of /escrow-pay/[reference]. Same trust model:
//
//   Step 1: connect wallet + switch to Arc
//   Step 2: writeContract → confirmDelivery(contractEscrowId)
//   Step 3: recorded via the public POST /api/escrow/[reference]/beneficiary-confirm
//           (server re-verifies the tx sender/selector/escrowId + re-reads the
//           authoritative on-chain state before mirroring it)
//
// Guards: page only active for ACTIVE escrows, and the connected wallet MUST
// equal the escrow's beneficiarySCA — a non-beneficiary can't confirm.
// Shows live on-chain confirm flags ("depositor already confirmed — your
// confirmation completes the release").

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAccount, useDisconnect, usePublicClient, useWriteContract, useChainId, useSwitchChain } from 'wagmi';
import { isAddress, parseAbi, type Hash } from 'viem';
import { useNetwork, useExplorer, useActiveArcChain } from '@/src/components/NetworkContext';
import { ensureArcNetwork } from '@/lib/wallet/ensureArcNetwork';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';
import { friendlyConnectorLabel, hasInjectedProvider, isMobileViewport } from '@/lib/wallet/walletLabels';
import { useGuardedConnect } from '@/hooks/useGuardedConnect';

const confirmDeliveryAbi = [
  {
    name: 'confirmDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

// Read-only preflight against the deployed FlareHQEscrow interface. A stale
// database flag must never make a beneficiary pay to confirm a second time.
const escrowStateAbi = parseAbi([
  'function getEscrow(bytes32) view returns ((address depositor,address beneficiary,uint256 amount,uint256 deadline,string ref,bool depositorConfirmed,bool beneficiaryConfirmed))',
  'function settled(bytes32) view returns (bool)',
  'function disputed(bytes32) view returns (bool)',
]);

interface EscrowConfirmDetails {
  reference: string;
  amount: number;
  currency: string;
  beneficiarySCA: string;
  depositorSCA: string | null;
  condition: string | null;
  deadline: string;
  status: string;
  contractAddress: string;
  contractEscrowId: string | null;
  beneficiaryConfirmed: boolean;
  depositorConfirmed: boolean;
  confirmUrl: string;
  funded: boolean;
  expired: boolean;
}

type Step = 'connect' | 'confirm' | 'recording' | 'done' | 'error';
class ConfirmationError extends Error {}

export default function EscrowConfirmPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference || '';
  return <EscrowConfirmation key={reference} reference={reference} />;
}

function EscrowConfirmation({ reference }: { reference: string }) {
  const [details, setDetails] = useState<EscrowConfirmDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('connect');
  const [statusText, setStatusText] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [explorerUrl, setExplorerUrl] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [recoveryHash, setRecoveryHash] = useState('');
  const running = useRef(false);
  const submitted = useRef<{ reference: string; hash: Hash } | null>(null);

  const { address, isConnected, connector } = useAccount();
  // Guarded connect: synchronous ref lock suppresses double-fire re-entry.
  const { connectWithFallback: guardedConnect, isConnecting, dedupedConnectors } = useGuardedConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync } = useWriteContract();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  // Server-resolved display label (production-safe "Arc" default until
  // /api/network resolves) + server-driven wallet target (production-safe
  // mainnet default — never a build-time chain object).
  const { label: arcName } = useNetwork();
  const { chainId: activeChainId, chain: activeChain } = useActiveArcChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { txUrl: explorerTx } = useExplorer();
  const storageKey = details ? `escrow-confirm:${activeChainId}:${reference}:${details.contractAddress.toLowerCase()}:${details.contractEscrowId}` : null;

  useEffect(() => {
    if (!reference) return;
    let cancelled = false;
    fetch(`/api/escrow/link/${reference}`, { cache: 'no-store', signal: AbortSignal.timeout(25_000) })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) setDetails(data.escrow);
        else setLoadError(data.error || 'Escrow not found.');
      })
      .catch(() => { if (!cancelled) setLoadError('Could not load this escrow. Please refresh.'); });
    return () => { cancelled = true; };
  }, [reference]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      const hash = sessionStorage.getItem(storageKey);
      if (hash && /^0x[a-fA-F0-9]{64}$/.test(hash)) {
        submitted.current = { reference, hash: hash as Hash };
        setTxHash(hash);
      }
    } catch { /* Receipt recovery remains available when browser storage is blocked. */ }
  }, [storageKey, reference]);

  const rememberConfirmation = useCallback((hash: Hash) => {
    submitted.current = { reference, hash };
    setTxHash(hash);
    setExplorerUrl(explorerTx(hash));
    try { if (storageKey) sessionStorage.setItem(storageKey, hash); } catch { /* Keep the in-memory hash. */ }
  }, [reference, storageKey, explorerTx]);

  const isBeneficiary = !!details && !!address && details.beneficiarySCA.toLowerCase() === address.toLowerCase();

  const confirmDelivery = useCallback(async (existingHash?: string) => {
    if (running.current || !details || !details.contractEscrowId) return;
    let hash = (existingHash !== undefined ? existingHash.trim() : submitted.current?.reference === reference ? submitted.current.hash : undefined) as Hash | undefined;
    if ((existingHash !== undefined && !hash) || (hash && !/^0x[a-fA-F0-9]{64}$/.test(hash))) {
      setStep('error');
      setStatusText('Enter the complete confirmation transaction hash.');
      return;
    }
    // Recording an existing receipt is public and never asks a wallet to sign.
    // The server independently proves its sender, contract, selector and id.
    if (!hash && (!address || !isBeneficiary)) {
      setStep('error');
      setStatusText('This wallet is not the beneficiary of this escrow.');
      return;
    }
    running.current = true;
    try {
      if (!publicClient) throw new ConfirmationError('The escrow network is not ready. Please refresh.');
      setStep(hash ? 'recording' : 'confirm');
      setStatusText('Checking the escrow network…');
      const firstChain = await publicClient.getChainId();
      const secondChain = await publicClient.getChainId();
      if (firstChain !== activeChainId || secondChain !== activeChainId) throw new ConfirmationError('The escrow RPC network does not match the app. No transaction was sent.');
      if (!hash) {
        if (details.reference !== reference || details.status !== 'ACTIVE' || !details.funded) throw new ConfirmationError('This escrow is not active and funded. Do not submit a confirmation.');
        if (!isAddress(details.contractAddress) || !/^0x[a-fA-F0-9]{64}$/.test(details.contractEscrowId)) throw new ConfirmationError('The escrow contract details are invalid. Please refresh.');
        setStatusText('Checking the on-chain escrow before requesting approval…');
        const block = await publicClient.getBlock({ blockTag: 'latest' });
        const read = { address: details.contractAddress as `0x${string}`, abi: escrowStateAbi, args: [details.contractEscrowId as Hash], blockNumber: block.number } as const;
        const [state, settled, disputed] = await Promise.all([
          publicClient.readContract({ ...read, functionName: 'getEscrow' }),
          publicClient.readContract({ ...read, functionName: 'settled' }),
          publicClient.readContract({ ...read, functionName: 'disputed' }),
        ]);
        if (state.beneficiary.toLowerCase() !== details.beneficiarySCA.toLowerCase()) throw new ConfirmationError('On-chain beneficiary does not match this escrow. Do not submit a transaction.');
        if (state.beneficiaryConfirmed) {
          const released = settled && state.depositorConfirmed;
          setDetails((prev) => prev ? { ...prev, beneficiaryConfirmed: true, depositorConfirmed: state.depositorConfirmed, status: released ? 'RELEASED' : prev.status } : prev);
          setStatusText(`Your beneficiary confirmation is already on-chain. No new transaction was sent.${settled ? ' This escrow is already settled.' : disputed ? ' This escrow is now disputed.' : block.timestamp >= state.deadline ? ' The deadline has passed; do not confirm again.' : ' Waiting for the depositor to confirm.'}`);
          setStep('done');
          return;
        }
        if (settled) throw new ConfirmationError('This escrow is already settled. Refresh its status; do not confirm again.');
        if (disputed) throw new ConfirmationError('This escrow is disputed and cannot be confirmed.');
        if (block.timestamp >= state.deadline) throw new ConfirmationError('This escrow has expired. The depositor can reclaim it.');
        const net = await ensureArcNetwork({ chainId, switchChainAsync, chain: activeChain, getProvider: async () => connector?.getProvider() });
        if (!net.ok) throw new ConfirmationError(net.message);
        setStatusText('Confirm delivery in your wallet…');
        hash = await writeContractAsync({
          address: details.contractAddress as `0x${string}`,
          abi: confirmDeliveryAbi,
          functionName: 'confirmDelivery',
          args: [details.contractEscrowId as Hash],
          account: address as `0x${string}`,
          connector,
          chainId: activeChainId,
        });
      }
      // Keep the hash before any receipt/API await. Retrying verification must
      // never submit confirmDelivery again, even after a timeout or lost reply.
      rememberConfirmation(hash);

      setStep('recording');
      setStatusText('Waiting for the submitted confirmation receipt…');
      let replaced = false;
      const receipt = await publicClient.waitForTransactionReceipt({
        hash, timeout: 90_000,
        onReplaced: ({ reason }) => { if (reason !== 'repriced') replaced = true; },
      });
      if (replaced) throw new ConfirmationError('The submitted confirmation was cancelled or replaced. Inspect the saved transaction; no new confirmation was sent.');
      if (receipt.status !== 'success') throw new ConfirmationError('The saved transaction reverted. Inspect it before attempting any new confirmation.');
      hash = receipt.transactionHash;
      rememberConfirmation(hash);
      setStatusText('Verifying your confirmation on-chain…');
      const res = await fetch(`/api/escrow/${reference}/beneficiary-confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSCA: details.beneficiarySCA, txHash: hash }),
        signal: AbortSignal.timeout(25_000),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new ConfirmationError('The submitted transaction could not be recorded yet. Check its receipt and retry verification, not confirmation.');
      setExplorerUrl(data.explorerUrl || `${explorerTx(hash)}`);
      setStep('done');
      setStatusText(data.released ? 'Both parties confirmed — escrow released.' : 'Delivery confirmed on-chain. Waiting for the depositor to confirm.');
      setDetails((prev) => prev ? { ...prev, beneficiaryConfirmed: true, depositorConfirmed: Boolean(data.depositorConfirmed), status: data.released ? 'RELEASED' : prev.status } : prev);
    } catch (err: any) {
      setStep('error');
      const saved = submitted.current?.reference === reference;
      const message = err instanceof ConfirmationError ? err.message : saved ? 'The receipt or recording check did not complete.' : friendlyWalletError(err);
      setStatusText(`${message}${saved ? ' Your transaction hash is saved. Verify it again below without signing or paying again.' : ''}`);
    } finally { running.current = false; }
  }, [details, address, isBeneficiary, chainId, activeChainId, activeChain, connector, publicClient, reference, writeContractAsync, switchChainAsync, explorerTx, rememberConfirmation]);

  const retryConfirmation = useCallback(() => {
    if (submitted.current?.reference === reference) void confirmDelivery();
    else { setStep('connect'); setStatusText(''); }
  }, [reference, confirmDelivery]);

  const page: React.CSSProperties = {
    minHeight: '100vh', background: '#FBF8F3', color: '#1C1B19',
    fontFamily: "'Inter', system-ui, sans-serif", display: 'flex',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  };
  const card: React.CSSProperties = {
    background: '#FFFFFF', border: '1px solid #E5DDC9', borderRadius: 20,
    padding: 28, maxWidth: 460, width: '100%',
  };

  if (loadError) {
    return <main style={page}><div style={card}><p style={{ fontWeight: 700 }}>Escrow unavailable</p><p style={{ fontSize: 13, color: '#8A8275' }}>{loadError}</p></div></main>;
  }
  if (!details) {
    return <main style={page}><div style={card}><p style={{ fontSize: 13, color: '#8A8275' }}>Loading escrow…</p></div></main>;
  }
  if (details.status !== 'ACTIVE') {
    const done = details.status === 'RELEASED';
    return (
      <main style={page}>
        <div style={card}>
          <p style={{ fontWeight: 700 }}>{done ? '✅ Escrow released' : `Escrow is ${details.status}`}</p>
          <p style={{ fontSize: 13, color: '#8A8275' }}>
            {done
              ? 'Both parties confirmed — the funds have been sent to the beneficiary.'
              : 'This escrow is no longer active, so delivery can\'t be confirmed.'}
          </p>
          <p style={{ fontSize: 12, color: '#8A8275', marginTop: 8 }}>Reference {details.reference}</p>
        </div>
      </main>
    );
  }
  if (details.expired) {
    return <main style={page}><div style={card}><p style={{ fontWeight: 700 }}>This escrow has expired</p><p style={{ fontSize: 13, color: '#8A8275' }}>It passed its deadline on {new Date(details.deadline).toLocaleString()}. The depositor can reclaim the funds.</p></div></main>;
  }

  return (
    <main style={page}>
      <div style={card}>
        <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, fontFamily: 'monospace', color: '#8A8275', margin: '0 0 8px' }}>Escrow confirmation</p>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, margin: '0 0 16px' }}>
          Confirm delivery of {details.amount} {details.currency}
        </h1>
        <div style={{ fontSize: 13, lineHeight: 1.7, color: '#1C1B19', marginBottom: 16 }}>
          <p style={{ margin: 0 }}><strong>Depositor:</strong> {details.depositorSCA ? `${details.depositorSCA.slice(0, 10)}…${details.depositorSCA.slice(-6)}` : '—'}</p>
          <p style={{ margin: 0 }}><strong>Beneficiary (you):</strong> {details.beneficiarySCA.slice(0, 10)}…{details.beneficiarySCA.slice(-6)}</p>
          {details.condition && <p style={{ margin: 0 }}><strong>Release condition:</strong> {details.condition}</p>}
          <p style={{ margin: 0 }}><strong>Deadline:</strong> {new Date(details.deadline).toLocaleString()}</p>
          <p style={{ margin: '8px 0 0', padding: '8px 10px', background: details.depositorConfirmed ? 'rgba(63,122,87,0.08)' : 'rgba(245,158,11,0.08)', borderRadius: 8, color: details.depositorConfirmed ? '#3F7A57' : '#b45309', fontSize: 12 }}>
            {details.depositorConfirmed
              ? '✓ The depositor has already confirmed — your confirmation completes the release.'
              : '⏳ Waiting on the depositor too — the escrow auto-releases once both parties confirm.'}
          </p>
        </div>

        {step === 'done' ? (
          <div>
            <p style={{ color: '#3F7A57', fontWeight: 700, fontSize: 14, margin: '0 0 8px' }}>✅ Delivery confirmed</p>
            <p role="status" style={{ fontSize: 12, color: '#8A8275', margin: '0 0 8px' }}>{statusText}</p>
          </div>
        ) : step === 'error' ? (
          <div>
            <p style={{ color: '#C0563A', fontWeight: 700, fontSize: 14, margin: '0 0 8px' }}>Something went wrong</p>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 12px' }}>{statusText}</p>
            <button onClick={retryConfirmation} style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#5C7A5C', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
              {txHash ? 'Verify submitted confirmation' : 'Try again'}
            </button>
          </div>
        ) : step === 'confirm' || step === 'recording' ? (
          <div role="status" aria-live="polite">
            <p style={{ fontSize: 13, fontWeight: 600 }}>{statusText}</p>
            <p style={{ fontSize: 12, color: '#8A8275' }}>Do not submit another confirmation while this check is running.</p>
          </div>
        ) : !isConnected ? (
          <div>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 10px' }}>
              Connect the beneficiary wallet to confirm delivery. You keep custody the whole time — FlareHQ never holds your keys.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(() => {
                const isMobile = isMobileViewport();
                const hasProvider = hasInjectedProvider();
                const showInjected = !(isMobile && !hasProvider);
                const injected = dedupedConnectors.filter((c) => c.type === 'injected');
                const wc = dedupedConnectors.find((c) => c.type === 'walletConnect');
                const others = dedupedConnectors.filter((c) => c.type !== 'injected' && c.type !== 'walletConnect');
                // Guarded by useGuardedConnect's synchronous ref lock: a
                // second tap before re-render no-ops instead of opening a
                // second WalletConnect session.
                const doConnect = async (c: { uid: string }) => {
                  setConnectError(null);
                  try { await guardedConnect(c); }
                  catch (e: any) { setConnectError(friendlyWalletError(e)); }
                };
                return (
                  <>
                    {showInjected && injected.map((c) => (
                      <button key={c.uid} onClick={() => doConnect(c)} disabled={isConnecting}
                        style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid #E5DDC9', background: '#fff', fontWeight: 600, cursor: 'pointer', textAlign: 'left' }}>
                        {friendlyConnectorLabel(c)}
                      </button>
                    ))}
                    {wc && (
                      <button key={wc.uid} onClick={() => doConnect(wc)} disabled={isConnecting}
                        style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid #E5DDC9', background: '#fff', fontWeight: 600, cursor: 'pointer', textAlign: 'left' }}>
                        WalletConnect
                      </button>
                    )}
                    {others.map((c) => (
                      <button key={c.uid} onClick={() => doConnect(c)} disabled={isConnecting}
                        style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid #E5DDC9', background: '#fff', fontWeight: 600, cursor: 'pointer', textAlign: 'left' }}>
                        {friendlyConnectorLabel(c)}
                      </button>
                    ))}
                    {isMobile && !hasProvider && (
                      <p style={{ fontSize: 11, color: '#8A8275', margin: '4px 0 0' }}>
                        On mobile, open this page in your wallet app, or use WalletConnect.
                      </p>
                    )}
                  </>
                );
              })()}
            </div>
            {connectError && <p style={{ fontSize: 12, color: '#C0563A', margin: '8px 0 0' }}>⚠️ {connectError}</p>}
          </div>
        ) : !isBeneficiary ? (
          <div>
            <p style={{ fontSize: 12, color: '#C0563A', margin: '0 0 10px' }}>
              <strong>Wrong wallet.</strong> Connected {address?.slice(0, 6)}...{address?.slice(-4)} is not the beneficiary of this escrow
              ({details.beneficiarySCA.slice(0, 6)}...{details.beneficiarySCA.slice(-4)}).
            </p>
            <button onClick={() => disconnect()} style={{ width: '100%', padding: '12px 18px', borderRadius: 10, border: '1px solid #C0563A', background: '#fff', color: '#C0563A', fontWeight: 700, cursor: 'pointer' }}>
              Disconnect and switch wallet
            </button>
          </div>
        ) : chainId !== activeChainId ? (
          <div>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 10px' }}>
              Confirming from <strong>{address ? `${address.slice(0, 10)}…${address.slice(-6)}` : 'wallet'}</strong> · <button onClick={() => disconnect()} style={{ border: 'none', background: 'none', color: '#E8714A', cursor: 'pointer', padding: 0, fontSize: 12 }}>disconnect</button>
            </p>
            <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, padding: 10, marginBottom: 10, textAlign: 'center' }}>
              <p style={{ color: '#b45309', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Wrong network</p>
              <p style={{ color: '#8A8275', fontSize: 11, margin: 0 }}>This escrow uses {arcName}. Switch your wallet to Arc to continue.</p>
            </div>
            <button
              onClick={async () => {
                const net = await ensureArcNetwork({ chainId, switchChainAsync, chain: activeChain, getProvider: async () => connector?.getProvider() });
                if (!net.ok) { setStep('error'); setStatusText(net.message); }
              }}
              style={{ width: '100%', padding: '12px 18px', borderRadius: 10, border: '1px solid #5C7A5C', background: '#fff', color: '#5C7A5C', fontWeight: 700, cursor: 'pointer' }}>
              Switch to {arcName}
            </button>
            <p style={{ fontSize: 10, color: '#8A8275', margin: '6px 0 0', textAlign: 'center' }}>Confirmation is blocked until {arcName} is selected.</p>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 10px' }}>
              Confirming from <strong>{address ? `${address.slice(0, 10)}…${address.slice(-6)}` : 'wallet'}</strong> · {arcName} ✓ · <button onClick={() => disconnect()} style={{ border: 'none', background: 'none', color: '#E8714A', cursor: 'pointer', padding: 0, fontSize: 12 }}>disconnect</button>
            </p>
            <button onClick={() => confirmDelivery()} disabled={step !== 'connect'}
              style={{ width: '100%', padding: '12px 18px', borderRadius: 10, border: 'none', background: '#5C7A5C', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
              {txHash ? 'Verify submitted confirmation' : '✓ Confirm delivery'}
            </button>
          </div>
        )}
        {txHash && <p style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
          Saved transaction: <a href={explorerUrl || explorerTx(txHash)} target="_blank" rel="noopener noreferrer" style={{ color: '#E8714A' }}>{txHash}</a>
        </p>}
        {step !== 'confirm' && step !== 'recording' && <details style={{ marginTop: 16, fontSize: 12, color: '#8A8275' }}>
          <summary style={{ cursor: 'pointer' }}>Already submitted a confirmation?</summary>
          <p>Paste its transaction hash to verify it. This does not send another blockchain transaction or spend gas.</p>
          <label htmlFor="confirmation-hash">Confirmation transaction hash</label>
          <input id="confirmation-hash" value={recoveryHash} onChange={(event) => setRecoveryHash(event.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false}
            style={{ width: '100%', boxSizing: 'border-box', padding: 10, margin: '6px 0', border: '1px solid #E5DDC9', borderRadius: 8, background: '#FFFFFF', color: '#1C1B19' }} />
          <button disabled={!/^0x[a-fA-F0-9]{64}$/.test(recoveryHash)} onClick={() => confirmDelivery(recoveryHash)}
            style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #5C7A5C', background: '#fff', color: '#5C7A5C', fontWeight: 600, cursor: 'pointer' }}>Verify existing confirmation</button>
        </details>}
      </div>
    </main>
  );
}
