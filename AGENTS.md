<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Known findings (tracked)

- **Arc Testnet USDC fees — re-measured 2026-08-18; the old "~0.001553 flat / ~12.3% into contracts" figures do NOT reproduce.** Fresh measurements (swap-pool-e2e): EOA→EOA flat **0.001028** (exact at 0.05/0.50/1.00/5.00); EOA→contract **+0.00217–0.0044** (~0.2%); contract→EOA recipient short **0.0014** (payroll cancel-refund) to **0.0022** (swap pool outbound); EURC **fee-free everywhere measured**. The swap pool's bookkeeping tracks exact amounts, so each USDC-outbound op leaks ~0.0022 from pool reserves unseen by LP math. The payroll contract is NOT reliably fee-exempt as sender. Re-verify on mainnet before trusting escrow math.
- **Payroll x402 wiring RESOLVED (2026-08-18)**: live `fundPayrollViaX402()` in `src/lib/payroll/payrollExecution.ts` (dead-code version in `stubs/dead-code/` is superseded — do not re-introduce it). E2E `scripts/payroll-x402-e2e.ts` 15/15: pre-flight 403, settle, seller sweep (with 120s `totalBalance` poll), on-chain `checkAndRecordSpend`, `recordSpend`, `fundBatchFor` (self-healing allowance + refund-on-failure), `executeBatch`.
- **Seller wallet mismatch (important)**: `SELLER_WALLET_ADDRESS` (`0xa8d1d913…`) has NO private key anywhere — **~0.554 USDC is stranded** in the x402 batching contract depositor balance for that address (old marketplace settlements + E2E settles). Code now uses `SELLER_ADDRESS` (`0xc119bb61…`) + `SELLER_PRIVATE_KEY`. Do not pay to `0xa8d1d913` again.
- **Circle `/settle` executes asynchronously** — API debits instantly, on-chain credit took 40+ min (settles #2/#3). The sweep polls up to 120s; a slower settlement still lands later (funds are safe in the seller gateway depositor) but the request 500s and a PENDING_REVIEW row is written. Check `totalBalance(usdc, SELLER_ADDRESS)` on batching contract `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` before assuming failure.
- **Stale RPC fixed**: `.env.local` `ARC_TESTNET_RPC` was `rpc-testnet.arc.xyz` (dead endpoint) → now `https://rpc.testnet.arc.network`.
- **Explorer API caps `tokentx` at 24 rows** (offset pages 2+ are empty) — feed-based reconciles miss older transfers; use native tx lists instead.
- **Arc explorer does not support contract verification** — deployed contracts (`ArcFlarePayroll`, `ArcFlareSpendLimit`, `ArcFlareSwapPool`) are unverified; flatten source before shipping.
- **ArcFlareSwapPool deployed** `0xaD4F3634a64685CB7dff08B82fb742e4ca7f7451` (tx `0x5aebb350…`), `SWAP_POOL_CONTRACT_ADDRESS` set in `.env` + `.env.local`. Seeded USDC/EURC ≈ 1.08 ratio (reserves ~22.5/18.6 after tests). EURC = `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, 6 decimals (verified on-chain). EURC testnet is only obtainable via faucet.circle.com (captcha-gated; relayer EOA holds the drip).
