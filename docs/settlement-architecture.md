# Settlement Architecture (as-built, 2026-08-18)

This document describes the settlement architecture as it EXISTS in the live
code today. It is not an aspirational design: every boundary below was
verified against `src/` at the time of writing. Where a past assumption
turned out wrong, it is called out explicitly.

## 1. PaymentLog is the source of truth for payment lifecycle

`prisma.schema.prisma` → `model PaymentLog` (`reference` is unique). Every
product flow that moves money records a PaymentLog row:

| Writer | Flow |
| --- | --- |
| `src/lib/x402.ts` (`withGateway`) | x402 middleware: marketplace `/api/x402/marketplace/pay/[slug]`, agent brain `/api/agent/brain`, nanopayments `/api/nano/pay/[endpoint]` |
| `src/lib/payroll/payrollExecution.ts` | payroll funding via `fundPayrollViaX402` (`/api/payroll/fund`) |
| `src/app/api/payments/initialize` + `settle` | merchant payment links / checkout |
| `src/app/api/payments/detect`, `payments/nano/settle`, `merchant/payment-link`, `agent-data`, `webhooks/circle` | direct settlement + webhook reconciliation |

Key lifecycle fields: `status` (PENDING → SUCCESS / SETTLEMENT_ERROR / …),
`arcTxHash` (real on-chain hash, when one exists), `gatewayReference` (Circle
Gateway batch settlement UUID — **not** an on-chain hash; settlement is
batched and async), `upstreamOk`/`upstreamStatus` (x402-proxied delivery
outcome), `merchantId`/`listingId` (loose refs for analytics), `direction`
("send" | "request").

`PaymentLog` is written by both x402-backed and direct-settlement flows. It
is the single ledger; nothing else is a payment record.

## 2. withGateway() — the canonical HTTP/x402 middleware (facilitator path)

`src/lib/x402.ts:123` — `withGateway(handler, price, endpoint, listingId?, merchantId?)`
is a **route wrapper**: it returns a `NextResponse` on every path (402
challenge → parse/verify → settle → run handler → log). It is built on the
shared primitives `paymentRequiredResponse` / `verifyPayment` / `settlePayment`
(batched via `BatchFacilitatorClient`, Circle Gateway).

**Exactly where x402 is the actual payment mechanism today (live):**

- `/api/x402/marketplace` + `/api/x402/marketplace/pay/[slug]` — marketplace
  purchases (withGateway wrapper).
- `/api/agent/brain` — paid agent calls (`withGateway(brainHandler, "$0.002", "/api/agent/brain")`).
- `/api/nano/pay/[endpoint]` — nanopayments (price table `$0.001`–…).
- `/api/payroll/fund` — payroll: **uses the same primitives directly**
  (not the wrapper) in `fundPayrollViaX402`: 402 challenge → verify →
  caller-control → spend-limit pre-flight → settle → seller-gateway sweep →
  on-chain spend record → `fundBatchFor` → PaymentLog. Its 402 format is
  byte-identical to the wrapper's.
- `/api/test-payment` — test-only.

**What is NOT x402 (verified — do not "assume beyond what's wired"):**

- **Checkout** (`/api/payments/initialize`, `/api/payments/settle`):
  PaymentLog-driven **direct Circle settlement**. PATH B transfers via the
  payer's resolved Circle wallet (ConsumerAccount/AgentRegistry; platform
  agent → `DEFAULT_PAYER_WALLET_ID` — an explicit identity binding, fail-
  closed: a payer with no bound wallet is refused, never silently debited
  from the shared default). The old `/api/checkout/pay` trigger was deleted
  (2026-08-19) — the checkout UI settles from the customer's own wallet via
  `/api/payments/verify-onchain`. Recurring payments (`/api/payments/scheduled`)
  resolve their payer wallet at creation (consumer/merchant/agent/platform
  agent) and refuse to persist unbound rows; `/api/payments/scheduled/run`
  fails closed on null `payerWalletId` — no `DEFAULT_PAYER_WALLET_ID`
  fallback anywhere.
  PATH A is CCTP bridging via `MESSAGE_TRANSMITTER_V2.receiveMessage` signed
  with `ARC_ADMIN_PRIVATE_KEY`. No `payment-signature` header, no withGateway.
  (A prior session summary assumed Checkout used withGateway — this is
  incorrect; checkout never touched the x402 path.)
- **Jobs** (`/api/jobs/fund`, `/api/jobs/*`, `/api/escrow/*`): direct Circle
  contract transactions on the ERC-8183 `AGENTIC_COMMERCE_CONTRACT`
  (`createContractTransaction` approve + fund), signed via Circle's contract
  API. No x402, no withGateway. The dead-code `stubs/dead-code/x402JobPayment.ts`
  proposal (jobs via x402) was never wired.
