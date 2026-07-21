---
name: flarehq-create-escrow
description: Create a trustless USDC escrow on FlareHQ's ArcFlareEscrow.sol contract on Arc Testnet. Use when an agent needs to lock USDC for another party until a condition is met (e.g. paying for a delivered service, securing a job, or holding funds pending confirmation). Requires both depositor and beneficiary wallets to exist; depositor wallet must hold enough USDC and be deployed on-chain.
---

## Overview

FlareHQ's escrow holds USDC in `ArcFlareEscrow.sol` on Arc Testnet until
both depositor and beneficiary confirm, or a dispute is resolved. This skill
drives that flow entirely from the Circle CLI side — FlareHQ's backend
signs the actual contract call via Circle's Developer-Controlled Wallets.

Endpoint: `POST https://arcflare-gateway.onrender.com/api/escrow/create`

## Prerequisites

- Depositor wallet deployed on-chain (send any transfer first if new)
- Depositor wallet has enough USDC for the escrow amount + gas
- You know the depositor's Circle walletId (`circle wallet list --output json`)

## Step 1 — Check depositor balance

```
circle wallet balance --address <depositorSCA> --chain ARC-TESTNET --output json
```

## Step 2 — Create the escrow

```
curl -X POST https://arcflare-gateway.onrender.com/api/escrow/create \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "depositorSCA": "<depositorSCA>",
    "depositorWalletId": "<depositorWalletId>",
    "beneficiarySCA": "<beneficiarySCA>",
    "amount": "<amountUSDC>",
    "deadlineHours": 24,
    "condition": "<plain text description of what releases the escrow>"
  }'
```

FlareHQ's backend handles the USDC `approve()` + `createEscrow()` two-step
contract call internally — you do not need to run separate approve/transfer
commands yourself for this flow.

## Step 3 — Confirm

Response includes `txHash` and `explorerUrl`. Verify on Arc Testnet:

```
https://testnet.arcscan.app/tx/<txHash>
```

## Rules

- NEVER set `amount` higher than what the depositor wallet actually holds —
  check balance first (Step 1).
- ALWAYS tell the user the escrow amount and condition before creating it.
- If the response contains a `hint` about insufficient balance, direct the
  user to fund the depositor wallet via `circle wallet fund` before retrying.

## Alternatives

Trigger `flarehq-release-escrow` once both parties are ready to release
funds. Trigger `flarehq-dispute-escrow` if something went wrong with
delivery.