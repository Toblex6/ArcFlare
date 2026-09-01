'use client';

// src/app/escrow-pay/[reference]/page.tsx
//
// Public page where an OUTSIDER (no FlareHQ account, no Circle wallet)
// funds an escrow request link directly from their own external wallet —
// same trust model as Checkout. Mirrors CheckoutWidget's external-wallet
// pattern exactly:
//
//   Step 1: approve(spender=escrowContract, amount)  — wagmi writeContract
//   Step 2: createEscrow(onchainId, beneficiary, amount, deadline, condition)
//
// The two sequential on-chain approvals are signed by the USER's wallet in
// their own browser session — escrow/create's "can't automate two sequential
// approvals for a plain EOA server-side" limitation doesn't apply here
// because nothing is automated: the user signs each step themselves.
//
// After step 2 confirms, the tx is recorded via the public
// /api/escrow/link/[reference]/fund endpoint (server re-verifies on-chain),
// which flips the Escrow row PENDING_FUNDING → ACTIVE. Release/dispute/
// refund logic is unchanged.

import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAccount, useConnect, useDisconnect, useWriteContract, useChainId, useSwitchChain } from 'wagmi';
import { parseUnits, keccak256, toBytes } from 'viem';
import { USDC_CONTRACT, USDC_DECIMALS } from '@/lib/wallet/erc20';
import { arcTestnet } from '@/lib/wagmi';
import { ensureArcNetwork } from '@/lib/wallet/ensureArcNetwork';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';
import { dedupeConnectors, friendlyConnectorLabel, hasInjectedProvider, isMobileViewport } from '@/lib/wallet/walletLabels';

// Minimal ABIs — approve from the ERC-20 surface Checkout uses, createEscrow
// with the exact signature escrow/create/route.ts sends via Circle.
const erc20ApproveAbi = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const escrowAbi = [
  {
    name: 'createEscrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'beneficiary', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'condition', type: 'string' },
    ],
    outputs: [],
  },
] as const;

interface EscrowDetails {
  reference: string;
  amount: number;
  currency: string;
  beneficiarySCA: string;
  condition: string | null;
  deadline: string;
  status: string;
  contractAddress: string;
  funded: boolean;
  expired: boolean;
}

type Step = 'connect' | 'approve' | 'create' | 'recording' | 'done' | 'error';

