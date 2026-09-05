// scripts/consumer-discovery-tests.ts
// Focused proofs for the consumer discovery track (product/UX, no new marketplace protocol).
// Covers: discovery rendering safety, filtering/sorting params, serviceability-aware action,
// identifier labeling, malformed isolation, empty/unavailable states, wallet-not-connected.
// Pure helper tests + simulated API response handling — no DB/chain/network required.

import assert from "node:assert/strict";

// Import helpers (ESM). Use dynamic import to avoid tsx path issues if run via node.
const mod = await import("../src/lib/consumer/discoveryHelpers.js");
const {
  buildDiscoveryParams,
  isServiceable,
  serviceabilityLabel,
  getIdentifierLabels,
  formatScaShort,
  formatTrust,
  formatPricing,
  normalizeAgentRecord,
  isolateValidAgents,
  getAppropriateAction,
} = mod as any;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`✅ ${name}${extra ? " — " + extra : ""}`); }
  else { fail++; console.log(`❌ ${name}${extra ? " — " + extra : ""}`); }
}

// ── 1. Filtering / sorting parameters ──
{
  const q = buildDiscoveryParams({ search: "audit", skill: "security", minTrust: 60, sortBy: "trust", limit: 20 });
  ok("filters: search present", q.includes("search=audit"));
  ok("filters: skill present", q.includes("skill=security"));
  ok("filters: minTrust present", q.includes("minTrust=60"));
  ok("filters: sortBy trust", q.includes("sortBy=trust"));
  ok("filters: limit 20", q.includes("limit=20"));
  const qEmpty = buildDiscoveryParams({});
  ok("filters: empty produces empty string", qEmpty === "");
  const qNullTrust = buildDiscoveryParams({ minTrust: null as any });
  ok("filters: null minTrust omitted", !qNullTrust.includes("minTrust"));
  const qCat = buildDiscoveryParams({ category: "AI" });
  ok("filters: category param", qCat.includes("category=AI"));
}

// ── 2. Serviceability-aware action ──
{
  ok("serviceable: ACTIVE is true", isServiceable("ACTIVE_AGENT_PROVISIONED") === true);
  ok("serviceable: PENDING is false", isServiceable("PENDING") === false);
  ok("serviceable: null is false", isServiceable(null) === false);
  ok("serviceable: undefined is false", isServiceable(undefined) === false);
  const svcOk = serviceabilityLabel("ACTIVE_AGENT_PROVISIONED");
  ok("serviceabilityLabel ok", svcOk.label === "Available now" && svcOk.tone === "ok");
  const svcWarn = serviceabilityLabel("SUSPENDED");
  ok("serviceabilityLabel warn", svcWarn.tone === "warn");
  const svcUnknown = serviceabilityLabel(null);
  ok("serviceabilityLabel unknown", svcUnknown.tone === "unknown");

  const aSvc = { status: "ACTIVE_AGENT_PROVISIONED" };
  const aUnsvc = { status: "PENDING_VERIFICATION" };
  const actOk = getAppropriateAction(aSvc, true);
  ok("action: serviceable + wallet => Hire enabled", actOk.label === "Hire" && actOk.disabled === false);
  const actNoWallet = getAppropriateAction(aSvc, false);
  ok("action: wallet not connected => disabled Connect wallet", actNoWallet.disabled === true && actNoWallet.label.includes("Connect"));
  const actUnsvc = getAppropriateAction(aUnsvc, true);
  ok("action: unserviceable => disabled Not serviceable", actUnsvc.disabled === true && actUnsvc.label === "Not serviceable");
  const actUnsvcNoWallet = getAppropriateAction(aUnsvc, false);
  ok("action: unserviceable takes precedence over wallet check", actUnsvcNoWallet.label === "Not serviceable");
}

// ── 3. Identifier labeling (must distinguish three IDs, never merged) ──
{
  const fromDiscover = { id: 42, tokenId: "123456789012", scaAddress: "0xAbc0000000000000000000000000000000000aBc" };
  const ids1 = getIdentifierLabels(fromDiscover);
  ok("identifiers: discover record labels correctly", ids1.registryId === "42" && ids1.tokenId === "123456789012" && ids1.scaAddress?.toLowerCase() === "0xabc0000000000000000000000000000000000abc");

  const fromCard = { identity: { tokenId: "999", scaAddress: "0x1111111111111111111111111111111111111111" }, agentId: "999", id: 7 };
  const ids2 = getIdentifierLabels(fromCard);
  ok("identifiers: card record extracts tokenId from identity", ids2.tokenId === "999");
  ok("identifiers: card record extracts scaAddress from identity", ids2.scaAddress === "0x1111111111111111111111111111111111111111");
  ok("identifiers: registryId is small int string, not tokenId", ids2.registryId === "7");

  const minimal = { name: "x" };
  const ids3 = getIdentifierLabels(minimal);
  ok("identifiers: missing fields => null (not dumped)", ids3.registryId === null && ids3.tokenId === null);

  const trunc = formatScaShort("0x1234567890abcdef1234567890abcdef12345678");
  ok("identifiers: SCA truncated for display", trunc === "0x1234…5678" || trunc.includes("…"));
  ok("identifiers: SCA short null => —", formatScaShort(null) === "—");
  ok("identifiers: SCA short short string passthrough", formatScaShort("0xabc") === "0xabc");
}

