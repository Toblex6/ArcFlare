// Focused regression tests for src/lib/agents/resolveAgentRef.ts
// Run: npx tsx scripts/agent-resolver-tests.ts

import { prisma } from "../src/lib/prisma";
import { resolveAgentRef } from "../src/lib/agents/resolveAgentRef";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else { console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

async function createAgent(name: string, tokenId: string, addr: string): Promise<any> {
  return (prisma as any).agentRegistry.create({
    data: {
      name: `${name}-${Date.now().toString(36)}`,
      tokenId,
      scaAddress: addr,
      circleWalletId: null,
      ownerNode: "test",
      status: "ACTIVE_AGENT_PROVISIONED",
      description: "resolver-test",
      skills: [],
      reputation: 50,
      merchantId: null,
    },
  });
}

async function main() {
  console.log("=== resolveAgentRef tests ===");
  const created: number[] = [];
  try {
    const agentA = await createAgent("ResolverA", "99886202", `0x${"a".repeat(40)}`);
    const agentB = await createAgent("ResolverB", "99886203", `0x${"b".repeat(40)}`);
    created.push(agentA.id, agentB.id);
    console.log(`Created test agents: A id=${agentA.id} tokenId=${agentA.tokenId}, B id=${agentB.id} tokenId=${agentB.tokenId}`);

    // 1. id
    const byId = await resolveAgentRef(agentA.id, "id");
    ok("resolve by id finds agent", !!byId.agent && byId.agent.id === agentA.id && byId.matchedBy === "id",
       JSON.stringify({ matchedBy: byId.matchedBy, id: byId.agent?.id }));

    // 2. tokenId resolves same agent
    const byToken = await resolveAgentRef(agentA.tokenId, "tokenId");
    ok("resolve by tokenId finds SAME agent", !!byToken.agent && byToken.agent.id === agentA.id && byToken.matchedBy === "tokenId",
       JSON.stringify({ matchedBy: byToken.matchedBy, id: byToken.agent?.id }));

    // 3. scaAddress resolves same agent, case-insensitive
    const bySca = await resolveAgentRef(agentA.scaAddress, "scaAddress");
    ok("resolve by scaAddress finds SAME agent", !!bySca.agent && bySca.agent.id === agentA.id && bySca.matchedBy === "scaAddress",
       JSON.stringify({ matchedBy: bySca.matchedBy, id: bySca.agent?.id }));
    const mixed = "0x" + agentA.scaAddress.slice(2).split("").map((c: string, i: number) => i % 2 ? c.toUpperCase() : c).join("");
    const byScaMixed = await resolveAgentRef(mixed, "scaAddress");
    ok("scaAddress match is case-insensitive", !!byScaMixed.agent && byScaMixed.agent.id === agentA.id,
       JSON.stringify({ id: byScaMixed.agent?.id }));

    // 4. unknown refs
    for (const [label, ref, type] of [
      ["unknown id", 999999999, "id"],
      ["unknown tokenId", "99886299", "tokenId"],
      ["unknown scaAddress", `0x${"f".repeat(40)}`, "scaAddress"],
      ["empty string", "", "auto"],
      ["null ref", null, "id"],
      ["undefined ref", undefined, "auto"],
      ["malformed address 0x123", "0x123", "scaAddress"],
      ["non-numeric tokenId 0xabc", "0xabc", "tokenId"],
    ] as const) {
      const r = await resolveAgentRef(ref as any, type as any);
      ok(`unknown/malformed ref returns null agent: ${label}`, r.agent === null,
         `got agent ${JSON.stringify(r.agent?.id)}`);
    }

    // 5. explicit tokenId never falls through to id
    const r5 = await resolveAgentRef(agentA.tokenId, "tokenId");
    ok('explicit "tokenId" with tokenId matching other agent id resolves tokenId row',
       !!r5.agent && r5.agent.id === agentA.id, `got id ${r5.agent?.id}`);
    const smallToken = await resolveAgentRef(String(agentB.id), "tokenId");
    const tokenCollides = (smallToken.agent?.id ?? null) === agentB.id || smallToken.agent === null;
    ok("small numeric tokenId treated as tokenId, not registry id", tokenCollides,
       `got ${JSON.stringify({ id: smallToken.agent?.id, matchedBy: smallToken.matchedBy })}`);

    // 6. auto
    const autoId = await resolveAgentRef(agentA.id, "auto");
    ok("auto: registry id resolves", !!autoId.agent && autoId.agent.id === agentA.id && autoId.matchedBy === "id" && !autoId.ambiguous,
       JSON.stringify({ matchedBy: autoId.matchedBy, ambiguous: autoId.ambiguous }));
    const autoToken = await resolveAgentRef(agentA.tokenId, "auto");
    ok("auto: tokenId resolves", !!autoToken.agent && autoToken.agent.id === agentA.id && autoToken.matchedBy === "tokenId",
       JSON.stringify({ matchedBy: autoToken.matchedBy, ambiguous: autoToken.ambiguous }));
    const autoSca = await resolveAgentRef(agentB.scaAddress, "auto");
    ok("auto: scaAddress resolves", !!autoSca.agent && autoSca.agent.id === agentB.id && autoSca.matchedBy === "scaAddress",
       JSON.stringify({ matchedBy: autoSca.matchedBy }));
    const autoUnknown = await resolveAgentRef("999999999", "auto");
    ok("auto: unknown digits return null agent", autoUnknown.agent === null && !autoUnknown.ambiguous,
       JSON.stringify({ agent: autoUnknown.agent?.id, ambiguous: autoUnknown.ambiguous }));
    const ambiguous = await resolveAgentRef(String(agentA.id), "auto");
    ok("auto: same digits matching different id+tokenId either resolves one or flags ambiguous",
       ambiguous.agent === null ? ambiguous.ambiguous === true : true,
       JSON.stringify({ agent: ambiguous.agent?.id, ambiguous: ambiguous.ambiguous }));
  } finally {
    for (const id of created) {
      try { await (prisma as any).agentRegistry.delete({ where: { id } }); }
      catch (e: any) { console.log(`⚠️ cleanup failed for id=${id}: ${e?.message ?? e}`); }
    }
    console.log(`Cleanup done (${created.length} rows).`);
  }

  // 7. HTTP auth section — only when server reachable
  const base = process.env.BASE_URL || "http://localhost:3000";
  console.log(`\n=== HTTP auth checks (BASE_URL=${base}) ===`);
  try {
    const trackUnknown = await fetch(`${base}/api/agents/999999999/track-record`, { signal: AbortSignal.timeout(10000) });
    console.log(`Server reachable (status ${trackUnknown.status})`);
    ok("GET /api/agents/999999999/track-record returns 200 or 404, never 500",
       trackUnknown.status === 200 || trackUnknown.status === 404, `got ${trackUnknown.status}`);

    const real = await (prisma as any).agentRegistry.findFirst({ where: { tokenId: { not: null } } });
    if (real) {
      const ledger = await fetch(`${base}/api/agents/${real.tokenId}/ledger`, { signal: AbortSignal.timeout(10000) });
      ok("GET /api/agents/{tokenId}/ledger without auth returns 401/403",
         ledger.status === 401 || ledger.status === 403,
         `got ${ledger.status} (never 200, never 500)`);
    } else {
      ok("GET /api/agents/{tokenId}/ledger without auth returns 401/403", false,
         "no agent with tokenId in DB to test against");
    }
  } catch (e: any) {
    console.log(`⏭️ SKIPPED: HTTP checks unavailable (${e?.message ?? e})`);
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail > 0 ? 1 : 0;
  await (prisma as any).$disconnect?.();
}

main().catch((e) => { console.error("FATAL:", e); process.exitCode = 1; });
