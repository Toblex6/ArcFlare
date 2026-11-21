// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { filterPrivateEvent, scrubTelemetry } from './lib/telemetryPrivacy';

Sentry.init({
  dsn: 'https://1121094283fc82599991834a35e7a6eb@o4511528675377152.ingest.us.sentry.io/4511528675704832',

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,
  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: false,
  beforeSend: filterPrivateEvent,
  beforeSendTransaction: filterPrivateEvent,
  beforeSendSpan: scrubTelemetry,
  beforeBreadcrumb: scrubTelemetry,
  beforeSendLog: scrubTelemetry,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
