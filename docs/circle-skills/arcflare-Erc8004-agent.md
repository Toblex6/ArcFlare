---
name: flarehq-erc8004-agent
description: Deploy a new ERC-8004 agent identity, record reputation, or request/respond to validation on Arc Testnet via FlareHQ. Use when an agent needs an onchain identity, needs to attest to another agent's trustworthiness, or needs to verify a credential (e.g. KYC) for another agent.
---

## Overview

ERC-8004 gives AI agents a verifiable onchain identity, plus reputation
and validation registries. FlareHQ wraps Arc's three native ERC-8004
contracts (IdentityRegistry, ReputationRegistry, ValidationRegistry)
behind simple endpoints.

## Deploy a new agent identity

```
curl -X POST https://arcflare-gateway.onrender.com/api/agent/deploy \
  -H "x-api-key: $ARCFLARE_API_KEY" -H "Content-Type: application/json" \
  -d '{"agentName": "<name>"}'
```

Returns a Circle SCA wallet + ERC-8004 tokenId for the new agent.

## Record reputation (as a validator, not the agent's own owner)

```
curl -X POST https://arcflare-gateway.onrender.com/api/agent/reputation \
  -H "x-api-key: $ARCFLARE_API_KEY" -H "Content-Type: application/json" \
  -d '{"agentId":"<tokenId>","validatorSCA":"<yourSCA>","validatorWalletId":"<yourWalletId>","score":<0-100>,"tag":"<e.g. successful_payment>"}'
```

Per ERC-8004, `validatorSCA` must NOT be the agent's own owner wallet —
this will be rejected.

## Request validation (as the agent owner)

```
curl -X POST https://arcflare-gateway.onrender.com/api/agent/validation \
  -H "x-api-key: $ARCFLARE_API_KEY" -H "Content-Type: application/json" \
  -d '{"action":"request","agentId":"<tokenId>","ownerSCA":"<ownerSCA>","validatorSCA":"<validatorSCA>","requestTag":"<e.g. kyc_verification>"}'
```

## Respond to validation (as the validator)

```
curl -X POST https://arcflare-gateway.onrender.com/api/agent/validation \
  -H "x-api-key: $ARCFLARE_API_KEY" -H "Content-Type: application/json" \
  -d '{"action":"respond","validatorSCA":"<validatorSCA>","requestHash":"<hashFromRequestStep>","passed":true,"tag":"<e.g. kyc_verified>"}'
```

## Check validation status (anyone)

```
curl "https://arcflare-gateway.onrender.com/api/agent/validation?requestHash=<hash>" \
  -H "x-api-key: $ARCFLARE_API_KEY"
```

## Rules

- NEVER record reputation for an agent you own — this violates ERC-8004's
  anti-self-dealing rule and will be rejected by the contract.
- ALWAYS use a score between 0-100; values outside this range are invalid.
- Validation is a two-step request/response — do not expect a result
  immediately after `request`; the validator must separately `respond`.