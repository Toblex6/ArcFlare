// src/components/checkout/routing/QuotePanel.tsx
//
// Customer-facing conversion quote panel. Purely presentational: the parent
// (CheckoutWidget via useRoutingQuote) owns fetching, countdown, and
// re-quote — this component only renders one of five honest states:
//
//   loading    — quote being fetched ("Getting your conversion rate…")
//   ready      — "You pay X → Merchant receives Y" + rate, minimum
//                received, fee disclosure, live expiry, refresh action
//   refreshing — previous quote expired; a fresh one is being fetched
//                (automatic, recoverable re-quote)
//   expired    — shown only if auto re-quote is unavailable; manual retry
//   error      — friendly headline + retry + collapsible technical detail
//
// Payment language only in the main surface ("Conversion", "Rate",
// "Network/processing fee", "Minimum received"). Venue vocabulary never
// appears here — not even in the details surface, which carries the quote
// reference the merchant/support can use instead.

import React, { useState } from 'react';
import { formatCountdown } from './routingCopy';
import type { QuoteViewModel } from './quoteView';

export type QuotePanelState =
  | { status: 'loading' }
  | { status: 'ready'; quote: QuoteViewModel; secondsLeft: number }
  | { status: 'refreshing' }
  | { status: 'expired' }
  | { status: 'error'; headline: string; raw: string | null };

interface QuotePanelProps {
  state: QuotePanelState;
  onRefresh: () => void;
  compact?: boolean;
}

function PanelShell({ children, tone }: { children: React.ReactNode; tone: 'info' | 'warn' | 'error' }) {
  const border =
    tone === 'error' ? 'rgba(239,68,68,0.25)' : tone === 'warn' ? 'rgba(245,158,11,0.25)' : 'rgba(200,151,90,0.25)';
  const bg =
    tone === 'error' ? 'rgba(239,68,68,0.06)' : tone === 'warn' ? 'rgba(245,158,11,0.06)' : 'rgba(200,151,90,0.06)';
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 12,
        padding: 14,
        marginBottom: 12,
        maxWidth: '100%',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </div>
  );
}

function RefreshButton({ onRefresh, label = 'Refresh quote' }: { onRefresh: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      style={{
        width: '100%',
        minHeight: 44,
        marginTop: 10,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid #3d2e1a',
        background: '#251c12',
        color: '#c8975a',
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        boxSizing: 'border-box',
      }}
    >
      {label}
    </button>
  );
}

export function QuotePanel({ state, onRefresh, compact = false }: QuotePanelProps) {
  const [showTechnical, setShowTechnical] = useState(false);

  if (state.status === 'loading') {
    return (
      <PanelShell tone="info">
        <p style={{ color: '#c8975a', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Getting your conversion rate…</p>
        <p style={{ color: '#a89684', fontSize: 11, margin: 0 }}>Priced live for this payment. This should only take a moment.</p>
      </PanelShell>
    );
  }

  if (state.status === 'refreshing') {
    return (
      <PanelShell tone="warn">
        <p style={{ color: '#f59e0b', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Quote expired — getting a fresh one…</p>
        <p style={{ color: '#a89684', fontSize: 11, margin: 0 }}>Rates refresh automatically. Nothing has been charged.</p>
      </PanelShell>
    );
  }

  if (state.status === 'expired') {
    return (
      <PanelShell tone="warn">
        <p style={{ color: '#f59e0b', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Quote expired</p>
        <p style={{ color: '#a89684', fontSize: 11, margin: 0 }}>Conversion rates are only valid for a few minutes. Get a fresh quote to continue — nothing has been charged.</p>
        <RefreshButton onRefresh={onRefresh} label="Get a fresh quote" />
      </PanelShell>
    );
  }

  if (state.status === 'error') {
    return (
      <PanelShell tone="error">
        <p style={{ color: '#f87171', fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Couldn&apos;t get a conversion rate</p>
        <p style={{ color: '#a89684', fontSize: 11, margin: 0 }}>{state.headline}</p>
        <RefreshButton onRefresh={onRefresh} label="Try again" />
        {state.raw && (
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={() => setShowTechnical((v) => !v)}
              style={{ background: 'none', border: 'none', color: '#6b5a45', cursor: 'pointer', fontSize: 10, padding: 0, textDecoration: 'underline' }}
            >
              {showTechnical ? 'Hide technical details' : 'Show technical details'}
            </button>
            {showTechnical && (
              <p style={{ color: '#6b5a45', fontSize: 10, fontFamily: 'monospace', margin: '6px 0 0', wordBreak: 'break-word' }}>{state.raw}</p>
            )}
          </div>
        )}
      </PanelShell>
    );
  }

  // ready — the exact "you pay X → merchant receives Y" explanation.
  const { quote, secondsLeft } = state;
  const lowTime = secondsLeft <= 60;
  return (
    <PanelShell tone="info">
      <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 8px' }}>
        Conversion
      </p>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <p style={{ color: '#f0ece6', fontSize: compact ? 14 : 16, fontWeight: 800, margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
          You pay {quote.payAmountDisplay} {quote.paySymbol}
        </p>
        <p aria-hidden="true" style={{ color: '#c8975a', fontSize: 16, fontWeight: 800, margin: 0 }}>→</p>
        <p style={{ color: '#f0ece6', fontSize: compact ? 14 : 16, fontWeight: 800, margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
          Merchant receives ≈{quote.quotedOutputDisplay} {quote.settlementSymbol}
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#6b5a45', fontSize: 11 }}>Rate</span>
          <span style={{ color: '#a89684', fontSize: 11 }}>{quote.rateDisplay}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#6b5a45', fontSize: 11 }}>Minimum received</span>
          <span style={{ color: '#a89684', fontSize: 11 }}>
            {quote.minOutputDisplay} {quote.settlementSymbol}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#6b5a45', fontSize: 11 }}>Quote expires in</span>
          <span style={{ color: lowTime ? '#f59e0b' : '#a89684', fontSize: 11, fontWeight: lowTime ? 700 : 500, fontFamily: 'monospace' }}>
            {formatCountdown(secondsLeft)}
          </span>
        </div>
      </div>

      <p style={{ color: '#6b5a45', fontSize: 10, margin: '10px 0 0', lineHeight: 1.5 }}>
        Rate includes the 0.3% conversion fee. The merchant is guaranteed to receive at least the minimum above —
        if the rate moves past it, the payment is protected and you&apos;ll be asked to refresh. Your wallet may add
        small network fees on top of the quoted {quote.paySymbol} amount.
      </p>

      <RefreshButton onRefresh={onRefresh} />
    </PanelShell>
  );
}
