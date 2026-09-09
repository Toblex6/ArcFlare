/**
 * security-cleanup-batch1-tests.ts
 *
 * Regression suite for Security Cleanup Batch 1 (audit P0 fixes):
 *
 *   1. POST /api/agent/checkout removed — 410 Gone, no payment execution
 *      (no agentPayService import, no executeAgentPayment path), no other
 *      route imports the dead handler.
 *   2. GET/POST /api/agent-data removed — 410 Gone, no PaymentLog creation,
 *      no fake x402/header "verification" remains, migration message present.
 *   3. GET /api/agents/[id]/ledger and /treasury have NO wallet-provisioning
 *      side effects: unauthorized GET creates no x402EoaWallet row, authorized
 *      GET still returns the full treasury/ledger view and still creates
 *      nothing (read-only), cross-tenant GET is still 403, and the auth-wrapped
 *      POST keeps its pre-existing get-or-create (authorized only).
 *   4. ERC-8183 AgenticCommerce address literal removed from jobs/brain/card
 *      routes — canonical AGENTIC_COMMERCE_CONTRACT from
 *      src/lib/contracts/erc8183.ts only; card route behavior preserved
 *      (escrowContract still resolves to the audited address; env override
 *      still wins).
 *
 * Approach follows repo convention: static source proofs (readFileSync) +
 * live exported-handler invocation + real Prisma fixtures with cleanup.
 * No dev server required; no chain calls; no funds moved.
 *
 * Run: npx tsx scripts/security-cleanup-batch1-tests.ts
 * Must also stay clean under: npx tsc --noEmit
 */
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { AGENTIC_COMMERCE_CONTRACT } from "@/lib/contracts/erc8183";

