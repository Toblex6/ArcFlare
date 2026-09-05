// src/lib/validation/inboxOnChainReader.ts
//
// On-chain reader seam for the Validator Inbox route.
//
// The inbox route (src/app/api/agent/validation/inbox/route.ts) reads an
// on-chain status mirror per requestHash. Hermetic tests swap that RPC-backed
// reader for a mock so they need no testnet connection.
//
// This seam lives in a plain lib module — NOT in the route file — because
// Next.js route modules may only export HTTP verbs / route config; an extra
// export (the old __setInboxOnChainReaderForTests) broke route typegen and
// failed `next build`. Relocating the mutable reader here keeps the same
// live-binding semantics: the route reads `inboxOnChainReader` at call time,
// tests set it via `setInboxOnChainReaderForTests`, and production callers
// never touch the setter.

import { getOnChainValidationStatus } from "@/lib/jobs/jobValidationPolicy";

export type InboxOnChainReader = typeof getOnChainValidationStatus;

export let inboxOnChainReader: InboxOnChainReader = getOnChainValidationStatus;

export function setInboxOnChainReaderForTests(fn: InboxOnChainReader): void {
  inboxOnChainReader = fn;
}
