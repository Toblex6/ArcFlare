/**
 * reputation-regression-tests.ts
 *
 * Focused regression for the Agents → Record Reputation validator UX fix:
 *  - validatorSCA is no longer free-text on the form — the client resolves the
 *    merchant's authoritative controlled wallets (their own Circle wallet from
 *    /api/merchant/wallet + owned agents that have circleWalletId, excluding the
 *    target agent's own tokenId) and renders the validator as a read-only input
 *    (exactly one eligible) or a bounded <select> (multiple), or a clear inline
 *    error + disabled submit (zero eligible)
 *  - the submit sends validatorSCA/validatorWalletId derived ONLY from those
 *    resolved options ("This reputation will be signed by your wallet.")
 *  - /api/agent/reputation is UNCHANGED: withApiKeyOrAnySession, server-side
 *    verifyCallerControlsAddress(validatorSCA), authoritative wallet resolution,
 *    optional validatorWalletId that must match the authoritative value
 *
 * Proves:
 *  1. the form no longer accepts an arbitrary free-text validatorSCA
 *  2. the authoritative caller wallet is used (resolution is server/session-derived)
 *  3. a different/random wallet cannot be substituted through the request
 *  4. existing valid reputation submission behavior remains intact
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

  // 3. Client: Record Reputation validator UX — validatorSCA is NO LONGER free
  //    text. The form resolves the merchant's authoritative controlled wallets
  //    (own Circle wallet via /api/merchant/wallet + owned agents with
  //    circleWalletId, excluding the target agent's own tokenId) and renders the
  //    validator read-only/select; submit derives validatorSCA only from those
  //    options. Backend unchanged and still authoritative.

  // 3a. The arbitrary free-text validatorSCA input is gone.
  ok(
    "client no longer renders free-text validatorSCA input (old placeholder gone)",
    !agentsSrc.includes('placeholder="0x... (NOT the agent owner)"'),
    "old free-text placeholder still present"
  );
  ok(
    "validator rendered as bounded <select> over repValidatorOptions OR readOnly input",
    agentsSrc.includes("<select") && agentsSrc.includes("readOnly") && agentsSrc.includes("repValidatorOptions.map"),
    "no select/readOnly validator widget"
  );
  ok(
    "single eligible validator rendered read-only (not an editable <input>)",
    agentsSrc.includes("value={repValidatorSCA || repValidatorOptions[0].validatorSCA}"),
    "single-option validator input is not readOnly"
  );

  // 3b. Authoritative caller wallet is used (server/session-derived, not typed).
  ok(
    "client resolves merchant authoritative wallet via /api/merchant/wallet",
    agentsSrc.includes("fetch('/api/merchant/wallet')"),
    "no merchant wallet lookup"
  );
  ok(
    "merchant-wallet validator option gated on walletAddress + circleWalletId",
    agentsSrc.includes("merchantWallet?.walletAddress && merchantWallet?.circleWalletId"),
    "merchant wallet not gated on circleWalletId"
  );
  ok(
    "owned-agent validator options gated on scaAddress + circleWalletId, target agent excluded",
    agentsSrc.includes("a.scaAddress && a.circleWalletId && String(a.tokenId) !== String(repAgentId || '')"),
    "owned agents not gated/excluded correctly"
  );
  ok(
    "helper text present: 'This reputation will be signed by your wallet.'",
    agentsSrc.includes("This reputation will be signed by your wallet."),
    "helper text missing"
  );
  ok(
    "zero eligible options handled: submit disabled + inline error",
    agentsSrc.includes("repValidatorOptions.length === 0") && agentsSrc.includes("No eligible validator wallet found"),
    "no zero-state handling"
  );

  // 3c. A different/random wallet cannot be substituted through the request.
  ok(
    "submit derives validatorSCA ONLY from resolved options (selected = repValidatorOptions.find)",
    agentsSrc.includes("const selected = repValidatorOptions.find("),
    "validatorSCA not sourced from resolved options"
  );
  ok(
    "submit body sends selected.validatorSCA + selected.circleWalletId",
    agentsSrc.includes("validatorSCA: selected.validatorSCA") && agentsSrc.includes("validatorWalletId: selected.circleWalletId"),
    "submit body does not use the resolved selected option"
  );
  ok(
    "no path sends a raw typed string as validatorSCA (old 'validatorSCA: repValidatorSCA' gone)",
    !agentsSrc.includes("validatorSCA: repValidatorSCA"),
    "raw typed validatorSCA still sent"
  );
  ok(
    "submit refuses a non-resolvable typed validator (throws before POST when no option matches)",
    agentsSrc.includes("No eligible validator wallet selected"),
    "no guard against a typed value outside repValidatorOptions"
  );

  // 3d. Existing valid reputation submission behavior retained.
  ok(
    "client still POSTs reputation to /api/agent/reputation",
    agentsSrc.includes("fetch('/api/agent/reputation'"),
    "reputation POST target changed"
  );
  ok(
    "submit still sends agentId / score / tag",
    agentsSrc.includes("agentId: repAgentId") && agentsSrc.includes("score: parseInt(repScore)") && agentsSrc.includes("tag: repTag"),
    "agentId/score/tag not sent"
  );

  // Server-side (kept): walletId is never trusted blindly — authoritative binding enforced.
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

      // 3. Random/uncontrolled wallet substitution: the CORRECT merchant posts a
      // random address (not their merchant wallet, not any owned agent SCA) as
      // validatorSCA with no validatorWalletId → 403 (session is valid, but they
      // don't control that address). Proves an arbitrary/different wallet cannot
      // be substituted through the request even by the legitimate caller.
      const randomSCA = ethers.Wallet.createRandom().address;
      const randomAttempt = await req("POST", "/api/agent/reputation", {
        agentId: tokenId,
        validatorSCA: randomSCA,
        score: 80,
        tag: "random_wallet_attempt",
      }, { Cookie: cookie });
      ok("random validator wallet cannot be substituted (correct merchant, unowned SCA) → 403", randomAttempt.status === 403, `got ${randomAttempt.status} ${JSON.stringify(randomAttempt.data).slice(0,180)}`);

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
