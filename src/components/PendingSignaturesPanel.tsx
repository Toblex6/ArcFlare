'use client';

// src/components/PendingSignaturesPanel.tsx
//
// Lists pending external-wallet requests for the logged-in merchant.
//
// These are TRANSACTION requests: the server has created an authoritative
// intent (exact contract/token, function, args, sender) and the merchant's
// connected wallet must BROADCAST the real transaction. The panel builds
// writeContract(...) from the intent, sends it with the wallet, then submits
// the REAL txHash to the server, which independently verifies the receipt +
// on-chain effect before any domain state changes.
//
// A message signature is never a substitute for a broadcast. There is no
// "Sign & Approve" — only "Approve & broadcast transaction in your wallet".

import React, { useState, useEffect, useCallback } from 'react';
import { useAccount, useChainId, useWriteContract } from 'wagmi';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';

interface TransactionIntent {
  description?: string;
  chainId: number;
  to: string;
  from: string;
  abiFunctionSignature: string;
  args: unknown[];
  value?: string;
}

interface SignRequest {
  id: string;
  action: string;
  actionRefId: string;
  payload: Record<string, unknown> & { transaction?: TransactionIntent };
  status: string;
  createdAt: string;
  expiresAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  'tx.escrow.release': 'Confirm escrow delivery',
  'tx.escrow.dispute': 'Raise escrow dispute',
  'tx.payroll.transfer': 'Payroll transfer',
};

/**
 * Parse "funcName(type1,type2)" into a minimal viem ABI function fragment.
 */
function abiFromSignature(signature: string): any {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  const name = signature.slice(0, open).split(' ').pop() || 'fn';
  const rawTypes = signature.slice(open + 1, close).split(',');
  const inputs = rawTypes
    .map((t) => t.trim())
    .filter(Boolean)
    .map((type) => ({ name: '', type }));
  return { name, type: 'function', stateMutability: 'payable', inputs, outputs: [] };
}

/**
 * The server stores uint args as decimal strings; the wallet wants bigint.
 */
function coerceArgs(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (typeof a === 'string' && /^-?\d+$/.test(a)) {
      try {
        return BigInt(a);
      } catch {
        return a;
      }
    }
    return a;
  });
}

