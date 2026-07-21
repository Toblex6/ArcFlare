---
name: flarehq-checkout-settle
description: Initialize and settle a standard USDC checkout payment via FlareHQ on Arc Testnet. Use for the most basic FlareHQ flow — one party paying another for a single transaction, with optional ERC-8004 agent attribution. This is the entry point most other FlareHQ skills assume has already happened once.
---

## Overview

The simplest FlareHQ flow: initialize a payment, then settle it. Settling
moves real USDC onchain from the resolved payer wallet to the merchant.

## Step 1 — Initialize

```
curl -X POST https://arcflare-gateway.onrender.com/api/payments/initialize \
  -H "x-api-key: $ARCFLARE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "amount": "<amountUSDC>",
    "currency": "USDC",
    "agentSCA": "<payerSCA, if the payer is a registered ERC-8004 agent>",
    "merchant": "<merchant name or address>"
  }'
```

Returns a `reference` and `checkoutUrl`.

## Step 2 — Settle

```
curl -X POST https://arcflare-gateway.onrender.com/api/payments/settle \
  -H "x-api-key: $ARCFLARE_API_KEY" -H "Content-Type: application/json" \
  -d '{"reference": "<referenceFromStep1>"}'
```

Returns `arcTxHash` and `explorerUrl` once the real USDC transfer confirms.

## Check status anytime

```
curl https://arcflare-gateway.onrender.com/api/payments/verify/<reference> \
  -H "x-api-key: $ARCFLARE_API_KEY"
```

## Rules

- If `agentSCA` is provided but not found in FlareHQ's AgentRegistry, the
  initialize call will fail — deploy the agent first via
  `flarehq-erc8004-agent` if it doesn't exist yet.
- ALWAYS tell the user the amount and merchant before settling — this moves
  real USDC.
- A `reference` can only be settled once; calling settle again on an
  already-SUCCESS reference returns the existing result without moving
  funds twice.