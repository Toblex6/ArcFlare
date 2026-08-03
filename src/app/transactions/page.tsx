//src/app/transactions/page.tsx
'use client';

import DashboardSidebar from '@/src/components/DashboardSidebar';

import { useRouter } from 'next/navigation';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';

interface PaymentItem {
  id: string;
  reference: string;
  amount: number;
  currency: string;
  chain: string;
  status: string;
  sender_email: string | null;
  merchant: string | null;
  paid_at: string;
  arc_tx_hash: string | null;
  explorer_url: string | null;
  gateway_reference: string | null;
}

export default function TransactionsPage() {
  const _router = useRouter();
  React.useEffect(() => {
    fetch('/api/merchant/me').then((r) => {
      if (r.status === 401) _router.replace('/merchant/login');
    }).catch(() => _router.replace('/merchant/login'));
  }, []);

  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/payments/all')
      .then((r) => r.json())
      .then((json) => {
        if (json.status) setPayments(json.data);
        else setError(json.error);
      })
      .catch(() => setError('Failed to load transactions.'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: '#f8fafc',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      {/* Sidebar - Updated to Cyan Theme */}
      <DashboardSidebar active="Transactions" />

      {/* Main Content */}
      <main style={{ flex: 1, padding: '32px 32px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
          Transactions
        </h1>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 24 }}>
          All inbound agent settlement streams
        </p>

        <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-base font-bold tracking-wide uppercase font-mono text-slate-800">
              Inbound Agent Settlement Streams
            </h3>
            <span className="text-xs text-cyan-600 font-mono bg-cyan-50 px-3 py-1 rounded-lg border border-cyan-100">
              Prisma Database Synchronization
            </span>
          </div>

          {loading && <p className="text-slate-400 text-sm font-mono">Loading transactions...</p>}
          {error && <p className="text-red-400 text-xs font-mono">❌ {error}</p>}

          {!loading && payments.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-slate-400 uppercase tracking-wider border-b border-slate-100">
                    <th className="text-left pb-3 pr-4">Reference / Timestamp</th>
                    <th className="text-left pb-3 pr-4">Payer</th>
                    <th className="text-left pb-3 pr-4">Chain</th>
                    <th className="text-left pb-3 pr-4">Payload Value</th>
                    <th className="text-left pb-3 pr-4">Status</th>
                    <th className="text-left pb-3">Onchain Tx</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payments.map((payment) => (
                    <tr key={payment.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-4 pr-4">
                        {payment.explorer_url ? (
                          <a
                            href={payment.explorer_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyan-600 font-semibold hover:underline"
                          >
                            {payment.reference.slice(0, 16)}
                          </a>
                        ) : (
                          <div className="text-cyan-600 font-semibold">
                            {payment.reference.slice(0, 16)}
                          </div>
                        )}
                        <div className="text-slate-400 text-[10px] mt-0.5">
                          {new Date(payment.paid_at).toLocaleString()}
                        </div>
                      </td>
                      <td className="py-4 pr-4 text-slate-700">{payment.sender_email}</td>
                      <td className="py-4 pr-4">
                        <span className="bg-cyan-50 text-cyan-700 px-2 py-0.5 rounded border border-cyan-100 text-[10px]">
                          {payment.chain.length > 20 ? 'Arc-L1' : payment.chain}
                        </span>
                      </td>
                      <td className="py-4 pr-4 text-slate-900 font-bold">
                        {payment.amount.toFixed(2)} {payment.currency}
                      </td>
                      <td className="py-4 pr-4">
                        <span
                          className={`px-2 py-1 rounded text-[10px] font-bold border ${payment.status === 'SUCCESS'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                            : payment.status === 'EXPIRED'
                              ? 'bg-red-50 text-red-700 border-red-100'
                              : 'bg-amber-50 text-amber-700 border-amber-100'
                            }`}
                        >
                          {payment.status}
                        </span>
                      </td>
                      <td className="py-4 text-slate-500 text-[10px]">
                        {payment.explorer_url ? (
                          <a href={payment.explorer_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                            {payment.arc_tx_hash?.slice(0, 10)}...
                          </a>
                        ) : payment.gateway_reference ? (
                          <span className="text-slate-400" title="Circle Gateway batches this onchain periodically — not yet a resolvable tx hash">
                            Pending batch settlement
                          </span>
                        ) : (
                          <span className="text-slate-400">Not yet onchain</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
