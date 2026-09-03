// src/lib/agent-deploy-guard.test.ts
//
// Focused tests for SUBTASK F guard (src/lib/agent-deploy-guard.ts).
// Run read-only (no route edits, no network, no DB):
//   ./node_modules/.bin/tsx --test src/lib/agent-deploy-guard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  checkAgentDeployAllowed,
  releaseAgentDeployClaim,
  resetAgentDeployGuard,
} from "./agent-deploy-guard";

const MERCHANT_A = "merchant_A";
const MERCHANT_B = "merchant_B";

// Small windows keep the suite fast while exercising identical logic.
const OPTS = { maxPerWindow: 3, windowMs: 60_000, minIntervalMs: 5_000 };

test("legitimate deploy is allowed by default", () => {
  resetAgentDeployGuard();
  const res = checkAgentDeployAllowed(MERCHANT_A, "key-first", { ...OPTS, now: 1_000 });
  assert.equal(res.allowed, true);
  assert.equal(res.reason, "ok");
  assert.equal(res.remaining, 2);
});

test("duplicate/replayed idempotency key is deduplicated, not re-provisioned", () => {
  resetAgentDeployGuard();
  const first = checkAgentDeployAllowed(MERCHANT_A, "deploy-123", { ...OPTS, now: 1_000 });
  assert.equal(first.allowed, true);
  const replay = checkAgentDeployAllowed(MERCHANT_A, "deploy-123", { ...OPTS, now: 2_000 });
  assert.equal(replay.allowed, false);
  assert.equal(replay.reason, "duplicate");
  assert.equal(replay.replay, true);
  // Replay must not burn rate budget: a fresh key still allowed.
  const fresh = checkAgentDeployAllowed(MERCHANT_A, "deploy-124", { ...OPTS, now: 2_000 });
  assert.equal(fresh.allowed, true);
});

test("rapid keyless repeats are throttled, later retry allowed", () => {
  resetAgentDeployGuard();
  const first = checkAgentDeployAllowed(MERCHANT_A, undefined, { ...OPTS, now: 1_000 });
  assert.equal(first.allowed, true);
  const burst = checkAgentDeployAllowed(MERCHANT_A, undefined, { ...OPTS, now: 1_500 });
  assert.equal(burst.allowed, false);
  assert.equal(burst.reason, "throttled");
  assert.ok((burst.retryAfterMs ?? 0) > 0);
  const later = checkAgentDeployAllowed(MERCHANT_A, undefined, { ...OPTS, now: 1_000 + 5_000 });
  assert.equal(later.allowed, true);
});

test("per-minute budget enforced without a max-1-agent quota", () => {
  resetAgentDeployGuard();
  // Distinct keys = distinct agents: all allowed up to the window budget.
  assert.equal(checkAgentDeployAllowed(MERCHANT_A, "a-1", { ...OPTS, now: 1_000 }).allowed, true);
  assert.equal(checkAgentDeployAllowed(MERCHANT_A, "a-2", { ...OPTS, now: 2_000 }).allowed, true);
  assert.equal(checkAgentDeployAllowed(MERCHANT_A, "a-3", { ...OPTS, now: 3_000 }).allowed, true);
  const over = checkAgentDeployAllowed(MERCHANT_A, "a-4", { ...OPTS, now: 4_000 });
  assert.equal(over.allowed, false);
  assert.equal(over.reason, "rate-limited");
  assert.ok((over.retryAfterMs ?? 0) > 0);
});

test("merchants are isolated from each other", () => {
  resetAgentDeployGuard();
  checkAgentDeployAllowed(MERCHANT_A, "x-1", { ...OPTS, now: 1_000 });
  checkAgentDeployAllowed(MERCHANT_A, "x-2", { ...OPTS, now: 2_000 });
  checkAgentDeployAllowed(MERCHANT_A, "x-3", { ...OPTS, now: 3_000 });
  assert.equal(
    checkAgentDeployAllowed(MERCHANT_A, "x-4", { ...OPTS, now: 4_000 }).reason,
    "rate-limited"
  );
  // Merchant B unaffected by A's budget…
  const b = checkAgentDeployAllowed(MERCHANT_B, "y-1", { ...OPTS, now: 4_000 });
  assert.equal(b.allowed, true);
  // …and the same key string under another merchant is a different claim.
  const sameKey = checkAgentDeployAllowed(MERCHANT_B, "x-1", { ...OPTS, now: 5_000 });
  assert.equal(sameKey.allowed, true);
});

test("missing merchant is refused, never defaulted", () => {
  resetAgentDeployGuard();
  for (const bad of ["", "   ", undefined, null]) {
    const res = checkAgentDeployAllowed(bad as unknown as string, "k", { ...OPTS, now: 1_000 });
    assert.equal(res.allowed, false);
    assert.equal(res.reason, "unauthenticated");
  }
});

test("released claim allows retry with the same key", () => {
  resetAgentDeployGuard();
  assert.equal(checkAgentDeployAllowed(MERCHANT_A, "retry-me", { ...OPTS, now: 1_000 }).allowed, true);
  assert.equal(releaseAgentDeployClaim(MERCHANT_A, "retry-me"), true);
  assert.equal(checkAgentDeployAllowed(MERCHANT_A, "retry-me", { ...OPTS, now: 2_000 }).allowed, true);
  // Releasing an unknown/empty claim is a no-op false, never an error.
  assert.equal(releaseAgentDeployClaim(MERCHANT_A, "nope"), false);
  assert.equal(releaseAgentDeployClaim(MERCHANT_A, undefined), false);
});

// WIRING INVARIANT (read-only source check, no imports of next/prisma):
// the deploy route must call the gate AFTER withMerchantAuth resolves the
// merchant and BEFORE any Circle wallet provisioning / on-chain register, so
// the guard can never fire late or against client-supplied identity.
test("deploy route fires the guard before Circle provisioning and on-chain register", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src", "app", "api", "agent", "deploy", "route.ts"),
    "utf8"
  );
  // First textual hit is the import/handler signature; the guard must appear
  // after the middleware reference and before Circle/on-chain calls.
  const idxAuth = src.indexOf("withMerchantAuth");
  const idxGuard = src.indexOf("checkAgentDeployAllowed(merchant.id");
  const idxCircle = src.indexOf("initiateDeveloperControlledWalletsClient(");
  const idxRegister = src.indexOf("createContractExecutionTransaction");
  assert.ok(idxAuth !== -1 && idxGuard !== -1 && idxCircle !== -1 && idxRegister !== -1);
  assert.ok(idxGuard > idxAuth, "guard must run after authoritative merchant auth");
  assert.ok(idxGuard < idxCircle, "guard must run before Circle client init");
  assert.ok(idxGuard < idxRegister, "guard must run before the on-chain register tx");
  // Merchant-scoped key only — no client-controlled merchantId in the gate call.
  assert.ok(!src.includes("checkAgentDeployAllowed(body"), "gate must never key on client input");
});
