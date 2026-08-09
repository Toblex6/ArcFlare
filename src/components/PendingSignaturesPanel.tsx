'use client';

// src/components/PendingSignaturesPanel.tsx
//
// Lists pending WalletSignatureRequest rows for the logged-in merchant and
// lets them sign+submit each one with their connected external wallet.
// Only relevant for merchants on an external wallet — Circle-managed
// merchants never see anything here since their actions complete instantly.

import React, { useState, useEffect, useCallback } from 'react';
import { useAccount, useSignMessage } from 'wagmi';

interface SignRequest {
  id: string;
  action: string;
  actionRefId: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: string;
  expiresAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  'wallet.transferUSDC': 'USDC transfer',
  'wallet.executeContract': 'Contract action',
  'wallet.signTypedData': 'Signature request',
};

export default function PendingSignaturesPanel() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [requests, setRequests] = useState<SignRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [signingId, setSigningId] = useState<string | null>(null);
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

  const handleSign = async (req: SignRequest) => {
    if (!isConnected) {
      setError('Connect your wallet above first.');
      return;
    }
    setSigningId(req.id);
    setError(null);
    try {
      const signature = await signMessageAsync({ message: JSON.stringify(req.payload) });

      const res = await fetch(`/api/merchant/wallet/sign-requests/${req.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      setSuccessIds((prev) => new Set(prev).add(req.id));
      setRequests((prev) => prev.filter((r) => r.id !== req.id));
    } catch (err: any) {
      setError(err.message || 'Could not submit signature.');
    } finally {
      setSigningId(null);
    }
  };

  if (loading) {
    return <p style={{ fontSize: 'clamp(12px, 1vw, 13px)', color: 'var(--text-secondary)' }}>Loading pending signatures...</p>;
  }

  if (requests.length === 0) {
    return (
      <p style={{ fontSize: 'clamp(12px, 1vw, 13px)', color: 'var(--text-secondary)', margin: 0 }}>
        Nothing waiting on your signature right now.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 'clamp(11px, 1vw, 13px)', margin: 0 }}>❌ {error}</p>
      )}
      {requests.map((req) => (
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
          <p style={{ margin: 0, fontSize: 'clamp(10px, 0.9vw, 12px)', color: 'var(--text-secondary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {JSON.stringify(req.payload)}
          </p>
          <button
            onClick={() => handleSign(req)}
            disabled={signingId === req.id}
            style={{
              width: '100%',
              padding: 'clamp(10px, 1.3vw, 13px)',
              borderRadius: 10,
              border: 'none',
              fontSize: 'clamp(12px, 1vw, 14px)',
              fontWeight: 700,
              cursor: signingId === req.id ? 'not-allowed' : 'pointer',
              background: signingId === req.id ? 'rgba(200,151,90,0.3)' : 'var(--primary)',
              color: signingId === req.id ? 'rgba(14,11,8,0.5)' : 'var(--background)',
              boxSizing: 'border-box',
            }}
          >
            {signingId === req.id ? 'Waiting for signature...' : 'Sign & Approve'}
          </button>
        </div>
      ))}
    </div>
  );
}