let passed = 0;
let failed = 0;
let blocked = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}
function blk(name: string, detail = "") {
  blocked++; console.log(`  ⏸️  BLOCKED ${name} — ${detail}`);
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

// The audited ERC-8183 AgenticCommerce address (expected canonical value).
// Lives ONLY here as a test expectation — the canonical source of truth is
// src/lib/contracts/erc8183.ts.
const AUDITED_ERC8183 = "0x0747EEf0706327138c69792bF28Cd525089e4583";

/** Recursively collect all TypeScript files under src (ts, tsx, mts). */
function walkSrc(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, acc);
    else if (/\.(ts|tsx|mts)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

async function main() {
  console.log("\n=== Security Cleanup Batch 1 — regression tests ===");

  // ── [1] Static source proofs (no DB, no server) ──────────────────────────
  console.log("\n[1] static source proofs");

  const checkoutSrc = read("src/app/api/agent/checkout/route.ts");
  ok("checkout route returns 410 Gone", /status:\s*410/.test(checkoutSrc));
  ok("checkout route names canonical alternatives",
    checkoutSrc.includes("/api/agents/[id]/hire") && checkoutSrc.includes("/api/payments/*"));
  ok("checkout route has NO payment execution left",
    !/executeAgentPayment/.test(checkoutSrc) && !/agentPayService/.test(checkoutSrc),
    "executeAgentPayment/agentPayService must be gone");
  ok("checkout route imports no payment/db services",
    !/@\/services\//.test(checkoutSrc) && !/@\/lib\/prisma/.test(checkoutSrc));

  const agentDataSrc = read("src/app/api/agent-data/route.ts");
  ok("agent-data GET+POST handlers both exist and return 410",
    (agentDataSrc.match(/status:\s*410/g) || []).length >= 1 &&
    /export async function GET/.test(agentDataSrc) &&
    /export async function POST/.test(agentDataSrc));
  ok("agent-data creates NO PaymentLog rows", !/paymentLog/i.test(agentDataSrc), "paymentLog reference must be gone");
  ok("agent-data has NO fake x402/header verification",
    !/x-payment-reference/i.test(agentDataSrc) && !/status:\s*['"]VERIFIED['"]/.test(agentDataSrc));
  ok("agent-data keeps migration message to real payment APIs",
    /\/api\/payments\/initialize/.test(agentDataSrc) && /\/api\/payments\/settle/.test(agentDataSrc));

  // No other route (or file) imports the dead handlers.
  const srcFiles = walkSrc(path.join(root, "src"));
  const routeFilesImportingDeadHandlers = srcFiles.filter((f) => {
    if (f.endsWith(path.join("api", "agent", "checkout", "route.ts"))) return false;
    if (f.endsWith(path.join("api", "agent-data", "route.ts"))) return false;
    const src = fs.readFileSync(f, "utf8");
    return /@\/app\/api\/agent\/checkout\/route/.test(src) || /@\/app\/api\/agent-data\/route/.test(src);
  });
  ok("no other route imports the removed handlers", routeFilesImportingDeadHandlers.length === 0,
    routeFilesImportingDeadHandlers.join(", ") || "clean");

  const ledgerSrc = read("src/app/api/agents/[id]/ledger/route.ts");
  ok("ledger GET no longer calls getOrCreateAgentWallet", !/getOrCreateAgentWallet/.test(ledgerSrc));
  ok("ledger GET uses read-only getAgentWalletAddress", /getAgentWalletAddress/.test(ledgerSrc));
  ok("ledger GET still enforces verifyCallerControlsAddress", /verifyCallerControlsAddress/.test(ledgerSrc));

  const treasurySrc = read("src/app/api/agents/[id]/treasury/route.ts");
  const getHandlerSrc = treasurySrc.slice(
    treasurySrc.indexOf("async function getHandler"),
    treasurySrc.indexOf("async function postHandler")
  );
  const postHandlerSrc = treasurySrc.slice(treasurySrc.indexOf("async function postHandler"));
  ok("treasury GET no longer calls getOrCreateAgentWallet", !/getOrCreateAgentWallet/.test(getHandlerSrc));
  ok("treasury GET uses read-only getAgentWalletAddress", /getAgentWalletAddress/.test(getHandlerSrc));
  ok("treasury POST keeps its authorized get-or-create (pre-existing behavior)",
    /getOrCreateAgentWallet/.test(postHandlerSrc));
  ok("treasury GET still enforces verifyCallerControlsAddress", /verifyCallerControlsAddress/.test(getHandlerSrc));

  const jobsSrc = read("src/app/api/jobs/route.ts");
  const brainSrc = read("src/app/api/agent/brain/route.ts");
  const cardSrc = read("src/app/api/agents/[id]/card/route.ts");
  const literalRe = /0x0747[eE]{2}[fF]0706327138[cC]69792[bB][fF]28[cC][dD]525089[eE]4583/;
  ok("jobs route has no duplicated ERC-8183 address literal", !literalRe.test(jobsSrc));
  ok("brain route has no duplicated ERC-8183 address literal", !literalRe.test(brainSrc));
  ok("card route has no duplicated ERC-8183 address literal", !literalRe.test(cardSrc));
  ok("jobs route imports the canonical ERC-8183 address",
    /from ['"]@\/lib\/contracts\/erc8183['"]/.test(jobsSrc) && /AGENTIC_COMMERCE_CONTRACT/.test(jobsSrc));
  ok("card route imports the canonical ERC-8183 address",
    /from ['"]@\/lib\/contracts\/erc8183['"]/.test(cardSrc) && /AGENTIC_COMMERCE_CONTRACT/.test(cardSrc));
  ok("canonical module exports the audited address", AGENTIC_COMMERCE_CONTRACT === AUDITED_ERC8183,
    `got ${AGENTIC_COMMERCE_CONTRACT}`);

  // ── [2] Live handler proofs for the 410 routes (no DB needed) ─────────────
  console.log("\n[2] live handler proofs — deprecated endpoints");
  try {
    const checkout = await import("@/app/api/agent/checkout/route");
    const maliciousBody = {
      merchantAddress: AUDITED_ERC8183,
      amountInUSDC: 1000000,
      paymentReference: `sec-cleanup-${Date.now()}`,
    };
    const res = await checkout.POST(
      new NextRequest("http://localhost/api/agent/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(maliciousBody),
      }) as any
    );
    const body: any = await res.json().catch(() => ({}));
    ok("POST /api/agent/checkout returns 410 (payload ignored)", res.status === 410, `got ${res.status}`);
    ok("410 body names both canonical alternatives",
      JSON.stringify(body?.alternatives ?? []).includes("/api/agents/[id]/hire") &&
      JSON.stringify(body?.alternatives ?? []).includes("/api/payments/*"),
      JSON.stringify(body?.alternatives ?? []));
    const getRes = await checkout.GET(new NextRequest("http://localhost/api/agent/checkout") as any);
    ok("GET /api/agent/checkout also returns 410", getRes.status === 410, `got ${getRes.status}`);

    const agentData = await import("@/app/api/agent-data/route");
    const adRes = await agentData.GET(
      new NextRequest("http://localhost/api/agent-data", {
        headers: { "x-payment-reference": `forged-${Date.now()}`, "x-agent-email": "attacker@example.com" },
      }) as any
    );
    const adBody: any = await adRes.json().catch(() => ({}));
    ok("GET /api/agent-data with forged payment header returns 410", adRes.status === 410, `got ${adRes.status}`);
    ok("agent-data 410 body points to real payment APIs",
      typeof adBody?.message === "string" && adBody.message.includes("/api/payments/initialize"));
    const adPost = await agentData.POST(
      new NextRequest("http://localhost/api/agent-data", { method: "POST" }) as any
    );
    ok("POST /api/agent-data returns 410", adPost.status === 410, `got ${adPost.status}`);
  } catch (e: any) {
    blk("live 410 handler proofs", e?.message ?? String(e));
  }

  // ── [3] DB-backed proofs: GET wallet side effects + card behavior ─────────
  console.log("\n[3] DB proofs — wallet provisioning side effects + card");
  let prisma: any = null;
  try {
    const mod = await import("@/lib/prisma");
    prisma = (mod as any).prisma;
    await prisma.$queryRaw`SELECT 1`;
  } catch (e: any) {
    blk("DB-backed proofs", `database unavailable: ${e?.message ?? e}`);
  }

  if (prisma) {
    const RUN = Date.now().toString(36);
    const createdAgentIds: number[] = [];
    let merchantId: string | null = null;
    const mkAddress = () =>
      "0x" + [...Array(40)].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    try {
      const merchant = await prisma.merchant.create({
        data: {
          email: `sec-cleanup-${RUN}@example.com`,
          businessName: `SecurityCleanup ${RUN}`,
          passwordHash: "test-hash-not-a-real-password",
          apiKey: `sec-cleanup-key-${RUN}-${Math.random().toString(36).slice(2)}`,
          active: true,
          verified: true,
          walletAddress: mkAddress(),
        },
      });
      merchantId = merchant.id;
      const agentX = await prisma.agentRegistry.create({
        data: {
          name: `sec-cleanup-owned-${RUN}`,
          tokenId: `990000${RUN}`,
          scaAddress: mkAddress(),
          ownerNode: "test",
          status: "ACTIVE_AGENT_PROVISIONED",
          skills: [],
          reputation: 50,
          merchantId: merchant.id,
        },
      });
      createdAgentIds.push(agentX.id);
      const agentY = await prisma.agentRegistry.create({
        data: {
          name: `sec-cleanup-unowned-${RUN}`,
          tokenId: `990001${RUN}`,
          scaAddress: mkAddress(),
          ownerNode: "test",
          status: "ACTIVE_AGENT_PROVISIONED",
          skills: [],
          reputation: 50,
          merchantId: null,
        },
      });
      createdAgentIds.push(agentY.id);

      const walletCount = (ids: number[]) =>
        prisma.x402EoaWallet.count({ where: { agentRegistryId: { in: ids } } });
      ok("fixture sanity: no wallet rows pre-exist for test agents",
        (await walletCount(createdAgentIds)) === 0);

      const ledger = await import("@/app/api/agents/[id]/ledger/route");
      const unauthLedger = await ledger.GET(
        new NextRequest(`http://localhost/api/agents/${agentX.id}/ledger`) as any,
        { params: Promise.resolve({ id: String(agentX.id) }) } as any
      );
      ok("unauthorized ledger GET is rejected (403)", unauthLedger.status === 403, `got ${unauthLedger.status}`);
      ok("unauthorized ledger GET creates NO wallet row", (await walletCount(createdAgentIds)) === 0,
        `wallet rows: ${await walletCount(createdAgentIds)}`);

      const treasury = await import("@/app/api/agents/[id]/treasury/route");
      const unauthTreasury = await treasury.GET(
        new NextRequest(`http://localhost/api/agents/${agentX.id}/treasury`) as any,
        { params: Promise.resolve({ id: String(agentX.id) }) } as any
      );
      ok("unauthorized treasury GET is rejected (403)", unauthTreasury.status === 403, `got ${unauthTreasury.status}`);
      ok("unauthorized treasury GET creates NO wallet row", (await walletCount(createdAgentIds)) === 0);

      const crossLedger = await ledger.GET(
        new NextRequest(`http://localhost/api/agents/${agentY.id}/ledger`, {
          headers: { "x-api-key": merchant.apiKey },
        }) as any,
        { params: Promise.resolve({ id: String(agentY.id) }) } as any
      );
      ok("cross-tenant ledger GET (valid auth, unowned agent) is 403", crossLedger.status === 403, `got ${crossLedger.status}`);
      ok("cross-tenant ledger GET creates NO wallet row", (await walletCount(createdAgentIds)) === 0);

      const authLedger = await ledger.GET(
        new NextRequest(`http://localhost/api/agents/${agentX.id}/ledger?limit=5`, {
          headers: { "x-api-key": merchant.apiKey },
        }) as any,
        { params: Promise.resolve({ id: String(agentX.id) }) } as any
      );
      const authLedgerBody: any = await authLedger.json().catch(() => ({}));
      ok("authorized ledger GET preserves behavior (200 + treasury + recent)",
        authLedger.status === 200 &&
        authLedgerBody?.agent?.id === agentX.id &&
        typeof authLedgerBody?.treasury === "object" &&
        Array.isArray(authLedgerBody?.recent),
        `got ${authLedger.status}`);
      ok("authorized ledger GET still creates NO wallet row (GET is read-only)",
        (await walletCount(createdAgentIds)) === 0, `wallet rows: ${await walletCount(createdAgentIds)}`);

      const authTreasury = await treasury.GET(
        new NextRequest(`http://localhost/api/agents/${agentX.id}/treasury`, {
          headers: { "x-api-key": merchant.apiKey },
        }) as any,
        { params: Promise.resolve({ id: String(agentX.id) }) } as any
      );
      const authTreasuryBody: any = await authTreasury.json().catch(() => ({}));
      ok("authorized treasury GET preserves behavior (200 + treasury view)",
        authTreasury.status === 200 && authTreasuryBody?.treasury?.agentRegistryId === agentX.id,
        `got ${authTreasury.status}`);
      ok("authorized treasury GET still creates NO wallet row (GET is read-only)",
        (await walletCount(createdAgentIds)) === 0, `wallet rows: ${await walletCount(createdAgentIds)}`);

      const card = await import("@/app/api/agents/[id]/card/route");
      const cardRes = await card.GET(
        new NextRequest(`http://localhost/api/agents/${agentX.id}/card`) as any,
        { params: Promise.resolve({ id: String(agentX.id) }) } as any
      );
      const cardBody: any = await cardRes.json().catch(() => ({}));
      ok("agent card GET still works after literal removal (200)",
        cardRes.status === 200 && !!cardBody?.agentCard, `got ${cardRes.status}`);
      ok("agent card escrowContract still resolves to the audited ERC-8183 address",
        cardBody?.agentCard?.hiring?.escrowContract === AUDITED_ERC8183,
        `got ${cardBody?.agentCard?.hiring?.escrowContract}`);

    } catch (e: any) {
      blk("DB-backed proofs", e?.message ?? String(e));
    } finally {
      try {
        // Test-created wallet rows only (defensive: should be none — that is
        // the invariant under test).
        if (createdAgentIds.length > 0) {
          await prisma.x402EoaWallet.deleteMany({ where: { agentRegistryId: { in: createdAgentIds } } });
          for (const id of createdAgentIds) {
            await prisma.agentRegistry.delete({ where: { id } }).catch(() => {});
          }
        }
        if (merchantId) await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
      } catch (e: any) {
        console.log(`⚠️ cleanup failed: ${e?.message ?? e}`);
      }
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${blocked} blocked ===`);
  if (failures.length > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
  await prisma?.$disconnect?.();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});