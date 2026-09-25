
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
- **Database: Neon is the only production database** (`ep-tiny-sunset-ah95b1ic.c-3.us-east-1.aws.neon.tech`). The legacy Render Postgres (`dpg-d8diik6q1p3s73bkpn9g.oregon-postgres.render.com`, database `flarehq_db`) is DEAD/DEPRECATED — never point `DATABASE_URL` at it, never fall back to it. Keep exactly ONE `DATABASE_URL` line (dotenv silently wins the FIRST duplicate). The old `20260901170000_escrow_beneficiary_fields` drift warning is retired — verified 2026-09-14 on Neon: both `Escrow` columns present, migration row finished, `migrate deploy` clean.
- **Do not modify `withGateway()`** in `src/lib/x402.ts`.
- **x402 requires EOA wallets** — Circle SCAs cannot be x402 payers.
- **WalletConnect must remain browser-only** (indexedDB).
- **`merchant_token`, `consumer_token`, `admin_token`** are separate JWT cookie auth systems — do not conflate.
- **Checkout is non-custodial** — customer pays directly to merchant wallet; FlareHQ never holds funds.
- **`(prisma as any)` patterns are intentional** — not a type-safety gap to "fix."
- **Explorer API caps `tokentx` at 24 rows** — use native tx lists for reconciliation, not the token-transfer feed.
- **Arc explorer does not support contract verification** — flatten source before any external verification claim.
- **Known unrecoverable testnet loss**: ~0.554 USDC stranded at `0xa8d1d913...` (no private key exists) — accepted, do not attempt recovery or pay to that address again.

## Product architecture

- **ArcFlare / FlareHQ is a non-custodial agent-commerce layer on Arc Testnet (chain `5042002`)**: an agent marketplace + job lifecycle (hire → accept → fund → submit → complete), escrow with first-class beneficiaries, checkout where the customer pays the merchant wallet directly, x402-metered APIs via `withGateway()`, payroll / nano scheduled payroll / streaming, and CCTP-V2 cross-chain (legacy bridge paths are explicitly USDC-only).
- **Payment Routing v1 (canonical path)**: one pool, one router, one hop, USDC/EURC only (`src/lib/routing/canonical.ts`, `quoter.ts`, `quoteMath.ts`, `verifier.ts`). The client supplies only `{ reference, payTokenSymbol }`; settlement token, amount, recipient (`merchantSCA`), pool, reserves, math, expiry, and hash are all server-determined from the frozen `PaymentLog` invoice row. Swap providers (`tower`, `unitflow-v3`) are **not** wired into `/api/payments/quote` — canonical behavior is unchanged while their flags are off.
- **Agent identity**: ERC-8004 registry (`0x3500000000000000000000000000000000008004`) for verification/reputation; ERC-8183 `AgenticCommerce` contract for the job lifecycle (testnet pin `0x0747EEf0706327138c69792bF28Cd525089e4583`, but production code must resolve `getNetworkConfig().erc8183Address` — never the static pin). Registry `id`, ERC-8004 `tokenId`, and `scaAddress` are three distinct identifiers (see invariants above).
- **Human on-ramp**: Telegram workers are `ConsumerAccount` rows with `telegramUserId` on the same `consumer_token` JWT system as web consumers (not a separate auth boundary). Semantic `job<N>` ids, quoted pitches, `/accept`, `/deliver`, `/withdraw` + `/confirm` `/cancel` (15-min `TelegramWithdrawalIntent`), `/balance`, `/history`.
- **Wallets**: Circle Developer-Controlled (MPC) wallets for merchants/consumers/agents; per-agent x402 payment EOAs for A2A (`X402EoaWallet`, AES-GCM at rest, auto-provisioned via `GET /api/agents/[id]/wallet`); A2A payments are direct on-chain native value-sends under `ArcFlareSpendLimit`, not Gateway-mediated.

## Provider architecture (Tower + UnitFlow V3)

