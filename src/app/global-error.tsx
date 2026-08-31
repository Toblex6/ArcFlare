'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#0e0b08', color: '#f0ece6', fontFamily: 'Inter, system-ui, sans-serif' }}>
          <div style={{ maxWidth: 480, width: '100%', background: '#1a1410', border: '1px solid #2d2015', borderRadius: 16, padding: 24, textAlign: 'center' }}>
            <p style={{ fontWeight: 700, fontSize: 16, margin: '0 0 8px' }}>Something went wrong</p>
            <p style={{ fontSize: 13, color: '#a89985', margin: '0 0 16px', lineHeight: 1.5 }}>
              We couldn&apos;t load this page. Please refresh or try again. If the problem continues, contact support.
            </p>
            <button onClick={() => window.location.reload()} style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#c8975a', color: '#0e0b08', fontWeight: 700, cursor: 'pointer' }}>
              Refresh page
            </button>
            {/* Keep NextError for statusCode semantics but hidden from non-technical view */}
            <div style={{ display: 'none' }}>
              <NextError statusCode={0} />
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
