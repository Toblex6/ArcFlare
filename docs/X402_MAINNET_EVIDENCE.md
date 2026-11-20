# Arc mainnet x402 evidence

Read-only check on 2026-11-20 against Circle's production facilitator:

- `GET https://gateway-api.circle.com/v1/x402/supported`
- Network: `eip155:5042`
- x402 version: `2`
- Scheme: `exact`
- Settlement metadata: `GatewayWalletBatched`, version `1`
- Verifier: `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`
- Arc USDC: `0x3600000000000000000000000000000000000000`, 6 decimals
- Authorization versions advertised: `1`, `2`
- Minimum validity advertised: `604800` seconds

This means Circle documents the **exact Gateway nanopayments/batched scheme**
for Arc mainnet, not a standalone per-request EIP-3009 facilitator settlement.
FlareHQ therefore continues to use `@circle-fin/x402-batching` and
`GatewayWalletBatched`. `X402_MAINNET_ENABLED=true` is additionally required;
invalid network, asset, verifier, facilitator, or `payTo` configuration returns
503 before `withGateway()` is constructed.

GatewayWallet and GatewayMinter bytecode were also present via read-only
`eth_getCode` on `https://rpc.mainnet.arc.io`. No transaction was signed or
broadcast.
