'use client';

// src/app/escrow-confirm/[reference]/page.tsx
//
// Public page where an EXTERNAL EOA beneficiary (no FlareHQ account) confirms
// delivery on an ACTIVE escrow directly from their own wallet — the
// beneficiary-side mirror of /escrow-pay/[reference]. Same trust model:
//
//   Step 1: connect wallet + switch to Arc Testnet
//   Step 2: writeContract → confirmDelivery(contractEscrowId)
//   Step 3: recorded via the public POST /api/escrow/[reference]/beneficiary-confirm
//           (server re-verifies the tx sender/selector/escrowId + re-reads the
//           authoritative on-chain state before mirroring it)
//
// Guards: page only active for ACTIVE escrows, and the connected wallet MUST
// equal the escrow's beneficiarySCA — a non-beneficiary can't confirm.
// Shows live on-chain confirm flags ("depositor already confirmed — your
// confirmation completes the release").

import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAccount, useConnect, useDisconnect, useWriteContract, useChainId, useSwitchChain } from 'wagmi';
import { arcTestnet } from '@/lib/wagmi';
import { ensureArcNetwork } from '@/lib/wallet/ensureArcNetwork';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';
import { dedupeConnectors, friendlyConnectorLabel, hasInjectedProvider, isMobileViewport } from '@/lib/wallet/walletLabels';

const confirmDeliveryAbi = [
  {
    name: 'confirmDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

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

export default function EscrowConfirmPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference || '';

  const [details, setDetails] = useState<EscrowConfirmDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('connect');
  const [statusText, setStatusText] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [explorerUrl, setExplorerUrl] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const { address, isConnected, connector: activeConnector } = useAccount();
  const { connectors, connect, connectAsync, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync } = useWriteContract();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  useEffect(() => {
    if (!reference) return;
    fetch(`/api/escrow/link/${reference}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setDetails(data.escrow);
        else setLoadError(data.error || 'Escrow not found.');
      })
      .catch(() => setLoadError('Could not load this escrow.'));
  }, [reference]);

  const isBeneficiary = !!details && !!address && details.beneficiarySCA.toLowerCase() === address.toLowerCase();

  const confirmDelivery = useCallback(async () => {
    if (!details || !address || !details.contractEscrowId) return;
    if (!isBeneficiary) {
      setStep('error');
      setStatusText('This wallet is not the beneficiary of this escrow.');
      return;
    }
    setStep('confirm');
    setExplorerUrl(null);
    try {
      if (chainId !== arcTestnet.id) {
        setStatusText('Switching your wallet to Arc Testnet…');
        const getter = async () => { try { return await (activeConnector as any)?.getProvider?.(); } catch { return null; } };
        const net = await ensureArcNetwork({ chainId, switchChainAsync, getProvider: getter });
        if (!net.ok) {
          setStep('error');
          setStatusText(net.message);
          return;
        }
      }

      setStatusText('Confirm delivery in your wallet…');
      const hash = await writeContractAsync({
        address: details.contractAddress as `0x${string}`,
        abi: confirmDeliveryAbi,
        functionName: 'confirmDelivery',
        args: [details.contractEscrowId as `0x${string}`],
      });
      setTxHash(hash);

      // ── Record: server re-verifies the tx on-chain + mirrors the contract ──
      setStep('recording');
      setStatusText('Verifying your confirmation on-chain…');
      const res = await fetch(`/api/escrow/${reference}/beneficiary-confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSCA: address, txHash: hash }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not record the confirmation.');
      setExplorerUrl(data.explorerUrl || `https://testnet.arcscan.app/tx/${hash}`);
      setStep('done');
      setDetails((prev) => prev ? { ...prev, beneficiaryConfirmed: true, status: data.released ? 'RELEASED' : prev.status } : prev);
    } catch (err: any) {
      setStep('error');
      setStatusText(friendlyWalletError(err));
    }
  }, [details, address, isBeneficiary, chainId, reference, writeContractAsync, switchChainAsync]);

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
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 8px' }}>Tx: {txHash?.slice(0, 18)}…</p>
            {explorerUrl && (
              <a href={explorerUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#E8714A', fontWeight: 600 }}>
                View on ArcScan ↗
              </a>
            )}
          </div>
        ) : step === 'error' ? (
          <div>
            <p style={{ color: '#C0563A', fontWeight: 700, fontSize: 14, margin: '0 0 8px' }}>Something went wrong</p>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 12px' }}>{statusText}</p>
            <button onClick={() => { setStep(isConnected ? 'confirm' : 'connect'); setStatusText(''); }} style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#5C7A5C', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
              Try again
            </button>
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
                const deduped = dedupeConnectors(connectors);
                const injected = deduped.filter((c) => c.type === 'injected');
                const wc = deduped.find((c) => c.type === 'walletConnect');
                const others = deduped.filter((c) => c.type !== 'injected' && c.type !== 'walletConnect');
                const doConnect = async (c: (typeof connectors)[number]) => {
                  setConnectError(null);
                  try { await (connectAsync ? connectAsync({ connector: c }) : connect({ connector: c })); }
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
        ) : chainId !== arcTestnet.id ? (
          <div>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 10px' }}>
              Confirming from <strong>{address ? `${address.slice(0, 10)}…${address.slice(-6)}` : 'wallet'}</strong> · <button onClick={() => disconnect()} style={{ border: 'none', background: 'none', color: '#E8714A', cursor: 'pointer', padding: 0, fontSize: 12 }}>disconnect</button>
            </p>
            <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, padding: 10, marginBottom: 10, textAlign: 'center' }}>
              <p style={{ color: '#b45309', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Wrong network</p>
              <p style={{ color: '#8A8275', fontSize: 11, margin: 0 }}>This escrow uses Arc Testnet. Switch your wallet to Arc to continue.</p>
            </div>
            <button
              onClick={async () => {
                const getter = async () => { try { return await (activeConnector as any)?.getProvider?.(); } catch { return null; } };
                const net = await ensureArcNetwork({ chainId, switchChainAsync, getProvider: getter });
                if (!net.ok) { setStep('error'); setStatusText(net.message); }
              }}
              style={{ width: '100%', padding: '12px 18px', borderRadius: 10, border: '1px solid #5C7A5C', background: '#fff', color: '#5C7A5C', fontWeight: 700, cursor: 'pointer' }}>
              Switch to Arc Testnet
            </button>
            <p style={{ fontSize: 10, color: '#8A8275', margin: '6px 0 0', textAlign: 'center' }}>Confirmation is blocked until Arc Testnet is selected.</p>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 10px' }}>
              Confirming from <strong>{address ? `${address.slice(0, 10)}…${address.slice(-6)}` : 'wallet'}</strong> · Arc Testnet ✓ · <button onClick={() => disconnect()} style={{ border: 'none', background: 'none', color: '#E8714A', cursor: 'pointer', padding: 0, fontSize: 12 }}>disconnect</button>
            </p>
            <button onClick={confirmDelivery} disabled={step !== 'connect'}
              style={{ width: '100%', padding: '12px 18px', borderRadius: 10, border: 'none', background: '#5C7A5C', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
              {step === 'connect' ? '✓ Confirm delivery' : statusText || 'Working…'}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
