// src/lib/discovery/consumerDiscovery.test.ts
//
// Focused unit tests for the consumer-discovery view-model helpers. These run
// offline (no network, no DB, no server) — every helper is pure.
//
// Run: npx tsx --test src/lib/discovery/consumerDiscovery.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SERVICEABLE_STATUS,
  buildDiscoverQuery,
  agentIsServiceable,
  humanStatusLabel,
  trustView,
  reputationView,
  parsePricing,
  formatUsdcPrice,
  microUnitsToUsdc,
  normalizeCapabilities,
  agentIdentifierRows,
  shortAddress,
  deriveAgentAction,
  normalizeDiscoverAgent,
  normalizeDiscoverPayload,
  buildAgentCardView,
  cardTrackRecordView,
  onChainReputationView,
  trustBreakdownView,
} from "./consumerDiscovery";

// ── Shared fixtures ──────────────────────────────────────────────────────
const GOOD_ROW = {
  id: 7,
  tokenId: "68210",
  name: "Research Agent",
  description: "Digests datasets and drafts reports.",
  skills: [{ name: "research", description: "primary research" }, "writing"],
  pricing: { pricePerRequest: "$0.05", pricePerJob: "$20.00" },
  reputation: 92,
  trust: { score: 84, confidence: 71, methodologyVersion: "1.0" },
  trackRecord: {
    completedJobs: 4,
    validatedJobs: 2,
    validationPassRate: 0.5,
    validatedVolume: "1000000",
  },
  status: SERVICEABLE_STATUS,
  cardUrl: "/api/agents/7/card",
  hireUrl: "/api/agents/7/hire",
  trackRecordUrl: "/api/agents/7/track-record",
};

function goodCard() {
  return {
    success: true,
    agentCard: {
      agentId: "68210",
      erc8004TokenId: "68210",
      name: "Research Agent",
      description: "Digests datasets and drafts reports.",
      capabilities: ["research", "writing"],
      pricing: { pricePerRequest: "$0.05", pricePerJob: "$20.00" },
      currency: "USDC",
      wallet: { scaAddress: "0x1111111111111111111111111111111111111111", circleWalletId: "c1" },
      identity: { registryAddress: "0xREG", tokenId: "68210", scaAddress: "0x1111111111111111111111111111111111111111" },
      reputation: { score: 92, verifyEndpoint: "/x" },
      status: SERVICEABLE_STATUS,
      supportedTokens: ["USDC", "EURC"],
      hiring: { hireEndpoint: "/api/agents/7/hire" },
      trust: { score: 84, confidence: 71, methodologyVersion: "1.0", breakdown: { jobPerformance: 20, reputation: 15 } },
      trackRecord: {
        completedJobs: 4,
        validatedJobs: 2,
        validationPassRate: 0.5,
        validatedVolumeUSDC: "1.00",
        totalJobs: 6,
        failedJobs: 2,
        uniqueValidators: 2,
        reputationCount: 3,
      },
      reputationSummary: { onChain: { readOk: true, reputationScore: 90, reputationCount: 3 }, dbReputation: 92 },
    },
  };
}

// ── 1. Discovery rendering (payload → view models) ──────────────────────
test("rendering: a well-formed discover payload maps to renderable views", () => {
  const result = normalizeDiscoverPayload({ success: true, agents: [GOOD_ROW], pagination: { hasMore: false } });
  assert.equal(result.ok, true);
  assert.equal(result.agents.length, 1);
  assert.equal(result.malformed, 0);

  const v = result.agents[0];
  assert.equal(v.ok, true);
  assert.equal(v.id, 7);
  assert.equal(v.tokenId, "68210");
  assert.equal(v.name, "Research Agent");
  assert.equal(v.serviceable, true);
  assert.equal(v.trust.present, true);
  assert.equal(v.trust.score, 84);
  assert.equal(v.pricing.perRequest, 0.05);
  assert.equal(v.pricing.perJob, 20);
  assert.equal(v.capabilities.length, 2);
  assert.equal(v.capabilities[0].description, "primary research");
  assert.equal(v.trackRecord?.completedJobs, 4);
  assert.equal(v.trackRecord?.validatedVolumeUSDC, 1);
});

test("rendering: absent trust is not invented (score stays null, present=false)", () => {
  const row = { ...GOOD_ROW, trust: null };
  const v = normalizeDiscoverAgent(row, 0)!;
  assert.equal(v.trust.present, false);
  assert.equal(v.trust.score, null);
  assert.equal(trustView(undefined).present, false);
  assert.equal(trustView({ score: "garbage" }).present, false);
  assert.equal(trustView({}).present, false);
});

test("rendering: agent card payload builds a card view with labeled sections", () => {
  const row = normalizeDiscoverAgent(GOOD_ROW, 0)!;
  const card = buildAgentCardView(row, goodCard());
  assert.ok(card);
  assert.equal(card.ok, true);
  assert.equal(card.name, "Research Agent");
  assert.equal(card.serviceable, true);
  assert.equal(card.trust.score, 84);
  assert.equal(card.trackRecord.present, true);
  assert.equal(card.trackRecord.validatedVolumeUSDC, 1);
  assert.equal(card.reputationOnChain.readOk, true);
  assert.equal(card.reputationOnChain.score, 90);
  assert.equal(card.dbReputation.score, 92);
  assert.equal(card.trustBreakdown.length, 2);
  assert.equal(card.trustBreakdown[0].label, "Job performance");
  assert.equal(card.hireEndpoint, "/api/agents/7/hire");
  assert.deepEqual(card.supportedTokens, ["USDC", "EURC"]);
});

