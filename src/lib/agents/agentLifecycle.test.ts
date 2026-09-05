// src/lib/agents/agentLifecycle.test.ts
//
// Focused offline tests for the owner-lifecycle composition helpers.
// Pure derivation only: no network, no DB, no server.
//
// Run: npx tsx --test src/lib/agents/agentLifecycle.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SERVICEABLE_STATUS,
  deriveOwnerLifecycle,
  deployControlView,
  classifyDeployResult,
  newDeployIdempotencyKey,
} from "./agentLifecycle";

const HEALTHY = {
  id: 7,
  name: "Research Agent",
  tokenId: "68210",
  scaAddress: "0x1234567890abcdef1234567890abcdef12345678",
  circleWalletId: "wallet-1",
  walletSetId: "set-1",
  status: SERVICEABLE_STATUS,
  reputation: 80,
};

// ── Lifecycle state derivation ──────────────────────────────────────

test("healthy agent: all provable stages ready, next action is manage (no setup CTA)", () => {
  const lc = deriveOwnerLifecycle(HEALTHY, {
    economics: { entryCount: 3, revenue: "1000000", completedJobs: 2 },
    trust: { score: 84, confidence: 71, methodologyVersion: "1.0" },
  });
  assert.equal(lc.serviceable, true);
  for (const s of lc.stages) assert.equal(s.state, "ready", s.key);
  assert.equal(lc.nextAction.kind, "manage");
  assert.equal(lc.walletSetId, "set-1");
});

test("wallet missing → wallet setup is the next action", () => {
  const lc = deriveOwnerLifecycle({ ...HEALTHY, circleWalletId: null });
  const wallet = lc.stages.find((s) => s.key === "wallet")!;
  assert.equal(wallet.state, "attention");
  assert.match(wallet.detail, /wallet setup/i);
  assert.equal(lc.nextAction.kind, "setup-wallet");
  assert.equal(lc.serviceable, true); // status gate untouched by wallet view
});

test("sca missing entirely → wallet setup, not ready", () => {
  const lc = deriveOwnerLifecycle({ ...HEALTHY, scaAddress: null, circleWalletId: null });
  assert.equal(lc.stages.find((s) => s.key === "wallet")!.state, "attention");
  assert.equal(lc.nextAction.kind, "setup-wallet");
});

test("identity incomplete → complete-identity action", () => {
  const lc = deriveOwnerLifecycle({ ...HEALTHY, tokenId: "" });
  assert.equal(lc.stages.find((s) => s.key === "identity")!.state, "attention");
  assert.equal(lc.nextAction.kind, "complete-identity");
});

test("deployment in progress (pending intent) beats every other action", () => {
  const lc = deriveOwnerLifecycle(
    { ...HEALTHY, circleWalletId: null },
    { deployIntent: { status: "PENDING_IDENTITY_CONFIRMATION", registerTxHash: "0xabc123" } },
  );
  assert.equal(lc.nextAction.kind, "recover-deployment");
  assert.match(lc.nextAction.hint, /recover/i);
});

test("unserviceable status explains the actual reason and blocks hire-readiness", () => {
  const lc = deriveOwnerLifecycle({ ...HEALTHY, status: "SUSPENDED" });
  assert.equal(lc.serviceable, false);
  assert.equal(lc.stages.find((s) => s.key === "serviceability")!.state, "attention");
  assert.match(lc.stages.find((s) => s.key === "serviceability")!.detail, /SUSPENDED/);
  assert.equal(lc.stages.find((s) => s.key === "discoverability")!.state, "attention");
  assert.equal(lc.nextAction.kind, "inspect-status");
});

test("non-ACTIVE custom status is never serviceable", () => {
  for (const status of ["PROVISIONING", "PENDING", "paused", "", null, undefined]) {
    const lc = deriveOwnerLifecycle({ ...HEALTHY, status });
    assert.equal(lc.serviceable, false, String(status));
  }
});

test("zero economic activity (loaded) → drive-activity, not manage", () => {
  const lc = deriveOwnerLifecycle(HEALTHY, { economics: { entryCount: 0, revenue: "0", completedJobs: 0 } });
  assert.equal(lc.stages.find((s) => s.key === "economics")!.state, "attention");
  assert.equal(lc.nextAction.kind, "drive-activity");
});

