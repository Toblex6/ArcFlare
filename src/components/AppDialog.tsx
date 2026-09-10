// src/components/AppDialog.tsx
// Small dependency-free modal shell used by the secure PIN dialog and the
// amount/reason input dialogs that replaced the old blocking browser prompts.
// Handles the accessibility basics: aria-modal semantics, initial
// focus, trapping Tab inside the dialog, Escape-to-cancel, backdrop-click
// cancel, and body scroll lock. It is presentation-only — callers own the
// form fields and submission logic.
'use client';

import React, { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface AppDialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

export default function AppDialog({
  open,
  title,
  description,
  onClose,
  children,
  maxWidth = 400,
  initialFocusRef,
}: AppDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const node = dialogRef.current;
    if (!node) return;

    const getFocusable = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null
      );

    const target = initialFocusRef?.current ?? getFocusable()[0] ?? node;
    target.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = getFocusable();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        padding: 16,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: 'var(--flow-surface, var(--surface, #1a1410))',
          color: 'var(--flow-text, var(--text, #f0ece6))',
          border: '1px solid var(--flow-border, var(--border, #2d2015))',
          borderRadius: 16,
          width: '100%',
          maxWidth,
          maxHeight: '85vh',
          overflowY: 'auto',
          padding: 20,
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
          boxSizing: 'border-box',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        <h2 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700 }}>{title}</h2>
        {description ? (
          <p
            style={{
              margin: '0 0 14px',
              fontSize: 13,
              lineHeight: 1.5,
              color: 'var(--flow-text-muted, var(--text-secondary, #8a7560))',
            }}
          >
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}
