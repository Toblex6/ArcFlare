// src/app/checkout/embed/[reference]/page.tsx
//
// Standalone, iframe-sized checkout — no page chrome. Merchants embed this
// via <script src="/embed.js"> (see public/embed.js), which creates an
// iframe pointing here and listens for postMessage events to auto-resize
// and relay lifecycle events (payment_success, etc.) back to the host page.
//
// This route is the one exception to the site-wide frame-ancestors lockdown
// added in next.config.mjs — every other page now blocks framing entirely.

'use client';

import React, { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import CheckoutWidget, { CheckoutEvent } from '@/src/components/CheckoutWidget';

export default function EmbeddedCheckoutPage() {
    const params = useParams<{ reference: string }>();
    const reference = params?.reference;
    const containerRef = useRef<HTMLDivElement>(null);

    const postToParent = (message: Record<string, unknown>) => {
        // Wildcard targetOrigin is deliberate here — the embedding merchant's
        // domain is unknown ahead of time, and this channel only ever carries
        // non-sensitive UI lifecycle events (never wallet keys or auth tokens),
        // so there's nothing meaningful for another origin to intercept.
        window.parent.postMessage({ source: 'flarehq-checkout', reference, ...message }, '*');
    };

    const handleEvent = (event: CheckoutEvent) => {
        postToParent({ event: event.type, payload: event });
    };

    // Auto-resize: tell the parent our actual content height whenever it
    // changes, so embed.js can size the iframe without a fixed/guessed height.
    useEffect(() => {
        if (!containerRef.current) return;
        const el = containerRef.current;
        const observer = new ResizeObserver(() => {
            postToParent({ event: 'resize', height: el.scrollHeight });
        });
        observer.observe(el);
        return () => observer.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!reference) return null;

    return (
        <div
            ref={containerRef}
            style={{
                background: 'transparent',
                minHeight: '100vh',
                display: 'flex',
                justifyContent: 'center',
                padding: 12,
                boxSizing: 'border-box',
            }}
        >
            <CheckoutWidget reference={reference} compact onEvent={handleEvent} />
        </div>
    );
}
