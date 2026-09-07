// src/components/checkout/routing/RoutedReceipt.tsx
//
// "Paid with X / Merchant received Y" confirmation rows for routed
// payments — and the matching X == Y rows for direct payments (so the two
// are never collapsed into one ambiguous "currency" label). Purely
// presentational; amounts are backend-authoritative display strings passed
// in by the caller (measured actuals when executed, quoted values before).

import React from 'react';

interface RoutedReceiptProps {
  converted: boolean;
  paySymbol: string;
  /** Measured debit when settled, else the quoted pay-in. */
  payAmountDisplay: string;
  settlementSymbol: string;
  /** Measured merchant credit when settled, else the quoted output. */
  settlementAmountDisplay: string;
  txHash?: string | null;
  explorerUrl?: string | null;
}

export function RoutedReceipt({
  converted,
  paySymbol,
  payAmountDisplay,
  settlementSymbol,
  settlementAmountDisplay,
  txHash,
  explorerUrl,
}: RoutedReceiptProps) {
  return (
    <div
      style={{
        background: 'rgba(6,182,212,0.06)',
        border: '1px solid rgba(6,182,212,0.15)',
        borderRadius: 12,
        padding: 14,
        marginBottom: 12,
        maxWidth: '100%',
        boxSizing: 'border-box',
      }}
    >
      <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 8px' }}>
        {converted ? 'Paid with conversion' : 'Paid directly'}
      </p>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ color: '#6b5a45', fontSize: 11 }}>Paid with</span>
        <span style={{ color: '#f0ece6', fontSize: 12, fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' }}>
          {payAmountDisplay} {paySymbol}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: '#6b5a45', fontSize: 11 }}>Merchant received</span>
        <span style={{ color: '#06b6d4', fontSize: 12, fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' }}>
          {settlementAmountDisplay} {settlementSymbol}
        </span>
      </div>
      {txHash && (
        <p style={{ fontSize: 10, fontFamily: 'monospace', color: '#6b5a45', margin: '8px 0 0', wordBreak: 'break-all' }}>
          {explorerUrl ? (
            <a href={explorerUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#06b6d4' }}>
              View transaction ↗
            </a>
          ) : (
            <>{txHash}</>
          )}
        </p>
      )}
    </div>
  );
}