export default function PendingSignaturesPanel() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync, isPending: isBroadcasting } = useWriteContract();
  const chainId = useChainId();

  const [requests, setRequests] = useState<SignRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [broadcastId, setBroadcastId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successIds, setSuccessIds] = useState<Set<string>>(new Set());

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/merchant/wallet/sign-requests');
      const data = await res.json();
      if (data.success) setRequests(data.requests);
    } catch {
      // leave list as-is on failure — don't block the rest of the page
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const handleBroadcast = async (req: SignRequest) => {
    if (!isConnected) {
      setError('Connect your wallet above first.');
      return;
    }
    const intent = req.payload?.transaction;
    if (!intent) {
      setError('This request has no transaction intent and cannot be executed.');
      return;
    }
    if (address?.toLowerCase() !== intent.from.toLowerCase()) {
      setError(`Your connected wallet (${address}) is not the wallet this action is bound to (${intent.from}). Connect the correct wallet.`);
      return;
    }
    if (chainId !== intent.chainId) {
      setError(`This action must be broadcast on Arc Testnet (chain ${intent.chainId}). Switch networks and try again.`);
      return;
    }
    setBroadcastId(req.id);
    setError(null);
    try {
      const abi = [abiFromSignature(intent.abiFunctionSignature)];
      const txHash = await writeContractAsync({
        address: intent.to as `0x${string}`,
        abi,
        functionName: abi[0].name,
        args: coerceArgs(intent.args),
        ...(intent.value && intent.value !== '0' ? { value: BigInt(intent.value) as any } : {}),
      });

      const res = await fetch(`/api/merchant/wallet/sign-requests/${req.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash }),
      });
      const data = await res.json();
      if (!data.success) {
        // Server verification details are developer diagnostics — log them,
        // show the merchant a generic line (same pattern as the broadcast catch).
        console.error('[PendingSignaturesPanel] verification rejected:', data.error, data.details || '');
        throw new Error(data.error || 'Could not verify the transaction. The server will re-check it — try again.');
      }
      setSuccessIds((prev) => new Set(prev).add(req.id));
      setRequests((prev) => prev.filter((r) => r.id !== req.id));
    } catch (err: any) {
      // Friendly, non-technical message for the merchant; full detail goes to
      // the browser console only (wallet reverts can embed raw RPC payloads).
      console.error('[PendingSignaturesPanel] broadcast/verify failed:', err);
      setError(friendlyWalletError(err) || 'Could not broadcast or verify the transaction. Try again.');
    } finally {
      setBroadcastId(null);
    }
  };

  if (loading) {
    return <p style={{ fontSize: 'clamp(12px, 1vw, 13px)', color: 'var(--text-secondary)' }}>Loading pending transactions...</p>;
  }

  if (requests.length === 0) {
    return (
      <p style={{ fontSize: 'clamp(12px, 1vw, 13px)', color: 'var(--text-secondary)', margin: 0 }}>
        Nothing waiting on your wallet right now.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 'clamp(11px, 1vw, 13px)', margin: 0, wordBreak: 'break-word' }}>❌ {error}</p>
      )}
      {requests.map((req) => {
        const intent = req.payload?.transaction;
        if (!intent) {
          return (
            <div key={req.id} style={{ background: 'var(--surface-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: 'clamp(12px, 1.5vw, 16px)' }}>
              <p style={{ margin: 0, fontSize: 'clamp(11px, 1vw, 13px)', color: 'var(--text-secondary)' }}>
                Legacy message-signature request ({req.action}) — message signatures no longer execute actions. Retry the action to create a real transaction request.
              </p>
            </div>
          );
        }
        return (
          <div
            key={req.id}
            style={{
              background: 'var(--surface-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 'clamp(12px, 1.5vw, 16px)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 'clamp(12px, 1vw, 14px)', color: 'var(--text)' }}>
                {ACTION_LABELS[req.action] || req.action}
              </span>
              <span style={{ fontSize: 'clamp(9px, 0.8vw, 11px)', color: 'var(--text-secondary)' }}>
                Expires {new Date(req.expiresAt).toLocaleTimeString()}
              </span>
            </div>
            {intent.description && (
              <p style={{ margin: 0, fontSize: 'clamp(11px, 0.9vw, 13px)', color: 'var(--text)' }}>{intent.description}</p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'clamp(10px, 0.9vw, 12px)', color: 'var(--text-secondary)' }}>
              {(req.payload as any)?.reference && <span>Ref: {(req.payload as any).reference.slice(0, 16)}...</span>}
              {(req.payload as any)?.amount && <span>Amount: {(req.payload as any).amount} USDC</span>}
              {(req.payload as any)?.recipientSCA && <span>To: {(req.payload as any).recipientSCA.slice(0, 10)}... <button onClick={() => navigator.clipboard?.writeText((req.payload as any).recipientSCA)} style={{ fontSize: 10, marginLeft: 6 }}>Copy</button></span>}
              <span style={{ fontFamily: 'monospace' }}>Contract: {intent.to.slice(0, 10)}... · {intent.abiFunctionSignature}</span>
              {address?.toLowerCase() !== intent.from.toLowerCase() && (
                <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                  ⚠ Bound to {intent.from.slice(0, 10)}…{intent.from.slice(-4)} — connect that wallet to broadcast.
                </span>
              )}
              <details><summary style={{ cursor: 'pointer', fontSize: 10 }}>Details</summary><pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 10 }}>{JSON.stringify(req.payload, null, 2)}</pre></details>
            </div>
            <button
              onClick={() => handleBroadcast(req)}
              disabled={broadcastId === req.id || isBroadcasting}
              style={{
                width: '100%',
                padding: 'clamp(10px, 1.3vw, 13px)',
                borderRadius: 10,
                border: 'none',
                fontSize: 'clamp(12px, 1vw, 14px)',
                fontWeight: 700,
                cursor: broadcastId === req.id || isBroadcasting ? 'not-allowed' : 'pointer',
                background: broadcastId === req.id || isBroadcasting ? 'rgba(200,151,90,0.3)' : 'var(--primary)',
                color: broadcastId === req.id || isBroadcasting ? 'rgba(14,11,8,0.5)' : 'var(--background)',
                boxSizing: 'border-box',
              }}
            >
              {broadcastId === req.id || isBroadcasting ? 'Approve & broadcast in your wallet…' : 'Approve & broadcast transaction'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
