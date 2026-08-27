// src/app/checkout/embed/[reference]/page.tsx
//
// Embeddable checkout — meant to be loaded inside an <iframe> on a
// merchant's own site. Reuses the same CheckoutWidget as the hosted page
// (no duplicate payment logic), but with minimal chrome and a postMessage
// contract so the parent page can react to payment state without needing
// to poll or share auth.
//
// SECURITY NOTES — read before changing this file:
//
// 1. Frame-ancestors / X-Frame-Options is NOT set here. Per-route CSP
//    headers belong in middleware.ts or next.config.js, not in a page
//    component (a page can't reliably override response headers set
//    upstream). I do NOT have visibility into your current middleware.ts,
//    so I have NOT modified it — see the required addition documented at
//    the bottom of this file. Without that addition, this page will
//    likely still be blocked from framing by whatever global CSP/
//    X-Frame-Options you already have (if restrictive) or will be framable
//    by ANY site (if you have none) — neither is correct; you need an
//    explicit allowlist-style frame-ancestors directive scoped to this
//    route, not a global change.
//
// 2. postMessage uses a wildcard targetOrigin ('*') deliberately, because
//    this page has no way to know in advance which merchant site will
//    embed it — that's the nature of a general-purpose embed. The
//    messages sent contain ONLY non-sensitive, already-public payment
//    status fields (reference, status, amount, currency, txHash) — never
//    secrets, never internal IDs beyond what verify/[reference] already
//    returns publicly. If you later want per-merchant origin restriction,
//    that requires the merchant registering an allowed embed origin
//    server-side and passing it back through initialize — not implemented
//    here, flagging as a possible future hardening item rather than
//    guessing at a registration flow that doesn't exist yet.
//
// 3. No wallet private keys, JWT secrets, or internal API keys touch this
//    page at any point — CheckoutWidget already handles wallet connection
//    client-side via the user's own wallet extension, same as the hosted
//    page. This file adds no new credential surface.
//
// 4. This page intentionally has NO merchant branding/logo/header beyond
//    a minimal FlareHQ attribution — an embed should look like it belongs
//    to the merchant's page, not compete with it visually.

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import CheckoutWidget, { CheckoutEvent } from '@/src/components/CheckoutWidget';
import { CheckoutLoading } from '@/src/components/checkout/CheckoutLoading';
import { CheckoutExpired } from '@/src/components/checkout/CheckoutExpired';
import { CheckoutError } from '@/src/components/checkout/CheckoutError';
import { CheckoutAlreadyPaid } from '@/src/components/checkout/CheckoutAlreadyPaid';
import { usePaymentVerify, EnrichedPayment } from '@/src/components/checkout/usePaymentVerify';

// Message contract sent to the parent window via postMessage. Keep this
// list of event types stable — a merchant integrating the embed will
// build logic against these names.
type EmbedMessage =
  | { source: 'flarehq-checkout'; type: 'ready'; reference: string }
  | { source: 'flarehq-checkout'; type: 'status'; reference: string; status: string }
  | { source: 'flarehq-checkout'; type: 'payment_success'; reference: string; status: string; txHash: string | null }
  | { source: 'flarehq-checkout'; type: 'payment_error'; reference: string; message: string }
  | { source: 'flarehq-checkout'; type: 'resize'; height: number };

function isPaymentExpired(payment: EnrichedPayment | null): boolean {
  if (!payment) return false;
  if ((payment as any).status === 'EXPIRED') return true;
  if (payment.status === 'PENDING' && payment.expiresAt) {
    const expiry = new Date(payment.expiresAt).getTime();
    if (!Number.isNaN(expiry) && Date.now() > expiry) return true;
  }
  return false;
}

