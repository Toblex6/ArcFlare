---
name: flarehq-erc8183-job
description: Run the full ERC-8183 agentic commerce job lifecycle on Arc Testnet via FlareHQ — create a job, set its budget, fund escrow, submit a deliverable, and complete payment. Use when one agent needs to hire another agent (or be hired) for a discrete task with onchain escrow guarantees.
---

## Overview

ERC-8183 is Arc's native standard for agent-to-agent hiring. FlareHQ wraps
the full 6-step lifecycle behind one endpoint, driven by an `action` field.
Each step must happen in order; skipping ahead will fail against the
underlying contract state.

Endpoint: `POST https://arcflare-gateway.onrender.com/api/jobs`

## The lifecycle, in order

1. **create** (client) → returns `jobId`
```
curl -X POST https://arcflare-gateway.onrender.com/api/jobs \
  -H "x-api-key: $ARCFLARE_API_KEY" -H "Content-Type: application/json" \
  -d '{"action":"create","clientSCA":"<clientSCA>","providerSCA":"<providerSCA>","amountUSDC":"<amt>","description":"<task description>"}'
```

2. **setBudget** (provider)
```
-d '{"action":"setBudget","jobId":"<jobId>","providerSCA":"<providerSCA>","amountUSDC":"<amt>"}'
```

3. **approve** (client) — approves USDC spend
```
-d '{"action":"approve","jobId":"<jobId>","clientSCA":"<clientSCA>","amountUSDC":"<amt>"}'
```

4. **fund** (client) — locks USDC into escrow
```
-d '{"action":"fund","jobId":"<jobId>","clientSCA":"<clientSCA>"}'
```

5. **submit** (provider) — submits completed work
```
-d '{"action":"submit","jobId":"<jobId>","providerSCA":"<providerSCA>","deliverable":"<description of work done>"}'
```

6. **complete** (client) — releases payment
```
-d '{"action":"complete","jobId":"<jobId>","clientSCA":"<clientSCA>"}'
```

## Check job state anytime

```
curl "https://arcflare-gateway.onrender.com/api/jobs?jobId=<jobId>" \
  -H "x-api-key: $ARCFLARE_API_KEY"
```

Returns the live `status` field: Open, Funded, Submitted, Completed,
Rejected, or Expired.

## Rules

- ALWAYS check current job status before calling the next step — the
  contract will reject out-of-order calls.
- NEVER call `complete` without the client explicitly confirming the
  submitted deliverable is acceptable.
- If a job's `expiredAt` has passed, do not attempt further steps — surface
  this to the user instead.
