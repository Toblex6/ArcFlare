'use client';

// Executes server-authored FlareHQ Job transaction intents from an external
// wallet. Every call is still verified server-side before state advances.

import { useRef, useState } from 'react';
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi';
import { parseAbiItem } from 'viem';
import { ensureArcNetwork } from '@/lib/wallet/ensureArcNetwork';
import { useActiveArcChain } from '@/src/components/NetworkContext';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';
import { useSecurePinDialog } from '@/components/SecurePinDialog';

export interface JobTransactionIntent {
  description: string;
  chainId: number;
  from: string;
  to: string;
  abiFunctionSignature: string;
  args: unknown[];
  value?: string;
}

export default function FlareHQExternalTransactions({ transactions, confirm, consumerAddress, onDone }: {
  transactions: JobTransactionIntent[];
  confirm: { endpoint: string; body?: Record<string, unknown> };
  consumerAddress?: string;
  onDone: () => Promise<void> | void;
}) {
  const { address, connector } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { chain } = useActiveArcChain();
  const publicClient = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { requestPin, dialog } = useSecurePinDialog();
  const running = useRef(false);
  const submitted = useRef<Array<`0x${string}` | undefined>>([]);
  const completed = useRef(0);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (running.current) return;
    if (!address) return setError('Connect the job party wallet.');
    running.current = true;
    setBusy(true); setError(null);
    try {
      if (!publicClient || !transactions.length) throw new Error('No executable job transaction is available. Refresh the job.');
      if (transactions.some((tx) => tx.chainId !== chain.id || tx.from.toLowerCase() !== address.toLowerCase())) {
        throw new Error('Connected wallet or network does not match the required job party.');
      }
      const providerGetter = async () => (connector as any)?.getProvider?.() ?? (window as any)?.ethereum;
      const net = await ensureArcNetwork({ chainId, switchChainAsync, getProvider: providerGetter, chain });
      if (!net.ok) throw new Error(net.message);
      for (let i = completed.current; i < transactions.length; i++) {
        const tx = transactions[i];
        if (tx.from.toLowerCase() !== address.toLowerCase()) throw new Error('Connected wallet is not the required job party wallet.');
        const abi = [parseAbiItem(`function ${tx.abiFunctionSignature}` as any)] as any;
        // Save each submitted hash before waiting. A timeout or verification
        // retry must never broadcast the same funding/confirmation again.
        const hash = submitted.current[i] ?? await writeContractAsync({
          address: tx.to as `0x${string}`,
          abi,
          functionName: tx.abiFunctionSignature.slice(0, tx.abiFunctionSignature.indexOf('(')),
          args: tx.args as any,
          value: BigInt(tx.value ?? '0'),
        } as any);
        submitted.current[i] = hash;
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error('Job transaction reverted. Do not repeat funding; inspect this transaction first.');
        completed.current = i + 1;
        setStep(i + 1);
      }
      const finalHash = submitted.current[transactions.length - 1];
      if (!finalHash) throw new Error('The submitted job transaction hash is unavailable.');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (consumerAddress) {
        const securityResponse = await fetch('/api/consumer/security', { cache: 'no-store' });
        const security = await securityResponse.json();
        if (!securityResponse.ok || !security.success || security.walletAddress?.toLowerCase() !== consumerAddress.toLowerCase() || typeof security.hasPin !== 'boolean') {
          throw new Error('Wallet security changed. Restore the same consumer session before verifying this transaction.');
        }
        if (security.hasPin) {
          const pin = await requestPin({ title: 'Verify job action', description: 'Enter your payment PIN to verify the submitted transaction.', confirmLabel: 'Verify' });
          if (pin === null) return;
          headers['x-consumer-pin'] = pin;
        }
      }
      const res = await fetch(confirm.endpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ ...(confirm.body ?? {}), txHash: finalHash }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error ?? 'FlareHQ could not verify the transaction yet.');
      await onDone();
    } catch (e: any) {
      setError(friendlyWalletError(e) || e.message || 'Wallet transaction failed.');
    } finally { running.current = false; setBusy(false); }
  }

  return <div style={{ marginTop: 12 }}>
    <p style={{ color: '#a89684', fontSize: 12 }}>{transactions[Math.min(step, transactions.length - 1)]?.description}</p>
    <button onClick={run} disabled={busy} style={{ width: '100%', padding: 12, border: 0, borderRadius: 10, background: '#c8975a', color: '#0e0b08', fontWeight: 800 }}>
      {busy ? 'Waiting for wallet / confirmation…' : step === transactions.length ? 'Verify submitted transaction' : step > 0 ? 'Continue wallet steps' : 'Approve in wallet'}
    </button>
    {error && <p style={{ color: '#f87171', fontSize: 11 }}>{error}</p>}
    {submitted.current.filter(Boolean).map((hash) => <p key={hash} style={{ fontSize: 11, overflowWrap: 'anywhere' }}>Submitted transaction: {hash}</p>)}
    {dialog}
  </div>;
}
