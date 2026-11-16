# Mainnet platform-fee readiness — 2026-11-16

Status: **NEEDS-OWNER to identify the original payment and its deferral reason.**

The original 0.01-USDC payment's `PlatformFee.deferredReason` has not been recovered. Approved-wallet read-only queries against the available Neon database found no matching merchant or payment. This is not evidence that production uses the same configuration or database.

## Verified offline

`npx tsx --test tests/platform-fee-state-machine.test.mjs` passes **24/24** checks against the actual exported `settlePlatformFeeOnce` engine and its Prisma adapter with in-memory ports. Live fetch, the actual Prisma transaction, and fee delegate writes are blocked.

- At 25 bps, 0.01 USDC rounds to **25 micro-USDC** (0.000025 USDC), not zero. The deployed fee rate and original decision remain unknown.
- Fresh concurrent claims create one fee row and one transfer in the fixture; the adapter claims through the transaction-bound delegate and advisory lock.
- Claim precedes transfer and `circleTxId` anchoring precedes polling.
- Successful replay skips. Each caller-supplied deferral reason is preserved; an existing `DEFERRED` row returns `skipped/already-deferred`, even if the next decision is `collect`.
- Unknown finality keeps the tracked transfer for polling. A terminal failure clears the anchor; a **serial** retry reuses the key. Unexpected tracked states resume instead of blindly creating.
- The engine has no PaymentLog write authority. Measurement failure does not reverse a settled fee outcome.

No fee lifecycle, checkout, schema, configuration, or production data was changed. The older `scripts/platform-fee-tests.mjs` duplicates historical branching and is not the proof used here. `scripts/payment-hardening-tests.ts` was **not run**: it creates database fixtures and deletes old `HARDEN-` rows.

## Unchanged limitations

The engine documents the create-to-anchor crash window and the Circle ARC endpoint's rejection of client idempotency keys. The new checks do not prove concurrent stale/terminal takeovers or close that crash window. Database-backed contention, actual Circle settlement, and measured treasury credit remain unverified.

## Owner investigation

1. Identify the original payment reference or transaction hash in the production merchant dashboard. Privately confirm the deployed database is the approved Neon instance and the wallet binding is the intended merchant.
2. Read the corresponding `PaymentLog` and `PlatformFee` rows, including status, `deferredReason`, charged/received amounts, tracked Circle ID, and transaction hash. Do not infer the reason from the displayed `DEFERRED` label.
3. Reconcile the receipt, merchant credit, collector credit, and explorer at fixed blocks. Verify the configured fee rate and collector, Circle wallet binding, balance, and sponsorship policy.
4. Do not manually re-debit a deferred or unknown-finality fee during this readiness run. Any remediation must first establish whether a live or already-landed transfer exists and receive separate review.
