# Arc mainnet ERC-8004 evidence

Read-only checks on 2026-11-20 against `https://rpc.mainnet.arc.io` (chain
`5042`) confirmed bytecode at all three official registry proxy addresses:

- Identity: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Reputation: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
- Validation: `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`

Each proxy had 130 bytes of runtime code. The EIP-1967 implementation slots
resolved to contracts with 14,474 bytes (Identity), 10,491 bytes (Reputation),
and 5,876 bytes (Validation). No transaction was signed or broadcast.

Production registration, reputation, validation, readers, and agent cards all
resolve these addresses through `getNetworkConfig()`. Testnet retains its
existing pins. Legacy unscoped registry env fallbacks are not honored.
