// src/components/SecurePinDialog.tsx
// Masked, transient payment-PIN dialog. Replaces the blocking browser prompts
// that used to collect the step-up PIN. Security properties:
//   - input type=password (never rendered as plaintext)
//   - value lives only in React state, cleared on submit/cancel/failure
//   - never persisted to localStorage/sessionStorage, never logged, never
//     placed in a URL or console
// The hook returns a promise-based requestPin() plus the dialog element to
// render, so callers keep their existing async control flow.
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import AppDialog from './AppDialog';

export interface PinPromptOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
}

export interface PinDialogTheme {
  accent?: string;
  accentText?: string;
  error?: string;
}

interface SecurePinDialogProps {
  open: boolean;
  options: PinPromptOptions | null;
  theme: PinDialogTheme;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}

function SecurePinDialog({ open, options, theme, onSubmit, onCancel }: SecurePinDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPin('');
      setError(null);
    }
  }, [open]);

  if (!open || !options) return null;

  const accent = theme.accent ?? '#1C1B19';
  const accentText = theme.accentText ?? '#FBF8F3';
  const errorColor = theme.error ?? '#C0563A';

  const cancel = () => {
    setPin('');
    setError(null);
    onCancel();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,6}$/.test(pin)) {
      setError('Enter your 4–6 digit PIN.');
      return;
    }
    const value = pin;
    setPin('');
    setError(null);
    onSubmit(value);
  };

  return (
    <AppDialog
      open={open}
      title={options.title ?? 'Enter your payment PIN'}
      description={options.description}
      onClose={cancel}
      maxWidth={360}
      initialFocusRef={inputRef}
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          ref={inputRef}
          type="password"
          value={pin}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, '').slice(0, 6);
            setPin(next);
            if (error) setError(null);
          }}
          inputMode="numeric"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={6}
          placeholder="4–6 digit PIN"
          aria-label="Payment PIN"
          style={{
            width: '100%',
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid var(--flow-border, var(--border, #2d2015))',
            background: 'var(--flow-bg, var(--background, #0e0b08))',
            color: 'var(--flow-text, var(--text, #f0ece6))',
            fontSize: 16,
            letterSpacing: 4,
            fontFamily: 'inherit',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {error ? (
          <p style={{ margin: 0, fontSize: 12, color: errorColor }}>{error}</p>
        ) : null}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            onClick={cancel}
            style={{
              flex: 1,
              padding: '10px 0',
              borderRadius: 12,
              border: '1px solid var(--flow-border, var(--border, #2d2015))',
              background: 'transparent',
              color: 'var(--flow-text, var(--text, #f0ece6))',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            style={{
              flex: 1,
              padding: '10px 0',
              borderRadius: 12,
              border: 'none',
              background: accent,
              color: accentText,
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {options.confirmLabel ?? 'Authorize'}
          </button>
        </div>
      </form>
    </AppDialog>
  );
}

export function useSecurePinDialog(theme: PinDialogTheme = {}) {
  const resolverRef = useRef<((value: string | null) => void) | null>(null);
  const [request, setRequest] = useState<PinPromptOptions | null>(null);
  // Keep the latest theme without making requestPin unstable.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const requestPin = useCallback((options: PinPromptOptions = {}) => {
    return new Promise<string | null>((resolve) => {
      // Defensive: if a previous request never settled, resolve it as
      // cancelled rather than leaving the caller hanging forever.
      if (resolverRef.current) {
        const previous = resolverRef.current;
        resolverRef.current = null;
        previous(null);
      }
      resolverRef.current = resolve;
      setRequest(options);
    });
  }, []);

  const settle = useCallback((value: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    if (resolve) resolve(value);
  }, []);

  const dialog = (
    <SecurePinDialog
      open={!!request}
      options={request}
      theme={themeRef.current}
      onSubmit={(pin) => settle(pin)}
      onCancel={() => settle(null)}
    />
  );

  return { requestPin, dialog };
}