test("economics never loaded → unknown stage, never claims no-activity", () => {
  const lc = deriveOwnerLifecycle(HEALTHY);
  const eco = lc.stages.find((s) => s.key === "economics")!;
  assert.equal(eco.state, "unknown");
  assert.match(eco.detail, /not loaded/i);
  // …and the next action must not be drive-activity on unloaded data
  assert.notEqual(lc.nextAction.kind, "drive-activity");
});

test("trust rendering is display-only: backend score shown, nothing invented", () => {
  const withTrust = deriveOwnerLifecycle(HEALTHY, { trust: { score: 84, confidence: 71 } });
  assert.match(withTrust.stages.find((s) => s.key === "trust")!.detail, /84\/100/);
  const dbOnly = deriveOwnerLifecycle(HEALTHY);
  assert.match(dbOnly.stages.find((s) => s.key === "trust")!.detail, /80\/100/);
  const none = deriveOwnerLifecycle({ ...HEALTHY, reputation: null });
  assert.equal(none.stages.find((s) => s.key === "trust")!.state, "unknown");
});

test("malformed trust payload never fabricates a score", () => {
  const lc = deriveOwnerLifecycle({ ...HEALTHY, reputation: null }, { trust: { score: "high" } });
  assert.equal(lc.stages.find((s) => s.key === "trust")!.state, "unknown");
});

// ── Duplicate deployment control visibility ─────────────────────────

test("deploy control disables while deploying (UX only — guard stays server-side)", () => {
  const v = deployControlView({ deploying: true });
  assert.equal(v.disabled, true);
  assert.match(v.hint, /server-side/i);
});

test("duplicate (409) surfaces the guard + recovery path", () => {
  const v = deployControlView({ deploying: false, lastWasDuplicate: true });
  assert.equal(v.disabled, false);
  assert.match(v.hint, /duplicate/i);
  assert.match(v.hint, /recover/i);
});

test("pending identity surfaces the recover endpoint", () => {
  const v = deployControlView({ deploying: false, lastWasPending: true });
  assert.match(v.hint, /deploy\/recover/);
});

test("idle deploy control carries no redundant warning", () => {
  assert.equal(deployControlView({ deploying: false }).hint, "");
});

test("classifyDeployResult: 409 → duplicate; pending-status 502 → pending", () => {
  assert.deepEqual(classifyDeployResult(409, { error: "Duplicate" }), { duplicate: true, pending: false });
  assert.deepEqual(classifyDeployResult(502, { status: "PENDING_IDENTITY_CONFIRMATION" }), {
    duplicate: false,
    pending: true,
  });
  assert.deepEqual(classifyDeployResult(200, { success: true }), { duplicate: false, pending: false });
});

test("idempotency keys are unique per attempt", () => {
  const a = newDeployIdempotencyKey();
  const b = newDeployIdempotencyKey();
  assert.ok(a.length > 0 && b.length > 0);
  assert.notEqual(a, b);
});

// ── Identifier labeling ─────────────────────────────────────────────

test("identifiers stay distinct: Registry ID vs ERC-8004 token ID vs SCA", () => {
  const lc = deriveOwnerLifecycle(HEALTHY);
  const labels = lc.identifiers.map((r) => r.label);
  assert.ok(labels.includes("Registry ID"));
  assert.ok(labels.includes("ERC-8004 token ID"));
  assert.ok(labels.some((l) => /SCA/i.test(l)));
  assert.ok(!labels.some((l) => l === "Agent ID"));
});

test("walletSetId is troubleshooting-only, never a headline identifier", () => {
  const lc = deriveOwnerLifecycle(HEALTHY);
  assert.equal(lc.walletSetId, "set-1");
  assert.ok(!lc.identifiers.some((r) => /wallet.?set/i.test(r.label)));
});

// ── Missing / malformed optional data ───────────────────────────────

test("null agent → honest unknown lifecycle, never throws", () => {
  for (const bad of [null, undefined, 42, "agent", []]) {
    const lc = deriveOwnerLifecycle(bad);
    assert.ok(lc.stages.every((s) => s.state === "unknown"));
    assert.equal(lc.serviceable, false);
    assert.deepEqual(lc.identifiers, []);
  }
});

test("agent with only an id still resolves identifiers without crashing", () => {
  const lc = deriveOwnerLifecycle({ id: 3 });
  assert.ok(lc.identifiers.some((r) => r.label === "Registry ID"));
  assert.equal(lc.nextAction.kind, "setup-wallet");
});