- **Agent-to-agent payments** (`/api/agents/[id]/pay`, 2026-08-18): direct
  on-chain settlement, Jobs-pattern boundary — structured A2A payment with
  on-chain state. The payer agent's per-agent x402 payment EOA
  (`X402EoaWallet.agentRegistryId`, key AES-256-GCM at rest) does a NATIVE
  USDC value-send to the recipient address — measured fee-free (cost =
  amount + gas only), so the transfer mechanism carries no fee-rate
  assumption. Spend-limit (ArcFlareSpendLimit via `spendLimitEnforcer`)
  pre-flights and records BEFORE the transfer (A2A is irreversible — the
  cap can never be exceeded by the route), then the recipient's real
  on-chain credit delta is verified at the receipt block and the PaymentLog
  row carries the actual `arcTxHash`. Not x402: no 402 challenge, no Gateway
  batch, no seller sweep — `gatewayReference` holds the spend-record tx
  instead.

## 3. x402 is an adapter/protocol layer, not a ledger

x402 (`payment-signature` header + 402 challenge) is the HTTP protocol the
facilitator path speaks. Underneath it, settlement is the Circle Gateway
batch facilitator: verify → settle → **async** on-chain credit into the
SELLER's gateway depositor (batching contract `0x0077777d…`, per-depositor
balances). Consequences the code already handles:

- `gatewayReference` (UUID) ≠ `arcTxHash` (may stay null — settlement is
  batched; see `payments/analytics` "notTracked" section).
- Payroll's `sweepSettledToRelayer` polls `totalBalance(usdc, sellerEoa)` up
  to 120s, then withdraws to the relayer EOA so `fundBatchFor` (relayer-
  signed) can fund the batch. Settles slower than the poll window still land
  later; the request 500s and a `StuckSettlement` PENDING_REVIEW row is
  written (`src/lib/jobs/settlementRecovery.ts`).
- `StuckSettlement` = the race/recovery ledger: settle succeeded but the
  spend-limit record or batch funding failed → auto-refund from the relayer
  (`REFUNDED` / `REFUND_FAILED`), or manual review (`PENDING_REVIEW`). This is
  recovery bookkeeping on top of PaymentLog, not a second payment ledger.

## 4. Boundary rules

1. PaymentLog = source of truth for payment lifecycle, across all flows.
2. withGateway() = the canonical HTTP/x402 middleware/facilitator path, used
   exactly where x402 is the payment mechanism (section 2 list).
3. Direct Circle/contract settlement remains canonical for flows that already
   use it directly: checkout (Circle wallet transfers / CCTP) and jobs
   (ERC-8183 contract API). Do NOT force these through withGateway().
4. x402 is an adapter/protocol layer on top of settlement — never a second
   payment ledger or state machine.

## 5. Stale references audited (2026-08-18)

The OLD `withGateway({ payerAddress, tokenAddress, amount, memo })`
options-object shape exists in exactly two places, both dead code, both now
marked with a prominent "DEAD CODE — STALE SHAPE" header:

- `stubs/dead-code/x402JobPayment.ts` (line ~106 old shape; also stale
  `@/lib/auth/verifyCallerControlsAddress` import and object-form
  checkSpendAllowed/recordSpend calls).
- `stubs/dead-code/payrollExecution.ts` (line ~114 old shape; superseded by
  the live `src/lib/payroll/payrollExecution.ts`).

No live code calls the old shape. Live callers all use
`withGateway(handler, price, endpoint)`.

## 6. Telegram read model (history / notifications)

`/history` and the `jobs/complete` Telegram notification read `Erc8183Job` (status `COMPLETED`, `providerSCA == worker wallet`, `budget` as 6-dec BigInt), not `PaymentLog` or `AgentLedgerEntry`. Human Telegram workers have no `AgentRegistry` row, so their earnings are not in `AgentLedgerEntry`; the job budget is the authoritative amount. `PaymentLog` remains source of truth for whether money moved; `/history` is a read projection over the job mirror.

## 7. Signer/key inventory (fail-closed)

`src/lib/env/walletEnvCheck.ts` (runs at server start via
`src/instrumentation.ts`) enforces: signer address vars must have a matching
key that derives the address (SELLER_ADDRESS↔SELLER_PRIVATE_KEY,
BUYER_ADDRESS↔BUYER_PRIVATE_KEY); key-only vars must be valid
(EOA/RELAYER/ARC_ADMIN/ESCROW_ADMIN/PRIVATE_KEY); deprecated unkeyed signer
vars (SELLER_WALLET_ADDRESS) are a hard startup error; Circle-custody SCA
vars (AGENT_*_WALLET_ADDRESS) are format-checked only. See the module for the
full registry and `scripts/test-wallet-env-validation.ts` for the tests.
