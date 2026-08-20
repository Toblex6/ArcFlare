// src/lib/telegram/webhookDedupe.ts
//
// update_id dedupe for the Telegram webhook (H6). Telegram redelivers
// undelivered updates (same update_id) until the webhook responds 200. The
// command handlers are already idempotent (withdrawal intents carry an atomic
// PENDING→EXECUTING claim), but skipping a duplicate update entirely saves a
// handler round-trip per retry. Bounded: at most MAX_SEEN_UPDATES ids are
// remembered, oldest dropped first.
//
// Kept OUT of the route module on purpose: Next.js route modules may only
// export HTTP verbs/config, and the bot handlers import this too.

const MAX_SEEN_UPDATES = 500;
const seenUpdateIds = new Set<number>();

/** Returns true if this update_id was already handled. */
export function trackUpdate(updateId: number): boolean {
  if (seenUpdateIds.has(updateId)) return true;
  seenUpdateIds.add(updateId);
  if (seenUpdateIds.size > MAX_SEEN_UPDATES) {
    const oldest = seenUpdateIds.values().next().value;
    if (oldest !== undefined) seenUpdateIds.delete(oldest);
  }
  return false;
}