export default function EscrowPayPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference || '';

  const [details, setDetails] = useState<EscrowDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('connect');
  const [statusText, setStatusText] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [explorerUrl, setExplorerUrl] = useState<string | null>(null);

  const { address, isConnected, connector: activeConnector } = useAccount();
  const { connectors, connect, connectAsync, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync } = useWriteContract();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!reference) return;
    fetch(`/api/escrow/link/${reference}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setDetails(data.escrow);
        else setLoadError(data.error || 'Escrow request not found.');
      })
      .catch(() => setLoadError('Could not load this escrow request.'));
  }, [reference]);

  const fundEscrow = useCallback(async () => {
    if (!details || !address) return;
    setStep('approve');
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

      const amountWei = parseUnits(details.amount.toString(), USDC_DECIMALS);

      // ── Step 1/2: approve the escrow contract to pull USDC ──────────────
      setStatusText('Step 1 of 2: approve USDC spending in your wallet…');
      await writeContractAsync({
        address: USDC_CONTRACT as `0x${string}`,
        abi: erc20ApproveAbi,
        functionName: 'approve',
        args: [details.contractAddress as `0x${string}`, amountWei],
      });

      // ── Step 2/2: createEscrow from the outsider's own wallet ───────────
      setStep('create');
      setStatusText('Step 2 of 2: confirm the escrow deposit in your wallet…');
      const onchainId = keccak256(toBytes(reference));
      const deadlineTimestamp = BigInt(Math.floor(new Date(details.deadline).getTime() / 1000));
      const hash = await writeContractAsync({
        address: details.contractAddress as `0x${string}`,
        abi: escrowAbi,
        functionName: 'createEscrow',
        args: [onchainId, details.beneficiarySCA as `0x${string}`, amountWei, deadlineTimestamp, details.condition || 'No condition set'],
      });
      setTxHash(hash);

      // ── Record: server re-verifies the tx on-chain, row goes ACTIVE ─────
      setStep('recording');
      setStatusText('Verifying your deposit on-chain…');
      const res = await fetch(`/api/escrow/link/${reference}/fund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ depositorSCA: address, txHash: hash }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not record the deposit.');
      setExplorerUrl(data.explorerUrl || `https://testnet.arcscan.app/tx/${hash}`);
      setStep('done');
    } catch (err: any) {
      setStep('error');
      setStatusText(friendlyWalletError(err));
    }
  }, [details, address, chainId, reference, writeContractAsync, switchChainAsync]);

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
    return <main style={page}><div style={card}><p style={{ fontWeight: 700 }}>Escrow request unavailable</p><p style={{ fontSize: 13, color: '#8A8275' }}>{loadError}</p></div></main>;
  }
  if (!details) {
    return <main style={page}><div style={card}><p style={{ fontSize: 13, color: '#8A8275' }}>Loading escrow request…</p></div></main>;
  }
  if (details.funded) {
    return <main style={page}><div style={card}><p style={{ fontWeight: 700 }}>✅ This escrow is already funded</p><p style={{ fontSize: 13, color: '#8A8275' }}>Reference {details.reference} is {details.status}.</p></div></main>;
  }
  if (details.expired) {
    return <main style={page}><div style={card}><p style={{ fontWeight: 700 }}>This escrow request has expired</p><p style={{ fontSize: 13, color: '#8A8275' }}>It passed its deadline on {new Date(details.deadline).toLocaleString()}.</p></div></main>;
  }

  return (
    <main style={page}>
      <div style={card}>
        <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, fontFamily: 'monospace', color: '#8A8275', margin: '0 0 8px' }}>Escrow funding</p>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, margin: '0 0 16px' }}>
          Lock {details.amount} USDC in escrow
        </h1>
        <div style={{ fontSize: 13, lineHeight: 1.7, color: '#1C1B19', marginBottom: 16 }}>
          <p style={{ margin: 0 }}><strong>Beneficiary:</strong> {details.beneficiarySCA.slice(0, 10)}…{details.beneficiarySCA.slice(-6)}</p>
          {details.condition && <p style={{ margin: 0 }}><strong>Release condition:</strong> {details.condition}</p>}
          <p style={{ margin: 0 }}><strong>Deadline:</strong> {new Date(details.deadline).toLocaleString()}</p>
        </div>

        {step === 'done' ? (
          <div>
            <p style={{ color: '#3F7A57', fontWeight: 700, fontSize: 14, margin: '0 0 8px' }}>✅ Escrow funded</p>
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
            <button onClick={() => { setStep(isConnected ? 'approve' : 'connect'); setStatusText(''); }} style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#5C7A5C', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
              Try again
            </button>
          </div>
        ) : !isConnected ? (
          <div>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 10px' }}>
              Connect your own wallet to fund this escrow. You keep custody the whole time — FlareHQ never holds your keys.
              {typeof window !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !(window as any).ethereum
                ? ' On mobile, open this page in your wallet app or use WalletConnect.'
                : ''}
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
                        On mobile, open this page in your wallet app, or use WalletConnect. If the button says “Open” and it’s greyed out, copy the link instead.
                      </p>
                    )}
                  </>
                );
              })()}
            </div>
            {connectError && <p style={{ fontSize: 12, color: '#C0563A', margin: '8px 0 0' }}>⚠️ {connectError}</p>}
          </div>
        ) : chainId !== arcTestnet.id ? (
          <div>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 10px' }}>
              Paying from <strong>{address ? `${address.slice(0, 10)}…${address.slice(-6)}` : 'wallet'}</strong> · {address?.slice(0,6)}...{address?.slice(-4)} · <button onClick={() => disconnect()} style={{ border: 'none', background: 'none', color: '#E8714A', cursor: 'pointer', padding: 0, fontSize: 12 }}>disconnect</button>
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
            <p style={{ fontSize: 10, color: '#8A8275', margin: '6px 0 0', textAlign: 'center' }}>Funding is blocked until Arc Testnet is selected.</p>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 10px' }}>
              Paying from <strong>{address ? `${address.slice(0, 10)}…${address.slice(-6)}` : 'wallet'}</strong> · Arc Testnet ✓ · <button onClick={() => disconnect()} style={{ border: 'none', background: 'none', color: '#E8714A', cursor: 'pointer', padding: 0, fontSize: 12 }}>disconnect</button>
            </p>
            <p style={{ fontSize: 12, color: '#8A8275', margin: '0 0 12px' }}>
              Two wallet confirmations: an ERC-20 approve, then the on-chain escrow deposit — exactly like checkout.
            </p>
            <button onClick={fundEscrow} disabled={step !== 'connect'}
              style={{ width: '100%', padding: '12px 18px', borderRadius: 10, border: 'none', background: '#5C7A5C', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
              {step === 'connect' ? `Fund ${details.amount} USDC escrow` : statusText || 'Working…'}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