// ── 2. Filtering / sorting parameters ────────────────────────────────────
test("filtering: buildDiscoverQuery emits only set, supported params", () => {
  const qs = buildDiscoverQuery({ search: "  report ", sortBy: "trust", minTrust: 70, limit: 20 });
  assert.ok(qs.startsWith("?"));
  const p = new URLSearchParams(qs);
  assert.equal(p.get("search"), "report");
  assert.equal(p.get("sortBy"), "trust");
  assert.equal(p.get("sortOrder"), "desc");
  assert.equal(p.get("minTrust"), "70");
  assert.equal(p.get("limit"), "20");
  assert.equal(p.get("status"), null);
  assert.equal(p.get("offset"), null);
});

test("filtering: defaults are reputation-free but explicit, asc honored, empty search omitted", () => {
  const qs = buildDiscoverQuery({ sortOrder: "asc" });
  const p = new URLSearchParams(qs);
  assert.equal(p.get("sortBy"), "trust");
  assert.equal(p.get("sortOrder"), "asc");
  assert.equal(p.get("search"), null);
  assert.equal(p.get("minTrust"), null);
});

test("filtering: minTrust is clamped 0..100 and garbage values are dropped", () => {
  assert.equal(new URLSearchParams(buildDiscoverQuery({ minTrust: 500 })).get("minTrust"), "100");
  assert.equal(new URLSearchParams(buildDiscoverQuery({ minTrust: -5 })).get("minTrust"), "0");
  assert.equal(new URLSearchParams(buildDiscoverQuery({ minTrust: 71.6 })).get("minTrust"), "72");
  assert.equal(new URLSearchParams(buildDiscoverQuery({ minTrust: "not-a-number" })).get("minTrust"), null);
  assert.equal(new URLSearchParams(buildDiscoverQuery({ minTrust: "" })).get("minTrust"), null);
});

test("filtering: limit is capped at 100, offset only when positive", () => {
  assert.equal(new URLSearchParams(buildDiscoverQuery({ limit: 5000 })).get("limit"), "100");
  assert.equal(new URLSearchParams(buildDiscoverQuery({ limit: 0 })).get("limit"), "20");
  assert.equal(new URLSearchParams(buildDiscoverQuery({ offset: 40 })).get("offset"), "40");
  assert.equal(new URLSearchParams(buildDiscoverQuery({ offset: -1 })).get("offset"), null);
});

test("filtering: explicit status passes through (serviceability/status param exists on discover)", () => {
  assert.equal(
    new URLSearchParams(buildDiscoverQuery({ status: SERVICEABLE_STATUS })).get("status"),
    SERVICEABLE_STATUS
  );
});

// ── 3. Serviceability-aware action ───────────────────────────────────────
test("action: serviceability derives strictly from backend status", () => {
  assert.equal(agentIsServiceable(SERVICEABLE_STATUS), true);
  assert.equal(agentIsServiceable(SERVICEABLE_STATUS.toLowerCase()), true);
  assert.equal(agentIsServiceable("PROVISIONING"), false);
  assert.equal(agentIsServiceable(undefined), false);
  assert.equal(agentIsServiceable(null), false);
});

test("action: never offers Hire when the agent is not serviceable", () => {
  for (const status of ["PROVISIONING", "PENDING", undefined, ""]) {
    const action = deriveAgentAction(status, "ready");
    assert.equal(action.kind, "unavailable", `status ${status}`);
    assert.equal(action.disabled, true);
    assert.notEqual(action.label, "Hire for a job");
    assert.match(action.reason, /not ready to take jobs/i);
  }
});

test("action: Hire offered only when serviceable AND caller has a Circle wallet", () => {
  const hire = deriveAgentAction(SERVICEABLE_STATUS, "ready");
  assert.equal(hire.kind, "hire");
  assert.equal(hire.disabled, false);
  assert.equal(hire.canHire, true);

  const signIn = deriveAgentAction(SERVICEABLE_STATUS, "none");
  assert.equal(signIn.kind, "signin");
  assert.equal(signIn.disabled, true);
  assert.equal(signIn.label, "Sign in to hire");

  const noCircle = deriveAgentAction(SERVICEABLE_STATUS, "no-circle");
  assert.equal(noCircle.kind, "wallet-required");
  assert.equal(noCircle.disabled, true);

  const checking = deriveAgentAction(SERVICEABLE_STATUS, "unknown");
  assert.equal(checking.kind, "checking");
  assert.equal(checking.disabled, true);
});

