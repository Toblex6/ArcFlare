/**
 * request-no-code-tests.ts
 *
 * Proves the own-wallet REQUEST exemption weakens no fund-moving gate:
 *  - Static: every fund-moving route still calls the canonical step-up helper
 *    (settle, scheduled, swap/execute, cctp/transfer, escrow release/dispute,
 *    jobs fund cores, agentPay + payroll libs, wallet-bind, treasury,
 *    pin/email change, Telegram bot adapter). Initialize still gates send +
 *    arbitrary-payout requests.
 *  - Live (no chain, no funds): PIN-enrolled consumer —
 *    own-wallet request succeeds with session alone; arbitrary-payout request
 *    without PIN is rejected (STEP_UP_REQUIRED, nothing persisted) and succeeds
 *    with PIN; send without PIN is rejected; scheduled create without PIN is
 *    rejected; merchant x-api-key request succeeds with no PIN concept.
 *
 * Run: npx tsx scripts/request-no-code-tests.ts
 * No dev server required.
 */
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: ".env.local" });

import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { issueConsumerSessionToken } from "@/lib/auth/consumerSession";
import { POST as pinSetPOST } from "@/app/api/consumer/pin/route";
import { POST as scheduledPOST } from "@/app/api/payments/scheduled/route";
import { POST as initializePOST } from "@/app/api/payments/initialize/route";

const prisma = new PrismaClient() as any;
let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const RUN = Date.now().toString(36);
const XFF = (t: string) => `req-nocode-${t}-${RUN}`;
const wallets: string[] = [];
const emails: string[] = [];
const references: string[] = [];
const merchantIds: string[] = [];
const mkWallet = () => {
  const w = ethers.Wallet.createRandom().address;
  wallets.push(w);
  return w;
};

function mkReq(url: string, opts: {
  method?: string; token?: string; pin?: string; apiKey?: string; body?: unknown; xff: string;
}): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.xff,
  };
  if (opts.token) headers.cookie = `consumer_token=${opts.token}`;
  if (opts.pin) headers["x-consumer-pin"] = opts.pin;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  return new NextRequest(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  } as any);
}
const json = async (res: any) => { try { return await res.json(); } catch { return {}; } };

const ROOT = process.cwd();
// Fund-moving gates that must remain intact (no weakening).
const GATED = [
  "src/app/api/payments/settle/route.ts",
  "src/app/api/payments/scheduled/route.ts",
  "src/app/api/swap/execute/route.ts",
  "src/app/api/cctp/transfer/route.ts",
  "src/app/api/escrow/release/route.ts",
  "src/app/api/escrow/dispute/route.ts",
  "src/app/api/jobs/fund/route.ts",
  "src/app/api/jobs/[jobId]/fund/route.ts",
  "src/app/api/jobs/complete/route.ts",
  "src/app/api/agents/[id]/hire/route.ts",
  "src/app/api/agents/[id]/wallet/route.ts",
  "src/app/api/agents/[id]/treasury/route.ts",
  "src/app/api/consumer/pin/route.ts",
  "src/app/api/consumer/email/route.ts",
  "src/app/api/consumer/assistant/route.ts",
  "src/lib/agents/agentPay.ts",
  "src/lib/payroll/payrollExecution.ts",
  "src/lib/telegram/botHandlers.ts",
];

