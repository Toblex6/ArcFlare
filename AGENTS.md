<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Known findings (tracked)

- **Must verify before mainnet — Arc Testnet USDC (`0x3600…`) charges transfer fees** (measured: flat ~0.001553 USDC per EOA→EOA transfer, ~0.0012 per approve, extra ~12.3% on transfers into contract addresses, reduced inbound credits). The payroll contract is fee-EXEMPT as sender (execute drained exact totals). If mainnet USDC charges fees too, escrow math (`totalFunded` vs actual debit) becomes a real feature, not a log line.
- **Re-wiring needed — `withGateway()` in `stubs/dead-code/` is stale** vs the current middleware. `fundPayrollViaX402()` (stubs/dead-code/payrollExecution.ts) must be re-wired before payroll is gasless-usable the same way as job funding. The live `/api/payroll/fund` route uses shared x402 primitives instead (see its header comment).
- **Stale RPC fixed**: `.env.local` `ARC_TESTNET_RPC` was `rpc-testnet.arc.xyz` (dead endpoint) → now `https://rpc.testnet.arc.network`.
- **Explorer API caps `tokentx` at 24 rows** (offset pages 2+ are empty) — feed-based reconciles miss older transfers; use native tx lists instead.
- **Arc explorer does not support contract verification** — deployed contracts (`ArcFlarePayroll`, `ArcFlareSpendLimit`) are unverified; flatten source before shipping.