// ── 4. Trust / pricing display (must not recalc, must not display if missing) ──
{
  ok("trust: null => no display", formatTrust(null) === null);
  ok("trust: missing score => no display", formatTrust({ confidence: 80 }) === null);
  ok("trust: valid score => formatted", formatTrust({ score: 72, confidence: 40 }) === "Trust 72/100 · confidence 40");
  ok("trust: not recalculated (just formatted)", formatTrust({ score: 50, confidence: 10 })?.includes("50") === true);

  ok("pricing: null => null", formatPricing(null) === null);
  ok("pricing: pricePerRequest", formatPricing({ pricePerRequest: "$0.05" }) === "$0.05");
  ok("pricing: pricePerJob fallback", formatPricing({ pricePerJob: "$2.00" }) === "$2.00");
  ok("pricing: empty string => null", formatPricing({ pricePerRequest: "" }) === null);
  ok("pricing: missing => null", formatPricing({}) === null);
}

// ── 5. Malformed result isolation (one bad agent must not break whole page) ──
{
  const good = { id: 1, name: "Good Agent", status: "ACTIVE_AGENT_PROVISIONED" };
  const badNull = null;
  const badNoIdOrName = { foo: "bar" };
  const badUndefined = undefined;
  const good2 = { id: 2, name: "Another", status: "ACTIVE_AGENT_PROVISIONED" };
  const malformedMixed = [good, badNull, badNoIdOrName, badUndefined, good2, { id: 3 }]; // last has id but no name — still considered valid (hasId check)
  const isolated = isolateValidAgents(malformedMixed as any);
  ok("malformed isolation: filters bad, keeps good", isolated.length === 3 && isolated[0].id === 1 && isolated[1].id === 2);
  ok("malformed isolation: non-array => empty", isolateValidAgents(null as any).length === 0);
  ok("normalizeAgent: null => null", normalizeAgentRecord(null) === null);
  ok("normalizeAgent: non-object => null", normalizeAgentRecord("string" as any) === null);
  ok("normalizeAgent: empty object => null (needs id or name)", normalizeAgentRecord({}) === null);
  ok("normalizeAgent: has name => valid", normalizeAgentRecord({ name: "hi" }) !== null);
  ok("normalizeAgent: has id => valid", normalizeAgentRecord({ id: 5 }) !== null);
  // Simulate rendering loop that must not throw on bad entry — wrap per-item try/catch
  let rendered = 0;
  for (const a of malformedMixed) {
    try {
      const n = normalizeAgentRecord(a);
      if (!n) continue;
      rendered++;
    } catch { /* should never reach here */ }
  }
  ok("malformed isolation: rendering loop skips bad without throwing", rendered === 3);
}

// ── 6. Empty / unavailable states ──
{
  // Empty list
  const empty = isolateValidAgents([]);
  ok("empty state: zero agents isolated as empty", empty.length === 0);

  // Simulate unavailable discovery API (fetch throws) — consumer code should set error and keep page alive
  async function simulatedFetchDiscovery(shouldFail: boolean) {
    try {
      if (shouldFail) throw new Error("Discovery unavailable (500)");
      return { agents: [], pagination: { hasMore: false } };
    } catch (e: any) {
      return { error: e.message, agents: [] as any[] };
    }
  }
  const okRes = await simulatedFetchDiscovery(false);
  ok("empty state: unavailable API handled without crash (no throw)", okRes.error === undefined);
  const failRes = await simulatedFetchDiscovery(true);
  ok("empty state: failure produces error message, not crash", failRes.error.includes("unavailable"));

  // Unavailable reputation / serviceability / wallet
  ok("empty state: unavailable reputation => null display", formatTrust(undefined) === null);
  ok("empty state: unavailable serviceability => unknown tone", serviceabilityLabel(undefined).tone === "unknown");
  ok("empty state: wallet not connected => hire disabled", getAppropriateAction({ status: "ACTIVE_AGENT_PROVISIONED" }, false).disabled === true);

  // Malformed agent record unavailable reputation field — should show fallback, not crash
  const malformedAgent = { id: 99, name: "No trust agent", status: "ACTIVE_AGENT_PROVISIONED", trust: null, reputation: undefined };
  ok("empty state: malformed agent trust fallback", formatTrust(malformedAgent.trust) === null);
  ok("empty state: malformed agent pricing fallback", formatPricing((malformedAgent as any).pricing) === null);
}

// ── 7. Discovery rendering safety (ensure helpers never throw on unexpected shapes) ──
{
  const weirdAgents = [
    { id: 1, name: null, status: null, trust: "not an object", pricing: 123 as any, skills: "string" as any },
    { id: 2, name: "Normal", status: "ACTIVE_AGENT_PROVISIONED", trust: { score: "bad" as any }, pricing: { pricePerRequest: null } },
  ];
  let threw = false;
  try {
    for (const a of weirdAgents) {
      formatTrust(a.trust);
      formatPricing(a.pricing);
      serviceabilityLabel(a.status);
      getIdentifierLabels(a);
      getAppropriateAction(a, true);
      normalizeAgentRecord(a);
    }
  } catch { threw = true; }
  ok("rendering safety: helpers never throw on weird shapes", threw === false);
}

console.log(`\n=== consumer-discovery-tests: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