async function main() {
  console.log("[0] environment");
  ok("DATABASE_URL present", !!process.env.DATABASE_URL);
  ok("CONSUMER_JWT_SECRET configured", (process.env.CONSUMER_JWT_SECRET ?? "").length >= 32);

  console.log("[1] static: fund-moving gates intact, initialize still gates send + arbitrary payout");
  let gatesOk = true;
  for (const f of GATED) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const has =
      src.includes("requireConsumerStepUpForActor") ||
      src.includes("requireConsumerStepUp(") ||
      src.includes("verifyConsumerPinForBot");
    if (!has) { gatesOk = false; console.log(`    MISSING: ${f}`); }
  }
  ok("all fund-moving files still reference the canonical step-up module", gatesOk);
  const initSrc = fs.readFileSync(path.join(ROOT, "src/app/api/payments/initialize/route.ts"), "utf8");
  ok("initialize still gates send (consumer.send present)", initSrc.includes("consumer.send"));
  ok("initialize still gates arbitrary-payout request (consumer.request present)", initSrc.includes("consumer.request"));
  ok("initialize has own-wallet exemption (isOwnWalletRequest)", initSrc.includes("isOwnWalletRequest"));
  const asstSrc = fs.readFileSync(path.join(ROOT, "src/app/api/consumer/assistant/route.ts"), "utf8");
  ok("assistant still gates send/save (consumer.send + consumer.save present)",
    asstSrc.includes("consumer.send") && asstSrc.includes("consumer.save"));

  console.log("[2] fixtures: PIN-enrolled consumer + merchant API key");
  const wConsumer = mkWallet();
  const aConsumer = await prisma.consumerAccount.create({
    data: { walletAddress: wConsumer, walletType: "CIRCLE", onboardingSource: "web" },
  });
  const tConsumer = await issueConsumerSessionToken(aConsumer.id, wConsumer);
  const PIN = "4821";
  const rPin = await pinSetPOST(mkReq("http://t/api/consumer/pin", { method: "POST", token: tConsumer, body: { pin: PIN }, xff: XFF("pinset") }) as any);
  ok("consumer PIN enrolled (bootstrap, session-only)", rPin.status === 200, `status=${rPin.status}`);

  const mEmail = `req-nocode-${RUN}@example.com`.toLowerCase();
  emails.push(mEmail);
  const mWallet = mkWallet();
  const mApiKey = `arc_test_reqnocode_${RUN}`;
  const merchant = await prisma.merchant.create({
    data: {
      email: mEmail, businessName: "ReqNoCode Test", passwordHash: "test-hash",
      apiKey: mApiKey, verified: true, active: true, walletAddress: mWallet,
    },
  });
  merchantIds.push(merchant.id);
  ok("merchant fixture created (verified + apiKey + wallet)", true);

  console.log("[3] live: own-wallet request needs NO code");
  {
    const r = await initializePOST(mkReq("http://t/api/payments/initialize",
      { method: "POST", token: tConsumer, body: { amount: "1", currency: "USDC", direction: "request" }, xff: XFF("req-own") }) as any);
    const b = await json(r);
    ok("session-only own-wallet request succeeds (200)", r.status === 200 && b.success === true && !!b.reference, `status=${r.status} ${JSON.stringify(b).slice(0, 140)}`);
    if (b.reference) {
      references.push(b.reference);
      const row = await prisma.paymentLog.findUnique({ where: { reference: b.reference } }).catch(() => null);
      ok("own-wallet invoice pays the caller (merchantSCA == session wallet)",
        !!row && String(row.merchantSCA).toLowerCase() === wConsumer.toLowerCase(),
        `merchantSCA=${row?.merchantSCA}`);
    }
  }

  console.log("[4] live: explicit own-wallet payoutAddress needs NO code");
  {
    const r = await initializePOST(mkReq("http://t/api/payments/initialize",
      { method: "POST", token: tConsumer, body: { amount: "1", currency: "USDC", direction: "request", payoutAddress: wConsumer }, xff: XFF("req-explicit-own") }) as any);
    const b = await json(r);
    ok("session-only request with payoutAddress == self succeeds", r.status === 200 && b.success === true, `status=${r.status}`);
    if (b.reference) references.push(b.reference);
  }

  console.log("[5] live: arbitrary-payout request KEEPS the code");
  const wForeign = mkWallet();
  {
    const before = await prisma.paymentLog.count({ where: { merchantSCA: wForeign } }).catch(() => 0);
    const r = await initializePOST(mkReq("http://t/api/payments/initialize",
      { method: "POST", token: tConsumer, body: { amount: "1", currency: "USDC", direction: "request", payoutAddress: wForeign }, xff: XFF("req-foreign-nopin") }) as any);
    const b = await json(r);
    ok("session-only arbitrary-payout request rejected (STEP_UP_REQUIRED)", r.status === 403 && b.code === "STEP_UP_REQUIRED", `status=${r.status} code=${b.code}`);
    const after = await prisma.paymentLog.count({ where: { merchantSCA: wForeign } }).catch(() => -1);
    ok("rejected request persisted no row", after === before, `before=${before} after=${after}`);
    const rPin2 = await initializePOST(mkReq("http://t/api/payments/initialize",
      { method: "POST", token: tConsumer, pin: PIN, body: { amount: "1", currency: "USDC", direction: "request", payoutAddress: wForeign }, xff: XFF("req-foreign-pin") }) as any);
    const bPin2 = await json(rPin2);
    ok("arbitrary-payout request with PIN succeeds", rPin2.status === 200 && bPin2.success === true, `status=${rPin2.status}`);
    if (bPin2.reference) references.push(bPin2.reference);
  }

  console.log("[6] live: send still requires the code");
  {
    const r = await initializePOST(mkReq("http://t/api/payments/initialize",
      { method: "POST", token: tConsumer, body: { amount: "1", currency: "USDC", direction: "send", payoutAddress: mkWallet() }, xff: XFF("send-nopin") }) as any);
    const b = await json(r);
    ok("session-only send rejected (STEP_UP_REQUIRED)", r.status === 403 && b.code === "STEP_UP_REQUIRED", `status=${r.status} code=${b.code}`);
  }

  console.log("[7] live: scheduled (fund-moving) still requires the code");
  {
    const body = { payerSCA: wConsumer, receiverSCA: wConsumer, amount: 1, intervalDays: 7, description: "req-nocode test" };
    const r = await scheduledPOST(mkReq("http://t/api/payments/scheduled", { method: "POST", token: tConsumer, body, xff: XFF("sched-nopin") }) as any);
    const b = await json(r);
    ok("session-only scheduled create rejected (STEP_UP_REQUIRED, nothing persisted)",
      r.status === 403 && b.code === "STEP_UP_REQUIRED", `status=${r.status} code=${b.code}`);
    const persisted = await prisma.scheduledPayment.findMany({ where: { payerSCA: wConsumer } }).catch(() => []);
    ok("rejected scheduled call persisted no row", persisted.length === 0, `rows=${persisted.length}`);
  }

  console.log("[8] live: merchant API-key bot needs NO code for requests");
  {
    const r = await initializePOST(mkReq("http://t/api/payments/initialize",
      { method: "POST", apiKey: mApiKey, body: { amount: "2", currency: "USDC" }, xff: XFF("merchant-key") }) as any);
    const b = await json(r);
    ok("x-api-key request succeeds with no PIN concept", r.status === 200 && b.success === true && !!b.reference, `status=${r.status} ${JSON.stringify(b).slice(0, 120)}`);
    if (b.reference) references.push(b.reference);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log("FAILURES:"); for (const f of failures) console.log(` - ${f}`); }
}

async function cleanup() {
  if (references.length) await prisma.paymentLog.deleteMany({ where: { reference: { in: references } } }).catch(() => {});
  await prisma.scheduledPayment.deleteMany({ where: { payerSCA: { in: wallets } } }).catch(() => {});
  // Foreign-payout rows (if any leaked) carry merchantSCA in wallets — remove by reference list already; belt-and-braces:
  await prisma.paymentLog.deleteMany({ where: { merchantSCA: { in: wallets } } }).catch(() => {});
  if (merchantIds.length) await prisma.merchant.deleteMany({ where: { id: { in: merchantIds } } }).catch(() => {});
  await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: wallets } } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
}

main().then(cleanup).then(() => process.exit(failed ? 1 : 0)).catch(async (e) => {
  console.error("FATAL", e);
  await cleanup();
  process.exit(1);
});