- **Location**: `src/lib/routing/providers/` — `types.ts` (interfaces only), `registry.ts` (fail-closed venue registry), `normalize.ts` (pure untrusted→canonical quote normalization), `tower.ts` (Tower quote client), `unitflowV3.ts` (UnitFlow V3 unsigned execution + pure verification). Deployment family lives **only** in `src/lib/config/unitflow.ts` and is consumed atomically — no address copies anywhere else.
- **Venues** (`SwapVenueId`): `canonical` (the live pool/router path in `../quoter.ts` — the registry holds only a non-pricing stub pointing at it), `tower`, `unitflow-v3` (`KNOWN_VENUE_IDS`, that order). Registering an unknown venue id throws; `getActiveProviders()` returns enabled venues only, canonical first; `selectProvider()` throws on unknown/unregistered/disabled.
- **Flags (default-off except canonical)**: `tower` → `ROUTING_PROVIDER_TOWER_ENABLED=1|true`; `unitflow-v3` → `ROUTING_PROVIDER_UNITFLOW_V3_ENABLED=1|true`. Canonical is always enabled. Nothing in the quote/verify-onchain routes may select a disabled venue.
- **Tower is quote-only, server-only**: needs `TOWER_SWAP_API_KEY` (fails closed without it), `TOWER_SWAP_BASE_URL` must be https (default `https://www.tower.exchange`); importing it in a browser bundle throws. Allowed endpoints: `GET /api/public/swap/dexes`, `POST /api/public/swap/quote`. `build-tx` / transaction creation / wallet interaction are explicitly forbidden in this phase. All Tower token/amount fields are untrusted and parsed through `normalize.ts`.
- **UnitFlow V3 is execution-only in this phase**: `quote()` stays `NOT_IMPLEMENTED`; `buildUnitFlowV3Execution()` performs its own live Factory/Quoter validation and binds the result into an unsigned envelope; `verifyUnitFlowExecution()` is a pure evidence verifier. Neither is wired into `/api/payments/quote` or verify-onchain routes yet (invoice↔quote binding deferred — see `adc85ff` body). `buildExecution` never signs or broadcasts; the recipient is always the frozen `merchantSCA`; `execute()` value is always 0 (USDC-leg wrapping is a separate unsigned `WUSDC.deposit{value}` step, never a router-internal wrap command).
- **Phase-1 boundary marker**: `UnsignedExecution = { venueId, phase: 'phase-2-only' }` is intentionally unconstructible outside a Phase-2 builder; provider `buildExecution`/`verifyExecution` stubs must throw `NOT_IMPLEMENTED` until their phase lands (Tower execution still does).

## Security invariants (supplementary provider-work rules — the Critical list above stays authoritative, this section does not replace or reorganize it)

- **Single ownership gate**: `verifyCallerControlsAddress` + null-check before any fund-moving or identity-sensitive logic. No second/local ownership helper. New agent-lookup endpoints accept id/tokenId/SCA via `findFirst({ OR: [...] })`; canonical-ID + caller-control endpoints (`policy`, `wallet`, `pay`, `treasury`, `treasury/credit`) stay id-only — accepting tokenId/SCA there would be an auth risk, not an improvement.
- **No silent fallback, ever**: no default-payer `||` fallback; mainnet config never inherits testnet values; UnitFlow never falls back to the dead alternate README deployment set; no silent decimals coercion (provider decimals mismatch is rejected); expired/stale quotes, foreign routers/pools, and client-supplied amounts/tokens/pools/routes can never satisfy an invoice.
- **`withGateway()` frozen** (`src/lib/x402.ts`) — x402 settles before the handler runs; fix callers, not the gateway. x402 payers must be EOAs.
- **Server-resolved over client-supplied**: token identity via `supportedTokens.ts` / network config only; quote recipient is the frozen invoice `merchantSCA`; treasury-credit destination is server-derived from `agent.scaAddress` (body carries only `amountUSDC`); UnitFlow `expectedPayer`, when bound, must be a valid 0x address distinct from the merchant recipient.
- **Single authorities**: network topology/addresses → `src/lib/config/network.ts`; UnitFlow family → `src/lib/config/unitflow.ts` (`getUnitFlowV3Deployment` + `assertUnitFlowDeploymentComplete`); token addresses/decimals → `supportedTokens.ts`; ERC-8183 pin → `src/lib/contracts/erc8183.ts` consumed **only** by `network.ts` (production paths use `getNetworkConfig().erc8183Address`; the `erc8183-config-drift` test fails any inline literal elsewhere). Legacy `AGENTIC_COMMERCE_CONTRACT` / `ARC_USDC_ADDRESS` env overrides are intentionally **not** honored.
- **Tower secret hygiene**: `TOWER_SWAP_API_KEY` is server-only; Tower responses are untrusted input until `normalizeProviderQuote` accepts them.

