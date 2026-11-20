'use client';

// Executes server-authored FlareHQ Job transaction intents from an external
// wallet. Every call is still verified server-side before state advances.

import { useState } from 'react';
import { useAccount, useChainId, useSwitchChain, useWriteContract } from 'wagmi';
import { parseAbiItem } from 'viem';
import { ensureArcNetwork } from '@/lib/wallet/ensureArcNetwork';
import { useActiveArcChain } from '@/src/components/NetworkContext';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';

export interface JobTransactionIntent {
  description: string;
  chainId: number;
  from: string;
  to: string;
  abiFunctionSignature: string;
  args: unknown[];
  value?: string;
}

export default function FlareHQExternalTransactions({ transactions, confirm, onDone }: {
  transactions: JobTransactionIntent[];
  confirm: { endpoint: string; body?: Record<string, unknown> };
  onDone: () => Promise<void> | void;
}) {
  const { address, connector } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { chain } = useActiveArcChain();
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!address) return setError('Connect the job party wallet.');
    setBusy(true); setError(null);
    try {
      const providerGetter = async () => (connector as any)?.getProvider?.() ?? (window as any)?.ethereum;
      const net = await ensureArcNetwork({ chainId, switchChainAsync, getProvider: providerGetter, chain });
      if (!net.ok) throw new Error(net.message);
      let finalHash = '';
      for (let i = step; i < transactions.length; i++) {
        const tx = transactions[i];
        if (tx.from.toLowerCase() !== address.toLowerCase()) throw new Error('Connected wallet is not the required job party wallet.');
        const abi = [parseAbiItem(`function ${tx.abiFunctionSignature}` as any)] as any;
        finalHash = await writeContractAsync({
          address: tx.to as `0x${string}`,
          abi,
          functionName: tx.abiFunctionSignature.slice(0, tx.abiFunctionSignature.indexOf('(')),
          args: tx.args as any,
          value: BigInt(tx.value ?? '0'),
        } as any);
        setStep(i + 1);
      }
      const res = await fetch(confirm.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(confirm.body ?? {}), txHash: finalHash }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error ?? 'FlareHQ could not verify the transaction yet.');
      await onDone();
    } catch (e: any) {
      setError(friendlyWalletError(e) || e.message || 'Wallet transaction failed.');
    } finally { setBusy(false); }
  }

  return <div style={{ marginTop: 12 }}>
    <p style={{ color: '#a89684', fontSize: 12 }}>{transactions[Math.min(step, transactions.length - 1)]?.description}</p>
    <button onClick={run} disabled={busy} style={{ width: '100%', padding: 12, border: 0, borderRadius: 10, background: '#c8975a', color: '#0e0b08', fontWeight: 800 }}>
      {busy ? 'Waiting for wallet…' : step > 0 ? 'Continue wallet steps' : 'Approve in wallet'}
    </button>
    {error && <p style={{ color: '#f87171', fontSize: 11 }}>{error}</p>}
  </div>;
}
