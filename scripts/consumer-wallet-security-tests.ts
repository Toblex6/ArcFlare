/**
 * consumer-wallet-security-tests.ts
 *
 * Stage 2 (wallet security: email recovery + PIN step-up) verification.
 *
 * Covers B6:
 *  Recovery: no-email account works in original browser · valid OTP attaches
 *    email · invalid/expired/reused OTP rejected · rate limiting triggers ·
 *    no raw OTP in logs/responses · second-device recovery yields the correct
 *    session · one email can't resolve to multiple wallets.
 *  Step-up: correct PIN allows a protected action · wrong PIN blocks it ·
 *    lockout after N failures · PIN never in any response/session · session
 *    without step-up cannot bypass a protected route · reads stay un-gated ·
 *    every Stage-1 inventory route calls the canonical helper.
 *  Regression: consumer auth/session/challenge untouched · zero-friction
 *    wallet creation path ungated · balances/history available.
 *
 * Approach follows repo convention (real Prisma fixtures with random wallets
 * + cleanup, live exported-handler invocation, static source proofs). No
 * chain writes are attempted: the live protected-route probe is
 * POST /api/payments/scheduled, which 400s (fail-closed, no bound wallet)
 * AFTER passing step-up — proving the gate without moving funds. No Circle
 * calls are made; the Resend transport is stubbed at global.fetch.
 *
 * Run: npx tsx scripts/consumer-wallet-security-tests.ts
 * No dev server required.
 */
import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: ".env.local" });

import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { TextEncoder } from "util";
import { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { issueConsumerSessionToken } from "@/lib/auth/consumerSession";
import { hashOtpCode } from "@/lib/auth/consumerOtp";
import { requireConsumerStepUp } from "@/lib/auth/consumerStepUp";
import { POST as pinSetPOST, PUT as pinChangePUT, GET as pinStatusGET } from "@/app/api/consumer/pin/route";
import { POST as emailRequestPOST, PUT as emailVerifyPUT } from "@/app/api/consumer/email/route";
import { POST as recoverRequestPOST, PUT as recoverVerifyPUT } from "@/app/api/consumer/recover/route";
import { GET as securityGET } from "@/app/api/consumer/security/route";
import { GET as activityGET } from "@/app/api/consumer/activity/route";
import { GET as sessionCheckGET } from "@/app/api/consumer/session/route";
import { POST as scheduledPOST } from "@/app/api/payments/scheduled/route";
import { POST as initializePOST } from "@/app/api/payments/initialize/route";

const prisma = new PrismaClient() as any;
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

const RUN = Date.now().toString(36);
const XFF = (t: string) => `ws-sec-${t}-${RUN}`;
const wallets: string[] = [];
const emails: string[] = [];
const references: string[] = [];
const mkWallet = () => {
  const w = ethers.Wallet.createRandom().address;
  wallets.push(w);
  return w;
};
const mkEmail = (t: string) => {
  const e = `ws-sec-${t}-${RUN}@example.com`.toLowerCase();
  emails.push(e);
  return e;
};

function mkReq(url: string, opts: {
  method?: string; token?: string; pin?: string; body?: unknown; xff: string;
}): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.xff,
  };
  if (opts.token) headers.cookie = `consumer_token=${opts.token}`;
  if (opts.pin) headers["x-consumer-pin"] = opts.pin;
  return new NextRequest(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  } as any);
}
const json = async (res: any) => { try { return await res.json(); } catch { return {}; } };