## Token / decimal rules

- **Canonical books are 6-decimal bigint base units** for USDC and EURC on Arc. USDC = ERC-20 interface `0x3600000000000000000000000000000000000000` (6-dec view over the 18-dec native gas asset); EURC = `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` (6 decimals, both verified on-chain). Resolve via `getTokenBySymbol` / `getTokenByAddress` — never hardcode, never trust a provider's address claim.
- **Fee reality (testnet-measured, re-verify on mainnet)**: native `value`-sends fee-free; ERC-20 `transfer`/`approve`/`transferFrom` fee is per-destination; EURC fee-free everywhere measured.
- **Provider normalization rejects, never coerces**: `normalizeProviderQuote` throws on unknown venue/token, non-integer/non-positive amounts, or any decimals claim ≠ 6. Tower's docs example annotating EURC output as "(18 decimals)" is wrong for Arc — canonical 6 is authoritative, and Tower execution use must re-verify the live unit convention first.
- **UnitFlow swap-leg exception (the only place 18-dec appears)**: pools are WUSDC-denominated. WUSDC `0x911b4000D3422F482F4062a913885f7b035382Df` is 18-dec, WETH9-style (`deposit()`/`withdraw(uint256)` verified in bytecode). `toSwapUnits`: USDC canonical × `1e12` → swap units; EURC unchanged. The direct `0x3600…`/EURC fee-100 pool exists but has **zero liquidity and the Quoter reverts on it — never use it**. Fee tiers `[100, 500, 3000, 10000]`, default `100`; any other tier is accepted only after live `getPool` + `liquidity` + `token0`/`token1` + `quoteExactInputSingle` validation bound into the envelope. Slippage floors reuse `quoteMath.discountForSlippage` with the canonical out-fee buffer rescaled to swap-leg decimals (USDC `5000n`, EURC `1000n` base units).

## Protected architecture (do not refactor without a reviewed plan)

- **Frozen / single-authority modules**: `src/lib/x402.ts` (`withGateway`, challenge builder shared with payroll fund); `src/lib/config/network.ts` (authoritative Arc network config, client-safe, no secrets); `src/lib/config/unitflow.ts` (atomic V3 family, no second network switch — reuses `getArcNetworkName()`); `src/lib/contracts/erc8183.ts` (pure constants/ABI; testnet pin consumed only by `network.ts`); `src/lib/routing/canonical.ts` + `quoter.ts` + `quoteMath.ts` + `verifier.ts` (canonical routing untouched by provider work); `src/lib/tokens/supportedTokens.ts` (token registry); `src/lib/routing/providers/*` boundary files (types/registry/normalize rule-comments are load-bearing).
- **Untouchable behaviors**: canonical quoting still lives in `quoter.ts` (`requestQuote`); the registry's canonical stub never prices; `PaymentLog` rows are frozen at creation (invoices only); `PaymentRouter` / escrow / `PaymentLog` schema unchanged by UnitFlow Phase 2 (`adc85ff`).
- **Not the same thing**: `POST /api/protected-service` is a legacy demo 402 route ("FlareHQ Gateway Rails", `X-FlareHQ-Reference` header) — it is **not** the Circle x402 `withGateway()` path. Do not conflate them, and do not "unify" them without a plan.
- **Browser-only**: WalletConnect (indexedDB). Tower client is server-only (throws on `window`).

