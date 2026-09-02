
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Full history

Dated batch-by-batch audit/build findings live in `docs/AGENTS_ARCHIVE.md` — not auto-loaded, read on demand when investigating something that might be a known issue.

## Build / test commands

- `npx tsc --noEmit` — typecheck, must be clean before any commit
- `next build` — full build check
- E2E suites live in `scripts/*.ts` / `scripts/*.mjs` — run the ones relevant to the area touched (e.g. `payroll-e2e.ts`, `checkout-e2e.ts`, `escrow-beneficiary-e2e.mjs`); do not assume a green suite unless you ran it yourself against the current repo

## Critical, still-active invariants

- **RPC**: primary is `https://rpc.testnet.arc.network`. Cluster is intermittently flaky (TLS bad-record-MAC, ECONNRESET, nodes ~16 blocks out of sync) on ALL endpoints — retry, don't assume failure. Alternates: `rpc.testnet.arc.io`, `rpc.blockdaemon.testnet.arc.io`, `rpc.drpc.testnet.arc.io`.
- **Fees**: native `value`-sends are fee-free (cost = amount + gas only) — always prefer this for EOA→EOA. ERC-20 `transfer`/`approve`/`transferFrom` incurs a per-DESTINATION fee (~0.001 EOA→EOA, ~0.2% EOA→contract, ~12% into payroll as sender) — do not assume payroll or other contracts are fee-exempt as sender. EURC is fee-free everywhere measured. Re-verify all fee assumptions on mainnet before trusting escrow/payroll math.
- **Native vs ERC-20 balance views** are the same asset at different decimals (18 vs 6) — always compare at a FIXED blockTag; apparent divergence is almost always a measurement artifact, not a bug.
- **`verifyCallerControlsAddress`** is the single ownership-control gate used everywhere. Any new fund-moving or identity-sensitive route must call it and null-check the result before proceeding. Do not introduce a second/local ownership-check helper.
- **No default-payer fallbacks.** Any route resolving a payer wallet must resolve it explicitly (consumer/merchant/agent-bound wallet) and refuse (400/403) rather than fall back to a shared default wallet. This was the root cause of multiple past fund-drain vulnerabilities (scheduled/run, nano/settle) — do not reintroduce an `||`-style or assignment-default fallback to a shared wallet.
- **Agent identifiers are NOT interchangeable**: `AgentRegistry.id` (small int, used by ledger/track-record), `tokenId` (ERC-8004 big int, used by reputation/validation), `scaAddress` (on-chain wallet). Any new agent-lookup endpoint should accept all three via `findFirst({ OR: [...] })`, not assume one.
- **Job creation has two backends**: the legacy Direct Hire wizard (`POST /api/jobs`) and the registry/procurement path (`agents/[id]/hire`, `/api/procurement`). Only the latter is validated, notifies the provider, and is read by later job machinery (accept/fund/complete). Do not add new job-hiring features to the Direct Hire wizard path without also fixing its lack of provider validation/notification — see architecture note in `docs/AGENTS_ARCHIVE.md` (Human-Worker Hiring Loop batch) before extending it.
- **Escrow beneficiary is first-class**: classify into merchant/consumer/agent/external at creation (`resolveBeneficiary.ts`), never assume the depositor and beneficiary are the same party.
- **Known migration drift (unresolved, verify before prod deploy reading `.env`)**: `20260901170000_escrow_beneficiary_fields` has a second failed migration record on both Neon dev and the Render legacy DB; `prisma migrate deploy` reports "no pending" on both, but the Render DB may not actually have the columns. Check `information_schema.columns` before trusting `Escrow.beneficiaryKind`/`beneficiaryNotifiedAt` in any prod-reading context.
- **Do not modify `withGateway()`** in `src/lib/x402.ts`.
- **x402 requires EOA wallets** — Circle SCAs cannot be x402 payers.
- **WalletConnect must remain browser-only** (indexedDB).
- **`merchant_token`, `consumer_token`, `admin_token`** are separate JWT cookie auth systems — do not conflate.
- **Checkout is non-custodial** — customer pays directly to merchant wallet; FlareHQ never holds funds.
- **`(prisma as any)` patterns are intentional** — not a type-safety gap to "fix."
- **Explorer API caps `tokentx` at 24 rows** — use native tx lists for reconciliation, not the token-transfer feed.
- **Arc explorer does not support contract verification** — flatten source before any external verification claim.
- **Known unrecoverable testnet loss**: ~0.554 USDC stranded at `0xa8d1d913...` (no private key exists) — accepted, do not attempt recovery or pay to that address again.
