import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { getArcNetworkName } from '@/lib/config/network';

export const dynamic = 'force-dynamic';

class SentryExampleAPIError extends Error {
  constructor(message: string | undefined) {
    super(message);
    this.name = 'SentryExampleAPIError';
  }
}

// Production gate: the Sentry template's intentionally-faulty demo route
// stays available in dev/testnet but refuses on production mainnet so it
// can never be used to spam the production Sentry project.
function demoRouteBlocked(): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  try {
    return getArcNetworkName() === 'mainnet';
  } catch {
    return true;
  }
}

// A faulty API route to test Sentry's error monitoring
export function GET() {
  if (demoRouteBlocked()) {
    return NextResponse.json(
      { success: false, error: 'Demo route disabled in production.' },
      { status: 404 }
    );
  }
  Sentry.logger.info('Sentry example API called');
  throw new SentryExampleAPIError(
    'This error is raised on the backend called by the example page.'
  );
}
