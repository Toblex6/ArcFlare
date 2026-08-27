'use client';

// src/components/checkout/usePaymentVerify.ts
//
// Page-level bootstrap fetch of GET /api/payments/verify/[reference].
//
// WHY THIS EXISTS: the checkout state machines render <CheckoutLoading>
// until `payment` is non-null, but `payment` used to arrive ONLY via
// CheckoutWidget events — and the widget is mounted *after* payment loads.
// Deadlock: nothing ever fetched, page spun forever (regression from the
// 212e156 state-component refactor). This hook gives each page its own
// initial resolve with a hard timeout, so:
//   - unknown/expired references -> honest full-page error
//   - network hangs -> error after 15s instead of an infinite spinner
//   - PENDING payments render the widget immediately
//
// The widget still does its own fetch internally (idempotent GET); this
// hook exists purely so page-level state can never depend on a component
// that isn't mounted yet.

import { useEffect, useState } from 'react';
import type { PaymentLogData } from '@/src/components/CheckoutWidget';

export interface EnrichedPayment extends PaymentLogData {
    issuedAt?: string | null;
    settledAt?: string | null;
    expiresAt?: string | null;
}

const VERIFY_TIMEOUT_MS = 15_000;

export function usePaymentVerify(reference: string | undefined) {
    const [payment, setPayment] = useState<EnrichedPayment | null>(null);
    const [hasError, setHasError] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    useEffect(() => {
        if (!reference) return;
        let cancelled = false;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

        (async () => {
            try {
                const res = await fetch(`/api/payments/verify/${reference}`, { signal: controller.signal });
                const result = await res.json().catch(() => null);
                if (cancelled) return;
                if (result && result.status === true && result.data) {
                    setPayment(result.data);
                } else {
                    setHasError(true);
                    setErrorMessage(
                        (result && result.message) ||
                        'This payment reference could not be found. Double-check the link you were sent.'
                    );
                }
            } catch {
                if (!cancelled) {
                    setHasError(true);
                    setErrorMessage(
                        'Could not reach FlareHQ to load this payment. Check your connection and refresh the page.'
                    );
                }
            } finally {
                clearTimeout(timeout);
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
            clearTimeout(timeout);
        };
    }, [reference]);

    return { payment, setPayment, hasError, setHasError, errorMessage, setErrorMessage };
}
