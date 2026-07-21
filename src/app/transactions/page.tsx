//src/app/transactions/page.tsx
'use client';

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
  sender_email: string;
  merchant: string;
  paid_at: string;
  cctp_telemetry: {
    attestation_status: string;
    nonce: number;
  };
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
      <aside
        style={{
          width: 220,
          minHeight: '100vh',
          background: '#0f171c',
          display: 'flex',
          flexDirection: 'column',
          padding: '24px 14px',
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 36,
            paddingLeft: 6,
          }}
        >
          {/* Logo Container */}
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Image
              src="/arcflare-logo.png.png"
              alt="FlareHQ Logo"
              width={32}
              height={32}
              style={{ objectFit: 'contain' }}
            />
          </div>
          <div>
            <p style={{ color: '#fff', fontSize: 14, fontWeight: 700, lineHeight: 1, margin: 0 }}>
              FlareHQ
            </p>
            <p style={{ color: '#64748b', fontSize: 10, margin: '3px 0 0 0' }}>
              Stablecoin Infrastructure
            </p>
          </div>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
          {[
            { label: 'Dashboard', href: '/merchant/dashboard', active: false },
            { label: 'Homepage', href: '/', active: false },
            { label: 'Transactions', href: '/transactions', active: true },
            { label: 'Checkout', href: '/merchant/dashboard#checkout', active: false },
            { label: 'Escrow', href: '/escrow', active: false },
            { label: 'Support', href: '/support', active: false },
          ].map((item) => (
            <a
              key={item.label}
              href={item.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderRadius: 9,
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: 500,
                background: item.active ? 'rgba(6, 182, 212, 0.1)' : 'transparent',
                color: item.active ? '#22d3ee' : '#94a3b8',
                border: item.active ? '1px solid rgba(6, 182, 212, 0.2)' : '1px solid transparent',
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>

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
                    <th className="text-left pb-3 pr-4">Entity M2M Graph</th>
                    <th className="text-left pb-3 pr-4">Execution Domain</th>
                    <th className="text-left pb-3 pr-4">Payload Value</th>
                    <th className="text-left pb-3 pr-4">Status</th>
                    <th className="text-left pb-3">Circle CCTP Attestation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payments.map((payment) => (
                    <tr key={payment.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-4 pr-4">
                        <div className="text-cyan-600 font-semibold">
                          {payment.reference.slice(0, 16)}
                        </div>
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
                          className={`px-2 py-1 rounded text-[10px] font-bold border ${payment.status === 'SUCCESS' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-amber-50 text-amber-700 border-amber-100'}`}
                        >
                          {payment.status}
                        </span>
                      </td>
                      <td className="py-4 text-slate-500 text-[10px]">
                        {payment.cctp_telemetry.attestation_status}
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
