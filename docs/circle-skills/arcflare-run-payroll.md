---
name: flarehq-run-payroll
description: Pay multiple recipients in a single batched USDC payroll run via FlareHQ on Arc Testnet. Use when an agent needs to disburse funds to several people or wallets at once — team payments, contractor payouts, or bulk reimbursements. Each recipient is paid as a real onchain transfer.
---

## Overview

Wraps N individual USDC transfers into one tracked batch. Each payment
still executes as its own onchain transfer (sequential, not atomic) — if
some succeed and others fail, the batch reports partial success.

Endpoint: `POST https://arcflare-gateway.onrender.com/api/payroll/run`

## Step 1 — Confirm payer balance covers the full batch

```
circle wallet balance --address <payerSCA> --chain ARC-TESTNET --output json
```

Sum all recipient amounts and confirm the payer wallet holds at least that
much, plus gas headroom.

## Step 2 — Run the batch

```
curl -X POST https://arcflare-gateway.onrender.com/api/payroll/run \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "payerSCA": "<payerSCA>",
    "payerWalletId": "<payerWalletId>",
    "recipients": [
      {"recipientSCA": "<addr1>", "amount": "<amt1>", "label": "<optional label>"},
      {"recipientSCA": "<addr2>", "amount": "<amt2>", "label": "<optional label>"}
    ]
  }'
```

## Step 3 — Check batch result

Response includes per-recipient `status` (SUCCESS/FAILED), each with its
own `txHash`. Look up later via:

```
curl "https://arcflare-gateway.onrender.com/api/payroll/run?batchRef=<batchRef>" \
  -H "x-api-key: $ARCFLARE_API_KEY"
```

## Rules

- ALWAYS read back the full recipient list to the user before running —
  this moves real money to multiple people, mistakes are not reversible.
- NEVER retry a "PARTIAL_FAILURE" batch by re-running the whole list — only
  resubmit the specific recipients that failed, to avoid double-paying
  ones that already succeeded.