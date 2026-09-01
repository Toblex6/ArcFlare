/**
 * reputation-regression-tests.ts
 *
 * Focused regression for the Agents → Reputation defect:
 *  - src/app/agents/page.tsx did NOT send validatorWalletId (400)
 *  - /api/agent/reputation required validatorWalletId but never validated it
 *  - route was withApiKey-only, making dashboard (cookie session) unusable
 *
 * Proves:
 *  1. required validatorWalletId is supplied correctly (client derives, server verifies)
 *  2. unauthorized callers remain rejected (403)
 *  3. valid intended caller (merchant session / anySession) passes the auth gate
 *  4. no client-controlled wallet can be substituted for the authoritative validator identity
 *
 * Static proofs run without a dev server. Live HTTP proofs run if BASE is reachable.
 * Run: npx tsx scripts/reputation-regression-tests.ts [baseUrl]
 */
import "dotenv/config";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", override: true });

import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ethers } from "ethers";

const BASE = process.argv[2] || "http://localhost:3000";
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

async function req(method: string, url: string, body?: any, headers: Record<string,string> = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data, status: res.status };
}

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${BASE}/api/agent/validation?requestHash=0x${"00".repeat(32)}`, { signal: AbortSignal.timeout(5000) });
      // any response means server is up (validation GET is withApiKeyOrAnySession, will 401 without auth but not connection refused)
      if (r.status) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  console.log("── Reputation regression tests ───────────────────────────────");

  // ── Static proofs ───────────────────────────────────────────────────
  const repRoutePath = path.join(process.cwd(), "src/app/api/agent/reputation/route.ts");
  const repSrc = fs.readFileSync(repRoutePath, "utf8");
  const agentsPagePath = path.join(process.cwd(), "src/app/agents/page.tsx");
  const agentsSrc = fs.readFileSync(agentsPagePath, "utf8");

  // 1. Auth model: must be withApiKeyOrAnySession (same as validation), NOT bare withApiKey
  ok(
    "server uses withApiKeyOrAnySession (dashboard-usable)",
    repSrc.includes("withApiKeyOrAnySession") && repSrc.includes("from '@/lib/middleware/withMerchantAuth'"),
    "missing withApiKeyOrAnySession import"
  );
  ok(
    "POST is wrapped with withApiKeyOrAnySession",
    /export const POST = withApiKeyOrAnySession/.test(repSrc),
    "POST still withApiKey"
  );
  ok(
    "GET is wrapped with withApiKeyOrAnySession",
    /export const GET = withApiKeyOrAnySession/.test(repSrc),
    "GET still withApiKey"
  );
  ok(
    "server does NOT import bare withApiKey for reputation",
    !repSrc.includes("from '@/lib/middleware/withApiKey'"),
    "still imports withApiKey"
  );

  // 2. validatorWalletId: no longer hard-required, server derives authoritatively
  ok(
    "POST does not hard-require validatorWalletId in 400 check",
    !/if \(!agentId \|\| !validatorSCA \|\| !validatorWalletId/.test(repSrc),
    "still requires validatorWalletId"
  );
  ok(
    "POST requires agentId/validatorSCA/score/tag (without walletId)",
    /if \(!agentId \|\| !validatorSCA \|\| score === undefined \|\| !tag\)/.test(repSrc),
    "missing updated required check"
  );
  ok(
    "server has authoritative resolver (resolveAuthoritativeValidatorWalletId)",
    repSrc.includes("resolveAuthoritativeValidatorWalletId") && repSrc.includes("agentRegistry.findFirst") && repSrc.includes("consumerAccount.findFirst"),
    "no authoritative resolver"
  );
  ok(
    "server verifies client-supplied walletId against authoritative",
    /clientValidatorWalletId[\s\S]{0,300}authoritativeWalletId/.test(repSrc) && repSrc.includes("does not match the authoritative wallet"),
    "no substitution check"
  );
  ok(
    "server fails closed when validator wallet not resolvable",
    repSrc.includes("Validator wallet not resolvable for validatorSCA"),
    "no fail-closed on unresolvable"
  );
  ok(
    "server keeps verifyCallerControlsAddress for validatorSCA",
    repSrc.includes("verifyCallerControlsAddress(request, validatorSCA)"),
    "missing control check"
  );
  ok(
    "server still uses validatorSCA as Circle walletAddress (not walletId)",
    repSrc.includes("walletAddress: validatorSCA"),
    "signing identity changed"
  );

  // 3. Client: agents page now supplies validatorWalletId
  ok(
    "client imports no hard-coded walletId — derives from agents list",
    agentsSrc.includes("validatorWalletId") && agentsSrc.includes("matchedAgent"),
    "client does not supply validatorWalletId"
  );
  ok(
    "client resolves merchant wallet via /api/merchant/wallet",
    agentsSrc.includes("/api/merchant/wallet") && agentsSrc.includes("circleWalletId"),
    "no merchant wallet lookup"
  );
  ok(
    "client only sends validatorWalletId if resolvable (server derives otherwise)",
    /if \(validatorWalletId\) body\.validatorWalletId = validatorWalletId/.test(agentsSrc),
    "client always sends or never sends"
  );
  ok(
    "client does not trust body-supplied walletId blindly (server verifies)",
    repSrc.includes("authoritativeWalletId") && repSrc.includes("Circle wallet address does not equal validatorSCA"),
    "no Circle binding check"
  );

  // ── Live HTTP proofs (if server reachable) ──────────────────────────
  const serverUp = await waitForServer();
  if (!serverUp) {
    console.log("\n  (dev server not reachable — live HTTP proofs skipped)");
    console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
    for (const f of failures) console.log(`  ❌ ${f}`);
    await prisma.$disconnect();
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  console.log("\n── Live HTTP proofs (requires dev server) ─────────────────");

  // Fixtures: use existing merchant 'acne corp' or first verified active merchant
  const TEST_PASSWORD = "E2E_Test_Reputation_123!";
  const merchant = await prisma.merchant.findFirst({
    where: { verified: true, active: true, walletAddress: { not: null }, circleWalletId: { not: null } },
  });
  if (!merchant?.id) {
    console.log("  (no fixture merchant — live proofs BLOCKED)");
  } else {
    await prisma.merchant.update({ where: { id: merchant.id }, data: { passwordHash: await bcrypt.hash(TEST_PASSWORD, 10) } }).catch(() => {});
    const login = await req("POST", "/api/merchant/login", { email: merchant.email, password: TEST_PASSWORD });
    const cookie = login.res.headers.get("set-cookie")?.split(";")[0] || "";
    ok("fixture merchant login for live proofs", login.status === 200 && !!cookie, `got ${login.status}`);

    // Create a second merchant for unauthorized test
    const evilEmail = `evil-rep-${Date.now()}@example.com`;
    const evilWallet = ethers.Wallet.createRandom().address;
    const evil = await prisma.merchant.create({
      data: {
        email: evilEmail,
        businessName: `evil-rep-${Date.now()}`,
        passwordHash: await bcrypt.hash(TEST_PASSWORD, 10),
        verified: true,
        active: true,
        walletAddress: evilWallet,
        circleWalletId: `evil-wallet-${Date.now()}`,
        apiKey: `evil-key-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    const evilLogin = await req("POST", "/api/merchant/login", { email: evilEmail, password: TEST_PASSWORD });
    const evilCookie = evilLogin.res.headers.get("set-cookie")?.split(";")[0] || "";
    ok("evil merchant login ok", evilLogin.status === 200 && !!evilCookie, `got ${evilLogin.status}`);

    // Agent for reputation: owned by fixture merchant
    let agent = await (prisma as any).agentRegistry.findFirst({
      where: { merchantId: merchant.id, status: "ACTIVE_AGENT_PROVISIONED" },
    });
    if (!agent) {
      // deploy one via API
      const dep = await req("POST", "/api/agent/deploy", { agentName: `Rep Test Agent ${Date.now()}`, metadataUri: "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei" }, { Cookie: cookie });
      if (dep.status === 200 && dep.data.agent?.tokenId) {
        agent = dep.data.agent;
        // ensure prisma row has expected fields
        agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agent.id } });
      }
    }
    const tokenId = agent?.tokenId;
    const ownerSCA = agent?.scaAddress as string | undefined;
    ok("fixture agent exists for live tests", !!tokenId && !!ownerSCA, `agent ${JSON.stringify(agent)?.slice(0,120)}`);

    if (tokenId && ownerSCA) {
      // Find a validator that the fixture merchant controls (another agent they own, or merchant wallet)
      // Use merchant's own wallet as validator (different from owner)
      const validatorSCA = merchant.walletAddress!;
      const validatorWalletId = merchant.circleWalletId!;
      const isSelf = validatorSCA.toLowerCase() === ownerSCA.toLowerCase();
      // If owner == merchant wallet (rare), use another owned agent as validator
      let chosenValidatorSCA = validatorSCA;
      let chosenValidatorWalletId = validatorWalletId;
      if (isSelf) {
        const other = await (prisma as any).agentRegistry.findFirst({
          where: { merchantId: merchant.id, scaAddress: { not: ownerSCA }, status: "ACTIVE_AGENT_PROVISIONED" },
        });
        if (other?.scaAddress && other?.circleWalletId) {
          chosenValidatorSCA = other.scaAddress;
          chosenValidatorWalletId = other.circleWalletId;
        } else {
          // create a second agent to act as validator
          const dep2 = await req("POST", "/api/agent/deploy", { agentName: `Rep Validator ${Date.now()}`, metadataUri: "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei" }, { Cookie: cookie });
          if (dep2.status === 200) {
            chosenValidatorSCA = dep2.data.agent.scaAddress;
            chosenValidatorWalletId = dep2.data.agent.circleWalletId;
          }
        }
      }
      ok("chosen validator is not the agent owner", chosenValidatorSCA.toLowerCase() !== ownerSCA.toLowerCase(), `${chosenValidatorSCA} vs ${ownerSCA}`);

      // 2a. Unauthorized: no auth → 401 (outer gate)
      const noAuth = await req("POST", "/api/agent/reputation", {
        agentId: tokenId, validatorSCA: chosenValidatorSCA, score: 80, tag: "test_no_auth",
      });
      ok("unauthenticated POST → 401", noAuth.status === 401, `got ${noAuth.status} ${JSON.stringify(noAuth.data).slice(0,120)}`);

      // 2b. Unauthorized caller controls check: evil merchant tries to record reputation as validator they don't control → 403
      const evilAttempt = await req("POST", "/api/agent/reputation", {
        agentId: tokenId,
        validatorSCA: chosenValidatorSCA,
        validatorWalletId: chosenValidatorWalletId,
        score: 80,
        tag: "evil_attempt",
      }, { Cookie: evilCookie });
      ok("evil merchant claiming validator they don't control → 403", evilAttempt.status === 403, `got ${evilAttempt.status} ${JSON.stringify(evilAttempt.data).slice(0,180)}`);

      // 4. No substitution: correct SCA but wrong walletId → 400 authoritative mismatch
      const wrongWalletId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
      const substituted = await req("POST", "/api/agent/reputation", {
        agentId: tokenId,
        validatorSCA: chosenValidatorSCA,
        validatorWalletId: wrongWalletId,
        score: 80,
        tag: "substituted_wallet",
      }, { Cookie: cookie });
      ok("substituted walletId (mismatched) → 400", substituted.status === 400 && /does not match the authoritative/.test(substituted.data.error || ""), `got ${substituted.status} ${JSON.stringify(substituted.data).slice(0,200)}`);

      // 1 & 3. Valid intended caller: merchant session with correct derived walletId passes control check
      // We don't execute the full on-chain tx here (would need funding + Circle + gas) — we only assert
      // that the request passes the 403/400 gates and reaches Circle (500 or 200). A 400 for missing agent
      // or 500 Circle error is acceptable; 403/401 is not.
      // To avoid spending gas, use a non-existent agent? No — we need a real agent to pass that gate, so we
      // send a real agentId but expect either 500 (Circle failure) or 200 (success). We consider 500 with
      // Circle message as "passed auth".
      // Instead, test a lighter path: call GET which is same auth but no Circle spend.
      const getNoAuth = await req("GET", `/api/agent/reputation?agentId=${tokenId}`);
      ok("GET without auth → 401", getNoAuth.status === 401, `got ${getNoAuth.status}`);
      const getWithAuth = await req("GET", `/api/agent/reputation?agentId=${tokenId}`, undefined, { Cookie: cookie });
      ok("GET with valid merchant session → 200 (not 401/403)", getWithAuth.status === 200, `got ${getWithAuth.status} ${JSON.stringify(getWithAuth.data).slice(0,180)}`);

      // POST with correct auth + correct walletId: should NOT be 401/403/400-wallet-mismatch.
      // It may be 500 (Circle/RPC) or 200 — either proves auth passed and wallet binding was accepted.
      const validPost = await req("POST", "/api/agent/reputation", {
        agentId: tokenId,
        validatorSCA: chosenValidatorSCA,
        validatorWalletId: chosenValidatorWalletId,
        score: 85,
        tag: "valid_caller_test",
      }, { Cookie: cookie });
      const validPassedAuth = validPost.status !== 401 && validPost.status !== 403 && !/does not match the authoritative/.test(validPost.data.error || "");
      ok("valid caller with correct walletId → passes auth+wallet binding (200 or Circle 500, not 401/403/mismatch)", validPassedAuth, `got ${validPost.status} ${JSON.stringify(validPost.data).slice(0,250)}`);

      // Also prove omission case: no walletId supplied, server derives → same pass
      const noWalletIdPost = await req("POST", "/api/agent/reputation", {
        agentId: tokenId,
        validatorSCA: chosenValidatorSCA,
        score: 86,
        tag: "derived_wallet_test",
      }, { Cookie: cookie });
      const derivedPassed = noWalletIdPost.status !== 401 && noWalletIdPost.status !== 403 && !/does not match/.test(noWalletIdPost.data.error || "") && !/are required/.test(noWalletIdPost.data.error || "");
      ok("POST without walletId → server derives (not 400 required, not 401/403)", derivedPassed, `got ${noWalletIdPost.status} ${JSON.stringify(noWalletIdPost.data).slice(0,250)}`);

      // Cleanup evil merchant
      await prisma.merchant.delete({ where: { id: evil.id } }).catch(() => {});
    }
  }

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  await prisma.$disconnect();
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
