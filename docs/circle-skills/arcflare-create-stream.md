---
name: arcflare-create-stream
description: Create a per-second USDC streaming payment on ArcFlare's ArcFlareStream.sol on Arc Testnet. Use when an agent needs continuous payment over time rather than a lump sum — e.g. paying for ongoing compute, a subscription, or a freelance engagement billed by time. Also covers stopping a stream and withdrawing earned funds.
---

## Overview

Streams drip USDC from a sender to a receiver every second, made viable by
Arc's fast finality. Funds are locked upfront; the receiver can withdraw
what they've earned at any time, and the sender can stop the stream to
reclaim the unstreamed remainder.

## Create a stream

```
curl -X POST https://arcflare-gateway.onrender.com/api/payments/stream \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "senderSCA": "<senderSCA>",
    "receiverSCA": "<receiverSCA>",
    "ratePerSecond": "<rate, e.g. 0.001>",
    "totalDeposited": "<total amount to lock, e.g. 0.01>"
  }'
```

Note: `totalDeposited` must be fully available in the sender's wallet
(check with `circle wallet balance` first) — this is the full amount locked
upfront, drained gradually as time passes.

## Stop a stream (sender side)

```
curl -X POST https://arcflare-gateway.onrender.com/api/payments/stream/stop \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reference": "<streamReference>", "callerSCA": "<senderSCA>"}'
```

## Withdraw earned funds (receiver side)

```
curl -X POST https://arcflare-gateway.onrender.com/api/payments/stream/withdraw \
  -H "x-api-key: $ARCFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reference": "<streamReference>", "callerSCA": "<receiverSCA>"}'
```

## Rules

- ALWAYS confirm `ratePerSecond * expected duration` doesn't exceed
  `totalDeposited` before creating — tell the user how long the stream will
  actually last at that rate.
- NEVER let the sender stop a stream on the receiver's behalf, or vice
  versa — `callerSCA` must match the correct role.