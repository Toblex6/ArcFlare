---
name: pay-flarehq-service
description: Pay for FlareHQ's x402-gated endpoints (agent-lookup, reputation-check, job-status, and other nanopayment-protected resources) using a Circle Agent Wallet. Use whenever the user wants to call an FlareHQ paid resource, mentions "FlareHQ", "arcflare-gateway.onrender.com", or wants to pay for agent identity lookups, reputation checks, or job status checks via x402. Requires the agent wallet to already be bootstrapped — if `circle wallet status` shows not logged in or no wallet exists, hand off to the use-agent-wallet skill first.
---

## Overview

FlareHQ (https://arcflare-gateway.onrender.com) is stablecoin payment
infrastructure on Arc Testnet. Several of its endpoints are gated behind
Circle's x402 protocol via Gateway Nanopayments — each call costs a small
amount of USDC, paid directly from the caller's Circle Agent Wallet with no
separate checkout or signup flow.

This skill covers paying for those endpoints using `circle services pay`.

## Prerequisites

- Circle CLI installed (`circle --version`)
- Logged in (`circle wallet status` shows a valid session)
- An agent wallet created and funded with at least a few cents of USDC

If any of these are missing, hand off to `use-agent-wallet` (bootstrap) or
`fund-agent-wallet` (funding) first. Do not attempt to create wallets or
handle login here — this skill assumes bootstrap is already done.

## FlareHQ's paid resources

| Resource | Path | Price (USDC) |
|---|---|---|
| Agent lookup | `/api/nano/pay/agent-lookup` | 0.001 |
| Reputation check | `/api/nano/pay/reputation-check` | 0.0005 |
| Job status check | `/api/nano/pay/job-status` | 0.0001 |

Base URL: `https://arcflare-gateway.onrender.com`

## Step 1 — Check wallet balance

```
circle wallet balance --address <addr> --chain ARC-TESTNET --output json
```

If balance is insufficient for the resource price, hand off to
`fund-agent-wallet`.

## Step 2 — Pay for the resource

```
circle services pay \
  https://arcflare-gateway.onrender.com/api/nano/pay/<resource> \
  --address <addr> \
  --chain ARC-TESTNET \
  -X POST \
  --max-amount <price-from-table-above> \
  --output json
```

Replace `<resource>` with the path segment from the table (e.g.
`agent-lookup`), and `<price-from-table-above>` with that resource's listed
price. `--max-amount` is a ceiling, not a fixed charge — the CLI pays exactly
what the endpoint's x402 response requires, and refuses if it exceeds this
ceiling.

Expected successful output includes the resource's JSON response plus a
`paid` block showing `amount`, `payer`, `network`, and `transaction`.

## Step 3 — Verify the result

Read the returned JSON's `paid.transaction` field and confirm it resolves on
Arc Testnet's explorer:

```
https://testnet.arcscan.app/tx/<transaction>
```

## Rules

- NEVER pay for a resource without telling the user the price first.
- ALWAYS use `--max-amount` matching the table above — never a higher value
  "to be safe," since that raises what the agent is authorized to spend.
- If `circle services pay` fails with a 402 still present in the response,
  the payment was not accepted — check wallet balance before retrying.
- If the endpoint returns a non-200/402 error, do not retry blindly; surface
  the error to the user.

## Alternatives

Trigger `use-agent-wallet` instead when:
- The user has no wallet yet, or `circle wallet status` shows not logged in.

Trigger `fund-agent-wallet` instead when:
- Wallet balance is 0 or insufficient for the resource price.

Trigger `agent-wallet-policy` instead when:
- The user wants to cap how much this agent wallet can ever spend on
  FlareHQ or any other x402 service.