// ── 4. Identifier labeling ───────────────────────────────────────────────
test("identifiers: registry id, token id and SCA are separate, human-labeled rows", () => {
  const rows = agentIdentifierRows({ id: 7, tokenId: "68210", scaAddress: "0x1111111111111111111111111111111111111111" });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.label),
    ["Registry ID", "ERC-8004 token ID", "Agent wallet (SCA)"]
  );
  assert.deepEqual(rows.map((r) => r.kind), ["registry", "token", "sca"]);
  // Never merged into one ambiguous field — distinct keys/values.
  assert.equal(rows[0].value, "#7");
  assert.equal(rows[1].value, "#68210");
  assert.ok(rows.some((r) => r.kind === "sca"));
});

test("identifiers: malformed/missing id parts are omitted, not guessed", () => {
  assert.equal(agentIdentifierRows({}).length, 0);
  assert.deepEqual(agentIdentifierRows({ id: -3, tokenId: "", scaAddress: "nope" }), []);
  assert.equal(agentIdentifierRows({ id: 7 }).length, 1);
  assert.equal(agentIdentifierRows({ scaAddress: "0xabc" }).length, 1);
});

test("identifiers: addresses are short-formatted for the primary UX", () => {
  assert.equal(shortAddress("0x1111111111111111111111111111111111111111"), "0x1111…1111");
  assert.equal(shortAddress("0xabc"), "0xabc");
});

// ── 5. Malformed-result isolation ────────────────────────────────────────
test("isolation: one malformed row does not break the grid", () => {
  const payload = {
    success: true,
    agents: [
      GOOD_ROW,
      { random: true }, // no id/token/sca → unidentifiable garbage
      null,
      "hello",
      42,
      { id: 99, name: "Keepable", status: SERVICEABLE_STATUS },
    ],
  };
  const result = normalizeDiscoverPayload(payload);
  assert.equal(result.ok, true);
  assert.equal(result.malformed, 4);
  assert.equal(result.agents.length, 2);
  assert.equal(result.agents[0].id, 7);
  assert.equal(result.agents[1].id, 99);
});

test("isolation: a row with only a token id is still kept and referenced by token", () => {
  const v = normalizeDiscoverAgent({ tokenId: "90001", name: "" }, 0);
  assert.ok(v);
  assert.equal(v.tokenId, "90001");
  assert.ok(v.name.length > 0);
});

test("isolation: a garbage card payload yields null, not a crash", () => {
  const row = normalizeDiscoverAgent(GOOD_ROW, 0)!;
  assert.equal(buildAgentCardView(row, null), null);
  assert.equal(buildAgentCardView(row, { nope: true }), null);
  assert.equal(buildAgentCardView(row, "garbage"), null);
});

test("isolation: non-list discover payloads fail closed with an error message", () => {
  const err = normalizeDiscoverPayload({ success: false, error: "boom" });
  assert.equal(err.ok, false);
  assert.equal(err.error, "boom");
  assert.equal(normalizeDiscoverPayload(null).ok, false);
  assert.equal(normalizeDiscoverPayload(undefined).ok, false);
  assert.equal(normalizeDiscoverPayload("junk").ok, false);
});

test("isolation: missing on-chain reputation is reported as absent, not scored", () => {
  const rep = onChainReputationView(undefined);
  assert.equal(rep.present, false);
  assert.equal(rep.score, null);
  const repOk = onChainReputationView({ readOk: true, reputationScore: 90, reputationCount: 2 });
  assert.equal(repOk.readOk, true);
  assert.equal(repOk.score, 90);
});

// ── 6. Empty state ───────────────────────────────────────────────────────
test("empty state: an empty but valid payload is not an error", () => {
  const result = normalizeDiscoverPayload({ success: true, agents: [], pagination: { hasMore: false } });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.agents.length, 0);
  assert.equal(result.malformed, 0);
});

// ── Supporting view helpers (labels, pricing, volume) ────────────────────
test("labels/pricing: status and price rendering are conservative", () => {
  assert.equal(humanStatusLabel(SERVICEABLE_STATUS), "Active");
  assert.equal(humanStatusLabel(null), "Unknown");
  assert.equal(humanStatusLabel("SOME_OTHER"), "SOME_OTHER");
  assert.equal(parsePricing(null).present, false);
  assert.equal(parsePricing({ pricePerJob: "$20.00" }).perJob, 20);
  assert.equal(parsePricing({ pricePerRequest: "0.05" }).perRequest, 0.05);
  assert.equal(parsePricing({ pricePerRequest: "n/a" }).present, false);
  assert.equal(formatUsdcPrice(5), "$5.00");
  assert.equal(formatUsdcPrice(null), null);
  assert.equal(microUnitsToUsdc("1000000"), 1);
  assert.equal(microUnitsToUsdc("n/a"), null);
  assert.equal(normalizeCapabilities("not an array").length, 0);
  assert.equal(normalizeCapabilities([1, { nope: true }]).length, 0);
  assert.equal(cardTrackRecordView(null).present, false);
  assert.equal(cardTrackRecordView({ completedJobs: 3 }).completedJobs, 3);
  assert.equal(trustBreakdownView({ reputation: "15", bogus: "x" }).length, 1);
  assert.equal(reputationView("92").score, 92);
  assert.equal(reputationView(undefined).present, false);
});