## Git rules

- **Branch / remote**: `origin` = `https://github.com/Toblex6/ArcFlare.git`. Active work branch for this line is `unitflow-phase2` — confirm branch before committing; never push to another branch by accident.
- **Message format** (as actually used in this repo): `<type>(<scope>): <subject>` + bullet body. Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`. Scopes seen: `unitflow`, `routing`, `config`, `payments`, `agents`, `jobs`, `consumer`, `ui`, `cleanup`, `security`. Bodies explain *what changed + what was proven* (suite counts, tx hashes, explicit non-goals like "No wiring into quote/verify-onchain routes yet").
- **Pre-commit gate**: `npx tsc --noEmit` clean is mandatory; `next build` for full check; run the suites for the area touched and quote real results in the message — never claim green you didn't run on the current tree.
- **No commits on request of "show diff first"**: when review is asked for, paste the diff + resulting files and stop. Do not amend, rebase, or rewrite pushed history to "clean up" without explicit instruction.

## Testing / verification (extended — the Build/test-commands block above is the gate)

- **Gates**: `npx tsc --noEmit` (0 errors required) → `next build` (`package.json` build runs `prisma generate && prisma migrate deploy && next build --webpack`) → area suites. Static drift suites are cheap and run first when touching money paths: `node --test tests/erc8183-config-drift.test.mjs`, `npx tsx --test tests/network-centralization.test.mjs`, `npx tsx --test tests/network-config.test.mjs`.
- **Routing / provider suites**: `npx tsx scripts/routing-providers-tests.ts` (registry + normalize + Tower static + UnitFlow config); `npx tsx scripts/unitflow-execution-tests.ts` (**34/34** pure-mocked: 21-case `verifyUnitFlowExecution` negative matrix + happy-path decoding + atomic-config + fail-closed build args — no RPC, DB, funds, or network).
- **Live E2E (funds move — tiny amounts, controlled wallets only)**: `npx tsx scripts/unitflow-e2e-usdc-eurc.ts` needs `ARC_TESTNET_RPC`, `RELAYER_PRIVATE_KEY` (payer/signer `0x03ba…`, rotated 2026-09-18 after the `0x0d9D…` key compromise — old address retained no authority), `SELLER_ADDRESS` (merchant `0xc119bb61…`, no key — recipient never signs). Amount is 0.01 USDC; never raise it without review. RPC flakes are environmental — retry across the primary + alternates before calling a failure real.
- **Verifier contracts**: canonical routed settlement is valid iff **one** `PaymentRouted` event proves all 10 checks simultaneously (canonical router, exact tokenIn/amountIn/tokenOut/canonical pool/frozen `merchantSCA`, recipient credit ≥ `minOutputAmount`, within quote expiry, live quote state, real third-party payer). UnitFlow verification is evidence-based too: decoding + balance-decrease + dead-router + non-zero-value guards over the 21-case matrix — arbitrary transfers, foreign-router events, or client-supplied amounts can never satisfy it.
- **Resolver / never-throws**: `resolveAgentRef` explicit-id path is bounded to int4 range; overflow returns clean not-found, never a Prisma throw (`scripts/agent-resolver-tests.ts` 24/0).

## UnitFlow known deployment (Arc Testnet, verified live 2026-09-12)

- **Family (use atomically via `getUnitFlowV3Deployment`; never mix)**: factory `0xAb6A8AAb7d490007634ef59d424b5d89688a1971`, quoter `0x121aeB6DEf00F6F67665008CaC1C19805886ed1a`, universalRouter `0xEaF3195bE51861632cd32850973C9515DA48e76F`, permit2 `0x4ce562F687d0Ced27b79Ba51d79B63BD978F7F48`, WUSDC `0x911b4000D3422F482F4062a913885f7b035382Df`, chain `5042002`. Sources: `docs.unitflow.finance/docs/dev/contracts`, `/docs/versions/v3`, `/docs/dev/universal-router`.
- **Live evidence**: `Factory.getPool(WUSDC, EURC, 100)` → `0xe8f7fA2A412e98C537554643F83DA34DfdD50c23` (liquidity ~1.7e17); `Quoter.quoteExactInputSingle(WUSDC, EURC, 100, 1e16, 0)` → 8037 (best of the 0.01 probe vs 8008/8012 on other tiers); Gate C mined `execute(bytes,bytes[],uint256)` tx `0xf23751f0…` (single command `0x00` `V3_SWAP_EXACT_IN`, 5-param tuple `recipient/amountIn/amountOutMinimum/path/payerIsUser=true`, recipient = arbitrary merchant EOA, `value` = 0, payer pulled via Permit2 — approve/allowance selectors verified in deployed bytecode).
- **Dead set (never reference)**: the alternate Factory/Quoter deployment published in the old UnitFlowV3-contract repo README has no relevant pools/liquidity — proven dead. Any evidence carrying those addresses (or a pool derived from the dead factory) fails as foreign. `mainnet` requires all `UNITFLOW_MAINNET_*` env inputs and fails closed without them — testnet values are never inherited.

## UX terminology (use these words; don't invent synonyms)

- **Identifiers**: three labeled rows — Registry ID vs ERC-8004 token ID vs SCA wallet. Never merge them into one "agent id".
- **Trust/economics**: render a trust or reputation score **only** when the backend supplied it — never a fabricated default. Pricing is per-request/per-job from the existing JSON with micro-USDC volume strings; who-pays-what is stated before the action.
- **Actions**: `deriveAgentAction` — `hire` only when serviceable (`ACTIVE_AGENT_PROVISIONED`) **and** the caller controls a Circle wallet; otherwise `signin` / `wallet-required` / `unavailable` with the honest reason. Same-token payments say "pay the settlement token directly; no conversion needed."
- **Money display**: amounts are 6-dec USDC strings (`"2"` → `"2.000000"` = 2 USDC) with a live preview ("Will be posted as 2.00 USDC"). Checkout copy stays non-custodial ("customer pays directly to merchant wallet; FlareHQ never holds funds"). Faucet affordance is labeled "Get Test Tokens" (Circle faucet).
- **Telegram voice**: quoted pitches, `job<N>` ids, "wallet never comes up until you withdraw"; new workers "start neutral (20/40)" where scored.

## Implementation principles

- **Fail closed, then prove it**: every new path throws typed errors (`routingError` with status) on unknown/disabled/missing/expired/foreign input, and every failure mode gets a negative-matrix case before it ships.
- **Server-resolved, never client-trusted**: symbols in, addresses/decimals/amounts/recipients/pools/routes out — via network config, token registry, frozen invoice rows, and live on-chain reads.
- **One authority per fact**: one network config, one token registry, one ERC-8183 pin (consumed once), one ownership gate, one deployment family object, one slippage formula (`quoteMath`). A second copy of any of these is a bug.
- **Pure where possible**: normalization, quote math, receipt analysis, and execution verification are pure functions over injected data — no RPC/DB/wallet inside — so the adversarial cases run without funds.
- **Evidence over assertion**: mined receipts, balance deltas at fixed blocks, decoded commands/paths, and bound envelope identities — not log lines or local state — decide whether money moved correctly.
- **Minimal, atomic diffs**: provider work touches provider files + its config + its scripts; canonical routing, `x402.ts`, `PaymentLog` schema, escrow, and `PaymentRouter` stay untouched unless the commit body says otherwise and proves the regression suite.
