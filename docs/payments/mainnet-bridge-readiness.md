# Mainnet bridge readiness — 2026-11-16

Status: **NEEDS-OWNER for production configuration and a completed transfer.**

## Verified without signing

- Installed Circle Bridge Kit `1.15.1` includes the destination chain name `Arc`, EVM chain ID `5042`, USDC with 6 decimals, and CCTP domain `26`.
- `src/lib/bridge/sourceChains.ts` derives six mainnet external-wallet sources from the installed SDK: Ethereum, Base, Arbitrum, Optimism, Polygon, and Avalanche. Source token, chain ID, and explorer values are not a second handwritten deployment table.
- The external-wallet UI selects `Arc` on mainnet, exposes source-gas and relayed-mint notices, estimates fees best-effort, and retains burn/mint links and resume controls. Static checks are not evidence that a bridge completed.
- The Circle server-authorized path in `src/lib/cctp-v2.ts` is separate. It requires explicit `CCTP_MAINNET_SOURCES_JSON` and `CCTP_MAINNET_ARC_CHAIN_ID=Arc`; `5042`, `26`, `Arc_Testnet`, and other destinations cannot substitute for the chain name.
- Importing the bridge module does not require optional bridge configuration. Missing configuration fails closed when the feature is requested.

The original local checkout has the approved Neon database configured but is not configured for mainnet. Its presence of Circle credentials does not establish production sponsorship, production source-wallet support, or production `CCTP_MAINNET_*` settings. No environment values were changed.

Approved-wallet, read-only Neon queries found no matching merchant account, merchant payment, payer payment, or payer bridge intent. There is no completed bridge evidence to reconcile from that lookup.

## Owner verification

1. Confirm the deployed network descriptor is mainnet, chain `5042`. Verify the deployment's Circle environment, sponsorship policy, source-wallet support, and explicit bridge settings privately. Do not copy testnet identifiers into production.
2. Use only an already funded, approved wallet. For this run the approved merchant SCA is `0xc4e83c03d9da3f7ff3f9b03a715797f9f16b5671` and payer SCA is `0xdda9211233c5641eaf4ede4ffaa9d8a14e5055b4`. If the required source-network wallet or signing access is missing, stop; do not provision or use an unrelated wallet.
3. In the existing app, inspect the supported source, destination `Arc`, amount, fees, and recipient before authorizing. Use at most **1 USDC per test**, within **3 USDC for the entire readiness run**, including the other money tests.
4. Before another money test, inspect the source burn receipt and explorer, destination mint receipt and explorer, and matching database record. For the external-wallet path, require the destination/domain binding, attested message nonce, matching mint, actual recipient credit, and `COMPLETED` intent. A broadcast, SDK status, or HTTP 200 alone is insufficient.
5. If pending, use the existing resume/status path rather than initiating another burn. The Circle path's in-flight tracking is process-local and does not survive a server restart; that existing limitation is unchanged.

No bridge was signed, no database rows were written, and **0 USDC** of the run budget has been used. Production transfer completion remains unverified.