export default function EmbedCheckoutPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference;

  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Bootstrap resolve lives here (not in the widget) — same deadlock guard
  // as the hosted checkout page. Widget events still update `payment`
  // through handleEvent below.
  const { payment, setPayment } = usePaymentVerify(reference);


  // Post a message to the parent frame. No-op if not actually embedded
  // (window === window.parent), so this page also degrades gracefully if
  // someone opens the embed URL directly in a normal tab.
  const postToParent = (message: EmbedMessage) => {
    if (typeof window === 'undefined' || window.parent === window) return;
    window.parent.postMessage(message, '*'); // see security note #2 above re: wildcard origin
  };

  useEffect(() => {
    if (!reference) return;
    postToParent({ source: 'flarehq-checkout', type: 'ready', reference });
  }, [reference]);

  // Report height changes to the parent so it can size the iframe
  // correctly instead of guessing a fixed height or adding internal
  // iframe scrollbars. Uses ResizeObserver rather than a manual event —
  // catches wallet-connect modals, error states, etc. changing height
  // without needing to enumerate every place height could change.
  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect?.height;
      if (height && reference) {
        postToParent({ source: 'flarehq-checkout', type: 'resize', height: Math.ceil(height) });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [reference]);

  const handleEvent = (event: CheckoutEvent) => {
    switch (event.type) {
      case 'status':
        setPayment(event.payment as EnrichedPayment);
        postToParent({
          source: 'flarehq-checkout',
          type: 'status',
          reference: reference!,
          status: event.payment.status,
        });
        break;
      case 'payment_success':
        setHasError(false);
        setPayment(event.payment as EnrichedPayment);
        postToParent({
          source: 'flarehq-checkout',
          type: 'payment_success',
          reference: reference!,
          status: event.payment.status,
          txHash: (event.payment as EnrichedPayment).arcTxHash ?? null,
        });
        break;
      case 'payment_error':
        setHasError(true);
        setErrorMessage(event.error);
        postToParent({
          source: 'flarehq-checkout',
          type: 'payment_error',
          reference: reference!,
          message: event.error,
        });
        break;
      // wallet_connected / payment_pending: no dedicated embed message —
      // the 'status' message above already covers state transitions a
      // parent page would reasonably want to react to. Adding a message
      // per internal widget event would leak implementation detail into
      // the public embed contract for no real integration benefit.
      default:
        break;
    }
  };

  if (!reference) return null;

  return (
    <div
      ref={containerRef}
      style={{
        minHeight: '100vh',
        background: 'transparent', // let the host page's iframe background show through if they style it
        color: '#f0ece6',
        fontFamily: 'Inter, system-ui, sans-serif',
        padding: 16,
      }}
    >
      {!payment && hasError && (
        <CheckoutError reference={reference} message={errorMessage} />
      )}

      {!payment && !hasError && <CheckoutLoading reference={reference} />}

      {payment && isPaymentExpired(payment) && (
        <CheckoutExpired
          reference={payment.reference}
          amount={payment.amount}
          currency={payment.currency}
          merchantName={payment.merchant_username ? `@${payment.merchant_username}` : payment.merchant}
          expiresAt={payment.expiresAt}
        />
      )}

      {payment && !isPaymentExpired(payment) && payment.status === 'SUCCESS' && (
        <CheckoutAlreadyPaid
          reference={payment.reference}
          amount={payment.amount}
          currency={payment.currency}
          merchantName={payment.merchant_username ? `@${payment.merchant_username}` : payment.merchant}
          transactionHash={payment.arcTxHash}
        />
      )}

      {payment && !isPaymentExpired(payment) && payment.status !== 'SUCCESS' && (
        <CheckoutWidget reference={reference} onEvent={handleEvent} />
      )}

      <p
        style={{
          textAlign: 'center',
          fontSize: 10,
          color: '#4b4035',
          marginTop: 16,
          fontFamily: 'monospace',
          letterSpacing: 0.5,
        }}
      >
        Secured by FlareHQ
      </p>
    </div>
  );
}

/*
 * ---- CSP / framing: handled in next.config.mjs, NOT middleware ----
 *
 * This repo has no middleware.ts. Framing policy is set declaratively via
 * the `headers()` config in next.config.mjs:
 *
 *   - Catch-all `/:path*`                    -> Content-Security-Policy:
 *     frame-ancestors 'none'  (site-wide clickjacking lockdown)
 *   - `/checkout/embed/:reference*`          -> Content-Security-Policy:
 *     frame-ancestors *      (this route only; listed after the catch-all
 *     and more specific, so it wins for the shared header key)
 *
 * X-Frame-Options is deliberately absent site-wide: frame-ancestors
 * supersedes it in every browser that matters, and mixing the two risks
 * conflicting behavior in older browsers. Do not add X-Frame-Options here
 * or globally without also revisiting that trade-off.
 *
 * If you later want embedding restricted to specific merchant-registered
 * domains rather than any site, that needs the merchant's allowed
 * origin(s) stored server-side and enforced in next.config.mjs (or a real
 * middleware) — flagging as a deliberate scope decision, not implemented
 * since no such registration flow currently exists.
 */