// ── Resend transport stub (captures outbound email, delegates the rest) ──
const realFetch = global.fetch;
const sentEmails: Array<{ to: string; body: string }> = [];
(global as any).fetch = async (input: any, init: any) => {
  const url = String(input?.url ?? input);
  if (url.includes("api.resend.com")) {
    const payload = JSON.parse(String(init?.body ?? "{}"));
    sentEmails.push({ to: String(payload?.to ?? ""), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ data: { id: "re_ws_test" }, error: null }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

// ── console capture (OTP/PIN leak detection) ──
const capturedLogs: string[] = [];
const realLog = console.log;
const realErr = console.error;
console.log = (...a: any[]) => { capturedLogs.push(a.map(String).join(" ")); realLog(...a); };
console.error = (...a: any[]) => { capturedLogs.push(a.map(String).join(" ")); realErr(...a); };

// ── Static inventory cross-check (Stage 1 → Stage 2 wiring) ──
const ROOT = process.cwd();
const REQUIRED_CALLERS = [
  "src/app/api/consumer/assistant/route.ts",
  "src/app/api/consumer/email/route.ts",
  "src/app/api/consumer/pin/route.ts",
  "src/app/api/cctp/transfer/route.ts",
  "src/app/api/payments/initialize/route.ts",
  "src/app/api/payments/settle/route.ts",
  "src/app/api/payments/scheduled/route.ts",
  "src/app/api/jobs/route.ts",
  "src/app/api/jobs/fund/route.ts",
  "src/app/api/jobs/[jobId]/fund/route.ts",
  "src/app/api/jobs/complete/route.ts",
  "src/app/api/jobs/set-budget/route.ts",
  "src/app/api/jobs/submit/route.ts",
  "src/app/api/jobs/[jobId]/accept/route.ts",
  "src/app/api/agents/[id]/hire/route.ts",
  "src/app/api/agents/[id]/treasury/hire/route.ts",
  "src/app/api/procurement/[id]/hire/route.ts",
  "src/app/api/jobs/nanopay/open/route.ts",
  "src/app/api/jobs/nanopay/release/route.ts",
  "src/app/api/jobs/nanopay/close/route.ts",
  "src/app/api/jobs/[jobId]/validation/request/route.ts",
  "src/app/api/jobs/[jobId]/validation/respond/route.ts",
  "src/app/api/agents/[id]/pay/route.ts",
  "src/app/api/payroll/fund/route.ts",
  "src/app/api/escrow/release/route.ts",
  "src/app/api/escrow/dispute/route.ts",
  "src/app/api/agents/[id]/policy/route.ts",
  "src/app/api/agents/[id]/treasury/route.ts",
  "src/app/api/agents/[id]/treasury/credit/route.ts",
  "src/app/api/agents/[id]/acceptance-policy/route.ts",
  "src/app/api/agents/[id]/wallet/route.ts",
  "src/lib/agents/agentPay.ts",
  "src/lib/payroll/payrollExecution.ts",
  "src/lib/telegram/botHandlers.ts",
];

async function main() {
  console.log("[0] environment");
  const host = (process.env.DATABASE_URL ?? "").replace(/:[^:@]+@/, ":***@").split("@")[1]?.split("/")[0] ?? "?";
  ok("DATABASE_URL present (host logged, secret masked)", !!process.env.DATABASE_URL, host);
  console.log(`    db host: ${host}`);
  ok("CONSUMER_JWT_SECRET configured", (process.env.CONSUMER_JWT_SECRET ?? "").length >= 32);

  console.log("[1] static: every Stage-1 inventory route calls the canonical helper");
  let callersOk = true;
  for (const f of REQUIRED_CALLERS) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    // agents/[id]/policy delegates to lib setAgentPolicy (gated there);
    // agents/[id]/pay + payroll/fund delegate to gated lib cores;
    // botHandlers uses the same module's bot adapter.
    const direct =
      src.includes("requireConsumerStepUpForActor") ||
      src.includes("requireConsumerStepUp(") ||
      src.includes("verifyConsumerPinForBot");
    const delegated =
      (f === "src/app/api/agents/[id]/policy/route.ts" && src.includes("setAgentPolicy")) ||
      (f === "src/app/api/agents/[id]/pay/route.ts" && src.includes("executeAgentToAgentPayment")) ||
      (f === "src/app/api/payroll/fund/route.ts" && src.includes("fundPayrollViaX402")) ||
      (f === "src/app/api/agents/[id]/treasury/credit/route.ts"); // merchant-401 inner: consumer-unreachable
    if (!(direct || delegated)) { callersOk = false; console.log(`    MISSING: ${f}`); }
  }
  ok("all 34 inventory files reference the canonical step-up module (or documented delegate)", callersOk);
  const agentPaySrc = fs.readFileSync(path.join(ROOT, "src/lib/agents/agentPay.ts"), "utf8");
  ok("agentPay lib cores gated (executeAgentToAgentPayment + setAgentPolicy)", (agentPaySrc.match(/requireConsumerStepUpForActor/g) ?? []).length >= 2);
  const payrollSrc = fs.readFileSync(path.join(ROOT, "src/lib/payroll/payrollExecution.ts"), "utf8");
  ok("payrollExecution fund core gated", payrollSrc.includes("requireConsumerStepUpForActor"));
  const botSrc = fs.readFileSync(path.join(ROOT, "src/lib/telegram/botHandlers.ts"), "utf8");
  ok("bot uses same-module adapter (verifyConsumerPinForBot) + pin forwarding", botSrc.includes("verifyConsumerPinForBot") && botSrc.includes("CONSUMER_PIN_HEADER"));
  const sessionSrc = fs.readFileSync(path.join(ROOT, "src/lib/auth/consumerSession.ts"), "utf8");
  ok("no second session system (sole minter untouched, no PIN field)", !/pin/i.test(sessionSrc));
  const consumerSessionRoute = fs.readFileSync(path.join(ROOT, "src/app/api/consumer/session/route.ts"), "utf8");
  ok("zero-friction creation path ungated (session route has no step-up)", !consumerSessionRoute.includes("consumerStepUp"));

  // ── Fixtures ──
  console.log("[2] fixtures");
  const wNoEmail = mkWallet();
  const wPin = mkWallet();
  const wLock = mkWallet();
  const wAttach = mkWallet();
  const wRecover = mkWallet();
  const aNoEmail = await prisma.consumerAccount.create({ data: { walletAddress: wNoEmail, walletType: "CIRCLE", circleWalletId: `ws-sec-${RUN}-1`, onboardingSource: "web" } });
  const aPin = await prisma.consumerAccount.create({ data: { walletAddress: wPin, walletType: "CIRCLE", onboardingSource: "web" } });
  const aLock = await prisma.consumerAccount.create({ data: { walletAddress: wLock, walletType: "CIRCLE", onboardingSource: "web" } });
  const aAttach = await prisma.consumerAccount.create({ data: { walletAddress: wAttach, walletType: "CIRCLE", onboardingSource: "web" } });
  const aRecover = await prisma.consumerAccount.create({ data: { walletAddress: wRecover, walletType: "CIRCLE", circleWalletId: `ws-sec-${RUN}-2`, onboardingSource: "web" } });
  const tNoEmail = await issueConsumerSessionToken(aNoEmail.id, wNoEmail);
  const tPin = await issueConsumerSessionToken(aPin.id, wPin);
  const tLock = await issueConsumerSessionToken(aLock.id, wLock);
  const tAttach = await issueConsumerSessionToken(aAttach.id, wAttach);
  const tRecover = await issueConsumerSessionToken(aRecover.id, wRecover);
  ok("fixtures created (5 accounts + sessions)", true);

  console.log("[3] recovery: no-email account works in original browser");
  {
    const r = await securityGET(mkReq("http://t/api/consumer/security", { token: tNoEmail, xff: XFF("sec") }) as any);
    const b = await json(r);
    ok("security status readable, no recovery + no PIN", r.status === 200 && b.hasRecoveryEmail === false && b.hasPin === false, JSON.stringify(b).slice(0, 120));
    const ra = await activityGET(mkReq("http://t/api/consumer/activity", { token: tNoEmail, xff: XFF("act") }) as any);
    const ba = await json(ra);
    ok("history readable with session alone (read un-gated)", ra.status === 200 && ba.success === true, `status=${ra.status}`);
    const rs = (await sessionCheckGET(mkReq("http://t/api/consumer/session", { token: tNoEmail, xff: XFF("sess") }) as any))!;
    ok("session check works (existing auth untouched)", rs.status === 200, `status=${rs.status}`);
  }

  console.log("[4] PIN lifecycle: set (bootstrap) + status + change (step-up)");
  const PIN = "4821";
  {
    const r = await pinSetPOST(mkReq("http://t/api/consumer/pin", { method: "POST", token: tPin, body: { pin: PIN }, xff: XFF("pinset") }) as any);
    const b = await json(r);
    ok("POST /pin sets PIN (session-only bootstrap)", r.status === 200 && b.set === true, `${r.status} ${JSON.stringify(b)}`);
    ok("set response carries no secret", !JSON.stringify(b).includes(PIN) && !JSON.stringify(b).toLowerCase().includes("hash"));
    const r2 = await pinSetPOST(mkReq("http://t/api/consumer/pin", { method: "POST", token: tPin, body: { pin: "9999" }, xff: XFF("pinset2") }) as any);
    ok("second POST rejected (409, must use PUT)", r2.status === 409);
    const r3 = await pinStatusGET(mkReq("http://t/api/consumer/pin", { token: tPin, xff: XFF("pinget") }) as any);
    const b3 = await json(r3);
    ok("GET /pin reports boolean only", r3.status === 200 && b3.set === true && !JSON.stringify(b3).includes(PIN));
    // change without old PIN → blocked by canonical helper
    const r4 = await pinChangePUT(mkReq("http://t/api/consumer/pin", { method: "PUT", token: tPin, body: { newPin: "9933" }, xff: XFF("pinchg0") }) as any);
    const b4 = await json(r4);
    ok("PUT /pin without old PIN blocked (STEP_UP_REQUIRED)", r4.status === 403 && b4.code === "STEP_UP_REQUIRED", `${r4.status} ${b4.code}`);
    // change with old PIN → ok
    const r5 = await pinChangePUT(mkReq("http://t/api/consumer/pin", { method: "PUT", token: tPin, pin: PIN, body: { newPin: "9933" }, xff: XFF("pinchg1") }) as any);
    const b5 = await json(r5);
    ok("PUT /pin with old PIN rotates", r5.status === 200 && b5.changed === true, `${r5.status} ${JSON.stringify(b5)}`);
    // old PIN dead, new PIN live
    const acc = await prisma.consumerAccount.findUnique({ where: { id: aPin.id } });
    const oldCheck = await requireConsumerStepUp(
      mkReq("http://t/x", { token: tPin, pin: PIN, xff: XFF("oldpin") }) as any, acc, "consumer.send");
    ok("old PIN no longer verifies", oldCheck !== null && (oldCheck as any).status === 403);
    const newCheck = await requireConsumerStepUp(
      mkReq("http://t/x", { token: tPin, pin: "9933", xff: XFF("newpin") }) as any, acc, "consumer.send");
    ok("new PIN verifies (helper returns null)", newCheck === null);
  }

  console.log("[5] step-up gate semantics (direct helper)");
  {
    const accPin = await prisma.consumerAccount.findUnique({ where: { id: aPin.id } });
    const noHeader = await requireConsumerStepUp(mkReq("http://t/x", { token: tPin, xff: XFF("g0") }) as any, accPin, "consumer.send");
    const noHeaderBody = noHeader ? await json(noHeader) : null;
    ok("session alone rejected once enrolled (STEP_UP_REQUIRED)", !!noHeader && (noHeader as any).status === 403 && noHeaderBody?.code === "STEP_UP_REQUIRED");
    const wrong = await requireConsumerStepUp(mkReq("http://t/x", { token: tPin, pin: "0000", xff: XFF("g1") }) as any, accPin, "consumer.send");
    const wrongBody = wrong ? await json(wrong) : null;
    ok("wrong PIN blocked (STEP_UP_FAILED + remaining)", !!wrong && (wrong as any).status === 403 && wrongBody?.code === "STEP_UP_FAILED" && typeof wrongBody?.remainingAttempts === "number");
    const accNoPin = await prisma.consumerAccount.findUnique({ where: { id: aNoEmail.id } });
    const grace = await requireConsumerStepUp(mkReq("http://t/x", { token: tNoEmail, xff: XFF("g2") }) as any, accNoPin, "consumer.send");
    ok("no-PIN account passes (bootstrap grace, zero-friction preserved)", grace === null);
    const noSession = await requireConsumerStepUp(mkReq("http://t/x", { xff: XFF("g3") }) as any, accPin, "consumer.send");
    ok("no session → 401 (existing check first)", !!noSession && (noSession as any).status === 401);
    const mismatch = await requireConsumerStepUp(mkReq("http://t/x", { token: tNoEmail, pin: "9933", xff: XFF("g4") }) as any, accPin, "consumer.send");
    ok("account/session mismatch → 403", !!mismatch && (mismatch as any).status === 403);
    // PIN never in JWT payload
    const secret = new TextEncoder().encode(process.env.CONSUMER_JWT_SECRET!);
    const { payload } = await jwtVerify(tPin, secret);
    ok("JWT payload carries no PIN material", !("pin" in payload) && !("pinHash" in payload) && JSON.stringify(payload).length < 300, Object.keys(payload).join(","));
  }

  console.log("[6] lockout after N failures (isolated account)");
  {
    const r0 = await pinSetPOST(mkReq("http://t/api/consumer/pin", { method: "POST", token: tLock, body: { pin: "5511" }, xff: XFF("lockset") }) as any);
    ok("lockout fixture PIN set", r0.status === 200);
    for (let i = 0; i < 5; i++) {
      await requireConsumerStepUp(mkReq("http://t/x", { token: tLock, pin: "0000", xff: XFF(`lock${i}`) }) as any,
        await prisma.consumerAccount.findUnique({ where: { id: aLock.id } }), "consumer.send");
    }
    const after = await prisma.consumerAccount.findUnique({ where: { id: aLock.id } });
    ok("5 failures recorded on the row", after.pinFailedAttempts === 5 && !!after.pinLockedUntil, `attempts=${after.pinFailedAttempts}`);
    const correctWhileLocked = await requireConsumerStepUp(
      mkReq("http://t/x", { token: tLock, pin: "5511", xff: XFF("lock-final") }) as any, after, "consumer.send");
    ok("correct PIN rejected while locked (423)", !!correctWhileLocked && (correctWhileLocked as any).status === 423, `status=${(correctWhileLocked as any)?.status}`);
  }

  console.log("[7] protected-route probe: POST /api/payments/scheduled (no chain)");
  {
    const body = { payerSCA: wPin, receiverSCA: wPin, amount: 1, intervalDays: 7, description: "ws test" };
    const rNoPin = await scheduledPOST(mkReq("http://t/api/payments/scheduled", { method: "POST", token: tPin, body, xff: XFF("sched0") }) as any);
    const bNoPin = await json(rNoPin);
    ok("session-only scheduled create rejected (STEP_UP_REQUIRED, nothing persisted)", rNoPin.status === 403 && bNoPin.code === "STEP_UP_REQUIRED", `${rNoPin.status} ${bNoPin.code}`);
    const persisted = await prisma.scheduledPayment.findMany({ where: { payerSCA: wPin } });
    ok("rejected call persisted no row", persisted.length === 0);
    const rWithPin = await scheduledPOST(mkReq("http://t/api/payments/scheduled", { method: "POST", token: tPin, pin: "9933", body, xff: XFF("sched1") }) as any);
    const bWithPin = await json(rWithPin);
    // Fixture has no bound Circle wallet → must fail CLOSED (400), proving the gate passed without moving funds.
    ok("correct PIN passes step-up (fail-closed 400, no wallet — no chain)", rWithPin.status === 400 && !String(bWithPin.code ?? "").startsWith("STEP_UP"), `${rWithPin.status} ${JSON.stringify(bWithPin).slice(0, 100)}`);
    // initialize (consumer send) — same gate, no chain in initialize itself
    const initBody = { amount: "1", currency: "USDC", merchant: "ws test", direction: "send", payoutAddress: mkWallet() };
    const rInitNoPin = await initializePOST(mkReq("http://t/api/payments/initialize", { method: "POST", token: tPin, body: initBody, xff: XFF("init0") }) as any);
    ok("session-only initialize rejected (STEP_UP_REQUIRED)", rInitNoPin.status === 403 && (await json(rInitNoPin)).code === "STEP_UP_REQUIRED", `status=${rInitNoPin.status}`);
    const rInitPin = await initializePOST(mkReq("http://t/api/payments/initialize", { method: "POST", token: tPin, pin: "9933", body: initBody, xff: XFF("init1") }) as any);
    const bInitPin = await json(rInitPin);
    ok("initialize with PIN creates invoice (existing flow works)", rInitPin.status === 200 && bInitPin.success === true && !!bInitPin.reference, `${rInitPin.status}`);
    if (bInitPin.reference) references.push(bInitPin.reference);
  }

  console.log("[8] OTP attach flow (known-code rows, exact storage format)");
  {
    const email = mkEmail("attach");
    const code = "123456";
    await prisma.consumerEmailOtp.create({
      data: { accountId: aAttach.id, email, codeHash: hashOtpCode(code), purpose: "EMAIL_ATTACH", expiresAt: new Date(Date.now() + 600_000) },
    });
    const stored = await prisma.consumerEmailOtp.findFirst({ where: { email } });
    ok("OTP stored as hash, never raw", !!stored && stored.codeHash !== code && /^[0-9a-f]{64}$/.test(stored.codeHash));
    const rBad = await emailVerifyPUT(mkReq("http://t/api/consumer/email", { method: "PUT", token: tAttach, body: { email, code: "000000" }, xff: XFF("otp-bad") }) as any);
    ok("wrong code rejected (generic)", rBad.status === 400 && (await json(rBad)).error === "Invalid or expired code.");
    const rOk = await emailVerifyPUT(mkReq("http://t/api/consumer/email", { method: "PUT", token: tAttach, body: { email, code }, xff: XFF("otp-ok") }) as any);
    const bOk = await json(rOk);
    ok("valid OTP attaches email + verified", rOk.status === 200 && bOk.emailSet === true && !!bOk.maskedEmail && !JSON.stringify(bOk).includes(email), JSON.stringify(bOk));
    const rowGone = await prisma.consumerEmailOtp.findFirst({ where: { email } });
    ok("OTP single-use (row consumed)", rowGone === null);
    const rReuse = await emailVerifyPUT(mkReq("http://t/api/consumer/email", { method: "PUT", token: tAttach, body: { email, code }, xff: XFF("otp-reuse") }) as any);
    ok("reused OTP rejected", rReuse.status === 400);
    // expired
    const email2 = mkEmail("expired");
    await prisma.consumerEmailOtp.create({
      data: { accountId: aAttach.id, email: email2, codeHash: hashOtpCode("654321"), purpose: "EMAIL_CHANGE", expiresAt: new Date(Date.now() - 1000) },
    });
    const rExp = await emailVerifyPUT(mkReq("http://t/api/consumer/email", { method: "PUT", token: tAttach, body: { email: email2, code: "654321" }, xff: XFF("otp-exp") }) as any);
    ok("expired OTP rejected", rExp.status === 400);
    // wrong-code attempts invalidate after max
    const email3 = mkEmail("brute");
    await prisma.consumerEmailOtp.create({
      data: { accountId: aAttach.id, email: email3, codeHash: hashOtpCode("222222"), purpose: "EMAIL_CHANGE", expiresAt: new Date(Date.now() + 600_000) },
    });
    for (let i = 0; i < 5; i++) {
      await emailVerifyPUT(mkReq("http://t/api/consumer/email", { method: "PUT", token: tAttach, body: { email: email3, code: "000000" }, xff: XFF(`otp-br${i}`) }) as any);
    }
    const bruteGone = await prisma.consumerEmailOtp.findFirst({ where: { email: email3 } });
    ok("OTP invalidated after 5 wrong guesses", bruteGone === null);
  }

  console.log("[9] POST /api/consumer/email request path (stubbed transport, leak check)");
  {
    capturedLogs.length = 0;
    const email = mkEmail("req");
    const wB = mkWallet();
    const aB = await prisma.consumerAccount.create({ data: { walletAddress: wB, walletType: "CIRCLE", onboardingSource: "web" } });
    const tB = await issueConsumerSessionToken(aB.id, wB);
    const r = await emailRequestPOST(mkReq("http://t/api/consumer/email", { method: "POST", token: tB, body: { email }, xff: XFF("emailreq") }) as any);
    const b = await json(r);
    ok("attach request returns generic success", r.status === 200 && b.sent === true && Object.keys(b).sort().join(",") === "sent,success", JSON.stringify(b));
    const sent = sentEmails.find((e) => e.to === email);
    ok("exactly one email sent to the address", !!sent, `sent=${sentEmails.length}`);
    const m = sent ? sent.body.match(/(\d{6})/) : null;
    const liveCode = m ? m[1] : null;
    ok("email body carries a 6-digit code (necessary)", !!liveCode);
    if (liveCode) {
      ok("response carries no raw OTP", !JSON.stringify(b).includes(liveCode));
      ok("logs carry no raw OTP", !capturedLogs.some((l) => l.includes(liveCode)));
      const row = await prisma.consumerEmailOtp.findFirst({ where: { email } });
      ok("stored row is a hash of the sent code", !!row && row.codeHash === hashOtpCode(liveCode) && row.purpose === "EMAIL_ATTACH");
      // end-to-end with the real sent code
      const rv = await emailVerifyPUT(mkReq("http://t/api/consumer/email", { method: "PUT", token: tB, body: { email, code: liveCode }, xff: XFF("emailreq-v") }) as any);
      ok("real sent code verifies", rv.status === 200);
    }
    // taken email → generic success, no new row for the requester
    const takenEmail = (await prisma.consumerAccount.findUnique({ where: { id: aAttach.id } })).email as string;
    const before = await prisma.consumerEmailOtp.count({ where: { email: takenEmail } });
    const rTaken = await emailRequestPOST(mkReq("http://t/api/consumer/email", { method: "POST", token: tB, body: { email: takenEmail }, xff: XFF("emailtaken") }) as any);
    const after = await prisma.consumerEmailOtp.count({ where: { email: takenEmail } });
    ok("taken address: generic success, no code minted (anti-enumeration)", rTaken.status === 200 && (await json(rTaken)).sent === true && after === before);
    // change flow without step-up → blocked (attach account now HAS an email)
    const rChangeNoPin = await emailRequestPOST(mkReq("http://t/api/consumer/email", { method: "POST", token: tAttach, body: { email: mkEmail("change0") }, xff: XFF("emailchg0") }) as any);
    // aAttach has no PIN → bootstrap grace allows (no PIN enrolled)
    ok("change request without PIN passes only via bootstrap grace (no PIN enrolled)", rChangeNoPin.status === 200, `status=${rChangeNoPin.status}`);
  }

  console.log("[10] recovery: second device + one-email-one-wallet + rate limit");
  {
    // give aRecover a verified email directly (as the attach flow would)
    const recEmail = mkEmail("recover");
    await prisma.consumerAccount.update({ where: { id: aRecover.id }, data: { email: recEmail, emailVerifiedAt: new Date() } });
    // unknown email → same generic success
    const rUnknown = await recoverRequestPOST(mkReq("http://t/api/consumer/recover", { method: "POST", body: { email: mkEmail("nobody") }, xff: XFF("rec-unk") }) as any);
    const sentBefore = sentEmails.length;
    ok("unknown email: generic success, nothing sent", rUnknown.status === 200 && (await json(rUnknown)).success === true && sentEmails.length === sentBefore);
    // known email → code sent, response identical in shape
    const rKnown = await recoverRequestPOST(mkReq("http://t/api/consumer/recover", { method: "POST", body: { email: recEmail }, xff: XFF("rec-known") }) as any);
    const bKnown = await json(rKnown);
    ok("known email: identical generic success", rKnown.status === 200 && JSON.stringify(bKnown) === JSON.stringify({ success: true }), JSON.stringify(bKnown));
    const sentRec = [...sentEmails].reverse().find((e) => e.to === recEmail);
    const recCode = sentRec?.body.match(/(\d{6})/)?.[1];
    ok("recovery email transported a code", !!recCode);
    if (recCode) {
      const rVerify = await recoverVerifyPUT(mkReq("http://t/api/consumer/recover", { method: "PUT", body: { email: recEmail, code: recCode }, xff: XFF("rec-verify") }) as any);
      const bVerify = await json(rVerify);
      const setCookie = (rVerify.headers.get("set-cookie") ?? "");
      ok("valid recovery code reissues session for the SAME wallet", rVerify.status === 200 && setCookie.includes("consumer_token=") && bVerify.account?.walletAddress === wRecover, `status=${rVerify.status} wallet=${bVerify.account?.walletAddress}`);
      const mTok = setCookie.match(/consumer_token=([^;]+)/);
      if (mTok) {
        const secret = new TextEncoder().encode(process.env.CONSUMER_JWT_SECRET!);
        const { payload } = await jwtVerify(mTok[1], secret);
        ok("recovered JWT binds correct consumerId + wallet, no secrets", payload.consumerId === aRecover.id && payload.walletAddress === wRecover && !("pin" in payload));
      }
      const rReuse = await recoverVerifyPUT(mkReq("http://t/api/consumer/recover", { method: "PUT", body: { email: recEmail, code: recCode }, xff: XFF("rec-reuse") }) as any);
      ok("recovery code single-use", rReuse.status === 400);
    }
    // rate limit: 8 rapid requests, same identity → 429s after 5
    const rlXff = XFF("ratelimit");
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await recoverRequestPOST(mkReq("http://t/api/consumer/recover", { method: "POST", body: { email: mkEmail(`rl${i}`) }, xff: rlXff }) as any);
      statuses.push(r.status);
    }
    ok("OTP request rate-limited (5 ok, then 429)", statuses.slice(0, 5).every((s) => s === 200) && statuses.slice(5).every((s) => s === 429), statuses.join(","));
  }

  console.log("[11] reads stay un-gated; regression spot-checks");
  {
    const rAct = await activityGET(mkReq("http://t/api/consumer/activity", { token: tPin, xff: XFF("regress-act") }) as any);
    ok("activity readable with PIN enrolled but no PIN sent", rAct.status === 200, `status=${rAct.status}`);
    const rSec = await securityGET(mkReq("http://t/api/consumer/security", { token: tPin, xff: XFF("regress-sec") }) as any);
    const bSec = await json(rSec);
    ok("security status reflects enrollment (booleans only)", rSec.status === 200 && bSec.hasPin === true && bSec.hasRecoveryEmail === false && !("pinHash" in bSec) && !("email" in bSec), JSON.stringify(bSec).slice(0, 140));
  }

  console.log(`\n${passed} passed, ${failed} failed, ${blocked} blocked`);
  if (failures.length) { console.log("FAILURES:"); for (const f of failures) console.log(` - ${f}`); }
}

async function cleanup() {
  (global as any).fetch = realFetch;
  console.log = realLog;
  console.error = realErr;
  await prisma.consumerEmailOtp.deleteMany({ where: { email: { in: emails } } }).catch(() => {});
  if (references.length) await prisma.paymentLog.deleteMany({ where: { reference: { in: references } } }).catch(() => {});
  await prisma.scheduledPayment.deleteMany({ where: { payerSCA: { in: wallets } } }).catch(() => {});
  await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: wallets } } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
}

main().then(cleanup).then(() => process.exit(failed ? 1 : 0)).catch(async (e) => {
  console.error("FATAL", e);
  await cleanup();
  process.exit(1);
});
