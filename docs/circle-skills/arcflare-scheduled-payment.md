---
name: arcflare-scheduled-payment
description: Create, list, or cancel a recurring USDC payment on ArcFlare that runs automatically every N days. Use when an agent needs to set up an ongoing obligation — subscriptions, weekly allowances, periodic invoices — without manually triggering each payment.
---

## Overview

ArcFlare's scheduler stores recurring payment intent and executes it
automatically on an hourly cron check. This skill covers creating,
listing, and cancelling these schedules — not the execution itself, which
runs server-side without further agent involvement.

## Create a recurring payment

```
curl -X POST https://arcflare-gateway.onrender.com/api/payments/scheduled \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "payerSCA": "<payerSCA>",
    "receiverSCA": "<receiverSCA>",
    "amount": "<amountUSDC>",
    "intervalDays": <N>,
    "maxRuns": <optional, omit for infinite>,
    "description": "<plain text label>"
  }'
```

## List active schedules

```
curl "https://arcflare-gateway.onrender.com/api/payments/scheduled?payerSCA=<payerSCA>" \
  -H "x-api-key: $ARCFLARE_API_KEY"
```

## Cancel a schedule

```
curl -X DELETE https://arcflare-gateway.onrender.com/api/payments/scheduled \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reference": "<scheduleReference>"}'
```

## Rules

- ALWAYS confirm the payer wallet will have sufficient USDC at each future
  run — this skill cannot guarantee future balance, only flag the risk to
  the user.
- NEVER create a schedule with `maxRuns` omitted unless the user explicitly
  wants it to run indefinitely — confirm this choice out loud.