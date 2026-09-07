// src/components/checkout/routing/routerAbi.ts
//
// Minimal contract fragments the customer's wallet signs during a routed
// payment. Function signatures only — no token addresses, no decimals, no
// venue identity. Every address the widget passes (pay token, router,
// recipient) comes from the server-issued quote or the canonical
// client-token layer — the UI never invents one.
//
// Flow: approve(router, exactQuotedInput) on the pay-token contract, then
// route(tokenIn, amountIn, minAmountOut, deadline, recipient) on the
// server-provided router. The verifier re-checks all of it on-chain.

export const erc20ApproveAbi = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// ArcFlarePaymentRouter.route(address,uint256,uint256,uint256,address).
// tokenOut is derived on-chain (the other canonical token); the pool is
// immutable in the router — no caller-supplied path or venue exists.
export const paymentRouterRouteAbi = [
  {
    name: 'route',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;
