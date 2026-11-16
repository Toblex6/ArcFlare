# Mainnet swap readiness — 2026-11-16

Status: **NEEDS-OWNER for an authenticated swap, return swap, and live Tower attribution.**

## Verified offline

`npx tsx --test tests/swap-mainnet-boundaries.test.mjs` passes **27/27** checks. The suite invokes the actual quote service, RPC-backed unsigned builder, and Circle executor using mocked JSON-RPC and in-memory intents. It renders the component's extracted guard JSX; it does not drive a visible production browser.

- Mainnet UI warns strictly above **100 bps (1%)** and blocks strictly above **500 bps (5%)**. Boundary checks include 100/101 and 500/501 bps.
- Both confirmation handlers check the block before wallet execution. The actual quote service rejects above 500 bps **before intent access or persistence**, in both USDC→EURC and EURC→USDC directions.
- The Circle executor independently rejects above 500 bps after live rebuilding and binding. At 500 bps it reaches the deliberately unavailable signing adapter, not a price rejection. No transaction is submitted.
- Actual testnet quotes above the mainnet threshold still succeed in the fixture with registry-resolved token addresses, testnet WUSDC units, and the separate unsigned wrap step where required. Testnet UI does not warn or block.
- A valid mocked Tower response allows attribution. Foreign tokens, mismatched input amounts, zero output, and HTTP 403 do not. This proves fallback/attribution logic, **not successful production Tower discovery or its live unit convention**.

`npx tsx scripts/tower-mainnet-unitflow-tests.ts` also passes **42/42** static/offline and refused-loopback checks. No swap production logic, checkout, PaymentLog schema, provider configuration, or custom SwapPool was changed or seeded.

## Owner evidence still required

1. Sign in with the approved payer SCA `0xdda9211233c5641eaf4ede4ffaa9d8a14e5055b4` in the intended production tab. Check its Arc mainnet balance and Circle authorization/sponsorship before execution.
2. Inspect the UnitFlow quote and visible guard behavior. A rejected quote or disabled confirmation must move no funds. Do not increase a live test amount to manufacture price impact; use a non-paying fixture for unsafe sizes.
3. Execute at most **1 USDC** and keep total movement within **3 USDC for this readiness run**, including the return leg. Stop after any uncertain outcome. Inspect the receipt, `FlowSwapIntent` row, actual payer debit/recipient credit at fixed blocks, and explorer before another test.
4. Only then return the actual received EURC to USDC within the remaining budget and inspect the same evidence. Mainnet direct-V3 USDC output has no testnet WUSDC unwrap step.
5. Confirm Tower was both `consulted` and `available` using an actual production response. Do not add a Tower badge for missing credentials, a failed request, or an unverified candidate. Keep the API key server-only.

No mainnet swap or return transaction was performed; this task used **0 USDC**.
