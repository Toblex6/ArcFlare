// src/components/checkout/routing/PayTokenSelector.tsx
//
// "Pay with" selector for the hosted + embed checkout.
// Purely presentational (no wagmi, no fetching) so it renders anywhere —
// including server-side in UI tests.
//
// PRODUCTION MERCHANT PRODUCT: USDC direct settlement only. The only offered
// pay token is USDC — EURC is NOT a selectable checkout payment option (the
// production checkout presents USDC as the settlement path and never claims
// a conversion). The routed approve→route executor is untouched; this
// component simply offers no cross-token selection.
//
// Mobile: two full-height (48px) touch targets that share the row and wrap
// instead of clipping.

import React from 'react';
import type { SupportedCurrency } from '@/src/lib/tokens/clientTokens';

interface PayTokenSelectorProps {
  settlementSymbol: SupportedCurrency;
  selected: SupportedCurrency;
  onSelect: (symbol: SupportedCurrency) => void;
  disabled?: boolean;
}

const OPTIONS: readonly SupportedCurrency[] = ['USDC'];

export function PayTokenSelector({ settlementSymbol, selected, onSelect, disabled = false }: PayTokenSelectorProps) {
  return (
    <div style={{ marginBottom: 14 }}>
      <p style={{ fontSize: 10, color: '#6b5a45', textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 8px' }}>
        Pay with
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="radiogroup" aria-label="Pay with">
        {OPTIONS.map((symbol) => {
          const isSelected = selected === symbol;
          const isDirect = symbol === settlementSymbol;
          return (
            <button
              key={symbol}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onSelect(symbol)}
              disabled={disabled}
              style={{
                flex: '1 1 140px',
                minHeight: 48,
                padding: '10px 12px',
                borderRadius: 12,
                border: isSelected ? '1px solid #c8975a' : '1px solid #3d2e1a',
                background: isSelected ? 'rgba(200,151,90,0.12)' : '#251c12',
                color: '#f0ece6',
                fontSize: 14,
                fontWeight: 800,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.6 : 1,
                boxSizing: 'border-box',
              }}
            >
              {symbol}
              <span style={{ display: 'block', fontSize: 10, fontWeight: 500, color: isSelected ? '#c8975a' : '#6b5a45', marginTop: 2 }}>
                {isDirect ? 'No conversion' : `Converts to ${settlementSymbol}`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
