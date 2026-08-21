---
name: flarehq-create-stream
description: Create a criterion-based nanopayment stream on FlareHQ's ArcFlareStream.sol on Arc Testnet. Use when a job needs per-criterion payments as the reviewer confirms each requirement — e.g., paying a worker incrementally for completed deliverables rather than one lump sum at the end.
---

## Overview

Nanopayment streams split a job's total budget across its acceptance criteria (requirements). Each criterion gets one tranche. When the reviewer confirms a requirement is done, the corresponding tranche is released immediately to the worker. This replaces the old per-second streaming model with a milestone-based model that matches real-world job progress.

## Prerequisites

- A funded ERC-8183 job on Arc Testnet (created via `/api/jobs/create`, budget set via `/api/jobs/set-budget`, funded via `/api/jobs/fund`)
- Job status must be `FUNDED` with `budget > 0`
- Job must have a `providerSCA` (the worker) assigned
- Caller must control the job's `clientSCA` (the poster/client)

## Create a Stream

```bash
curl -X POST https://arcflare-gateway.onrender.com/api/jobs/nanopay/open \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "181386",
    "criteria": {
      "jobId": "181386",
      "description": "Backend implementation",
      "requirements": [
        "Complete backend API implementation",
        "Write unit tests for all endpoints",
        "Deploy to staging and verify"
      ],
      "deadlineUnix": 1724200000
    }
  }'
```

Response:
```json
{
  "success": true,
  "jobId": "181386",
  "streamId": "0",
  "trancheCount": 3,
  "totalBudget": "30000",
  "trancheAmounts": ["10000", "10000", "10000"],
  "txHash": "0x...",
  "replayed": false
}
```

**Key fields:**
- `streamId` — on-chain stream identifier (used for releases)
- `trancheCount` — number of criteria = number of tranches
- `totalBudget` — budget in smallest token units (6-dec USDC)
- `trancheAmounts` — exact amount per tranche (last includes remainder)

## Release a Tranche

```bash
curl -X POST https://arcflare-gateway.onrender.com/api/jobs/nanopay/release \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jobId": "181386", "requirementIndex": 0}'
```

**Who can call:**
- The job's client (poster) — controls `job.clientSCA`
- The job's evaluator (authorized reviewer) — controls `job.evaluatorSCA`

The on-chain transaction is **always signed by the poster's wallet** (server-authoritative). The request body only provides `requirementIndex` — no wallet addresses from the client.

**Idempotency:** Calling release twice for the same `requirementIndex` returns the original `txHash` and does not double-pay. If a previous release landed on-chain but the DB write was lost, the route recovers the real `txHash` from the `TrancheReleased` event.

## Close the Stream

```bash
curl -X POST https://arcflare-gateway.onrender.com/api/jobs/nanopay/close \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jobId": "181386"}'
```

Releases any remaining budget (unreleased tranches) to the worker in one final transfer. No funds ever return to the poster.

## Check Stream Status

```bash
curl -X POST https://arcflare-gateway.onrender.com/api/jobs/nanopay/status \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jobId": "181386"}'
```

Returns both DB mirror and live on-chain state:
- `releasedIndexes` — which tranches have been released (from contract `releasedTranches()`)
- `trancheAmounts` — exact amounts per tranche (from contract `trancheAmounts()`)
- `closed` — whether the stream is finalized

---

## Rules

- **One stream per job** — opening a second stream for the same job returns the existing stream (replay).
- **Max 50 tranches** — enforced by contract and API.
- **No refund path** — funds move poster → stream → worker only. Closing releases remainder to worker.
- **Deterministic amounts** — floor division of budget by criteria count; remainder added to last tranche. Total released ≤ budget guaranteed by contract.
- **Worker is a plain address** — receives USDC directly, no gas/Circle wallet needed.
- **Arc Testnet USDC fees** — each contract→EOA transfer incurs a small recipient fee (~0.0014–0.0022 USDC on testnet). The contract tracks exact budget; worker's actual gain = `amount - fee`. Verify deltas on mainnet.

---

## Contract

**ArcFlareStream** on Arc Testnet: `0xd8ca3Bbc212F36666145fAa487D45742eA04A52B`  
Deployment tx: `0x13a3879bcd6dd9ad9f97230f1cd25af949116a468b7e4bc67b7749909cad3009`  
Bytecode verified (keccak match against local artifact).

Solidity: ^0.8.24, OpenZeppelin 5.0.2 (ReentrancyGuard, SafeERC20)