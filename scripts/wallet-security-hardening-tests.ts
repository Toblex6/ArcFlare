/**
 * wallet-security-hardening-tests.ts (Stage 3: F1–F4 concurrency + ordering).
 *
 * F1: 10 concurrent wrong-PIN attempts atomically count (no collapse to 1–2),
 *     lockout is deterministic, correct-PIN-while-locked fails, sequential
 *     behavior unchanged.
 * F2: two simultaneous correct-OTP verifications → exactly one succeeds,
 *     exactly one fails; sequential reuse still fails; five-strike intact.
 * F3: unauthorized / insufficiently stepped-up consumer cannot reserve an
 *     agent-pay idempotency key; stepped-up consumer reserves + replays
 *     correctly; service-key/non-consumer path unchanged (step-up passthrough).
 * F4: unauthorized wallet-GET requests never provision (no X402EoaWallet row,
 *     no key material disclosed); authorized read/create preserved; static
 *     order proof (auth + step-up before getOrCreateAgentWallet).
 *
 * No chain writes are attempted beyond best-effort reads: F3's legitimate
 * reservation is proven by the PENDING claim row surviving even when the
 * later on-chain stage fails/throws; replays return before any chain touch.
 *
 * Run: npx tsx scripts/wallet-security-hardening-tests.ts
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
import { hashOtpCode, verifyConsumerOtp } from "@/lib/auth/consumerOtp";
import {
  checkConsumerPin,
  hashConsumerPin,
  requireConsumerStepUp,
  requireConsumerStepUpForActor,
} from "@/lib/auth/consumerStepUp";
import { executeAgentToAgentPayment } from "@/lib/agents/agentPay";
import { GET as walletGET } from "@/app/api/agents/[id]/wallet/route";

const prisma = new PrismaClient() as any;
let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const RUN = Date.now().toString(36);
const XFF = (t: string) => `ws-hard-${t}-${RUN}`.slice(0, 60);
const wallets: string[] = [];
const emails: string[] = [];
const idemKeys: string[] = [];
const agentIds: number[] = [];
const merchantEmails: string[] = [];
const mkWallet = () => {
  const w = ethers.Wallet.createRandom().address;
  wallets.push(w);
  return w;
};
const mkEmail = (t: string) => {
  const e = `ws-hard-${t}-${RUN}@example.com`.toLowerCase();
  emails.push(e);
  return e;
};
const mkKey = (t: string) => {
  const k = `ws-hard-${t}-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  idemKeys.push(k);
  return k;
};

function mkReq(
  url: string,
  opts: { method?: string; token?: string; apiKey?: string; pin?: string; body?: unknown; xff: string }
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.xff,
  };
  if (opts.token) headers.cookie = `consumer_token=${opts.token}`;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  if (opts.pin) headers["x-consumer-pin"] = opts.pin;
  return new NextRequest(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  } as any);
}
const json = async (res: any) => { try { return await res.json(); } catch { return {}; } };

async function main() {
  console.log("[F1] atomic PIN lockout");
  const PIN_CON = "9876";
  const wCon = mkWallet();
  const aCon = await prisma.consumerAccount.create({
    data: { walletAddress: wCon, walletType: "CIRCLE", onboardingSource: "web" },
  });
  await prisma.consumerAccount.update({
    where: { id: aCon.id },
    data: { pinHash: await hashConsumerPin(PIN_CON), pinFailedAttempts: 0, pinLockedUntil: null },
  });
  const tCon = await issueConsumerSessionToken(aCon.id, wCon);

  // 10 concurrent wrong attempts must each count (atomic increment).
  const results = await Promise.all(
    Array.from({ length: 10 }, () => checkConsumerPin(aCon.id, "0000"))
  );
  const afterCon = await prisma.consumerAccount.findUnique({ where: { id: aCon.id } });
  ok("10 concurrent wrong PINs recorded atomically (attempts === 10)", afterCon.pinFailedAttempts === 10, `attempts=${afterCon.pinFailedAttempts}`);
  ok("no collapse to 1–2 recorded attempts", (afterCon.pinFailedAttempts ?? 0) > 2, `attempts=${afterCon.pinFailedAttempts}`);
  ok("account locked after concurrent burst", !!afterCon.pinLockedUntil && new Date(afterCon.pinLockedUntil).getTime() > Date.now());
  ok("all concurrent results fail closed", results.every((r) => !r.ok));
  const lockedResults = results.filter((r) => !r.ok && (r as any).locked);
  ok("burst reaches the lockout threshold (≥1 locked verdict)", lockedResults.length >= 1, `locked=${lockedResults.length}/10`);

  // Correct PIN cannot succeed once locked.
  const correctWhileLocked = await checkConsumerPin(aCon.id, PIN_CON);
  ok("correct PIN rejected while locked (checkConsumerPin)", !correctWhileLocked.ok && (correctWhileLocked as any).locked === true);
  const httpLocked = await requireConsumerStepUp(
    mkReq("http://t/x", { token: tCon, pin: PIN_CON, xff: XFF("f1-locked") }) as any,
    await prisma.consumerAccount.findUnique({ where: { id: aCon.id } }),
    "consumer.send"
  );
  ok("correct PIN while locked → 423 via HTTP gate", !!httpLocked && (httpLocked as any).status === 423, `status=${(httpLocked as any)?.status}`);

  // Sequential behavior unchanged on an isolated account.
  const wSeq = mkWallet();
  const aSeq = await prisma.consumerAccount.create({
    data: { walletAddress: wSeq, walletType: "CIRCLE", onboardingSource: "web" },
  });
  await prisma.consumerAccount.update({
    where: { id: aSeq.id },
    data: { pinHash: await hashConsumerPin("1234"), pinFailedAttempts: 0, pinLockedUntil: null },
  });
  const tSeq = await issueConsumerSessionToken(aSeq.id, wSeq);
  const oneWrong = await checkConsumerPin(aSeq.id, "0000");
  ok("sequential: single wrong → remaining 4, not locked", !oneWrong.ok && (oneWrong as any).locked === false && (oneWrong as any).remaining === 4, JSON.stringify(oneWrong));
  const seqRow = await prisma.consumerAccount.findUnique({ where: { id: aSeq.id } });
  ok("sequential: exactly 1 attempt recorded", seqRow.pinFailedAttempts === 1, `attempts=${seqRow.pinFailedAttempts}`);
  const seqOk = await checkConsumerPin(aSeq.id, "1234");
  ok("sequential: correct PIN succeeds and resets", seqOk.ok === true);
  const seqReset = await prisma.consumerAccount.findUnique({ where: { id: aSeq.id } });
  ok("sequential: success resets counter", seqReset.pinFailedAttempts === 0 && !seqReset.pinLockedUntil);
  const httpOk = await requireConsumerStepUp(
    mkReq("http://t/x", { token: tSeq, pin: "1234", xff: XFF("f1-seq") }) as any,
    await prisma.consumerAccount.findUnique({ where: { id: aSeq.id } }),
    "consumer.send"
  );
  ok("sequential: HTTP gate passes with correct PIN", httpOk === null);

  console.log("[F2] atomic OTP consumption");
  const otpEmail = mkEmail("race");
  const otpCode = "445566";
  await prisma.consumerEmailOtp.create({
    data: { accountId: aSeq.id, email: otpEmail, codeHash: hashOtpCode(otpCode), purpose: "EMAIL_ATTACH", expiresAt: new Date(Date.now() + 600_000) },
  });
  const [v1, v2] = await Promise.all([
    verifyConsumerOtp({ email: otpEmail, code: otpCode, purpose: "EMAIL_ATTACH" }),
    verifyConsumerOtp({ email: otpEmail, code: otpCode, purpose: "EMAIL_ATTACH" }),
  ]);
  const wins = [v1, v2].filter((v) => v.ok).length;
  const losses = [v1, v2].filter((v) => !v.ok).length;
  ok("exactly one concurrent verifier succeeds", wins === 1, JSON.stringify([v1, v2]));
  ok("exactly one concurrent verifier fails (already-consumed)", losses === 1);
  const reuse = await verifyConsumerOtp({ email: otpEmail, code: otpCode, purpose: "EMAIL_ATTACH" });
  ok("sequential reuse still fails", !reuse.ok);
  ok("OTP row consumed (no live row left)", (await prisma.consumerEmailOtp.findFirst({ where: { email: otpEmail } })) === null);
  // Five-strike invalidation preserved (isolated email, sequential wrongs).
  const bruteEmail = mkEmail("brute");
  await prisma.consumerEmailOtp.create({
    data: { accountId: aSeq.id, email: bruteEmail, codeHash: hashOtpCode("222222"), purpose: "EMAIL_CHANGE", expiresAt: new Date(Date.now() + 600_000) },
  });
  for (let i = 0; i < 5; i++) {
    await verifyConsumerOtp({ email: bruteEmail, code: "000000", purpose: "EMAIL_CHANGE" });
  }
  ok("five-strike invalidation preserved", (await prisma.consumerEmailOtp.findFirst({ where: { email: bruteEmail } })) === null);
  // Expiry preserved.
  const expEmail = mkEmail("expired");
  await prisma.consumerEmailOtp.create({
    data: { accountId: aSeq.id, email: expEmail, codeHash: hashOtpCode("999999"), purpose: "EMAIL_CHANGE", expiresAt: new Date(Date.now() - 1000) },
  });
  ok("expired OTP rejected", !(await verifyConsumerOtp({ email: expEmail, code: "999999", purpose: "EMAIL_CHANGE" })).ok);

  console.log("[F3] agent-pay idempotency ordering");
  const agentPaySrc = fs.readFileSync(path.join(process.cwd(), "src/lib/agents/agentPay.ts"), "utf8");
  const stepUpIdx = agentPaySrc.indexOf("requireConsumerStepUpForActor(req, actor");
  const authIdx = agentPaySrc.indexOf("verifyCallerControlsAddress(req, agent.scaAddress");
  const claimIdx = agentPaySrc.indexOf("paymentLog.create", stepUpIdx > 0 ? stepUpIdx : 0);
  ok("static: authentication precedes idempotency claim", authIdx >= 0 && claimIdx > authIdx, `auth=${authIdx} claim=${claimIdx}`);
  ok("static: step-up precedes idempotency claim", stepUpIdx >= 0 && claimIdx > stepUpIdx, `stepUp=${stepUpIdx} claim=${claimIdx}`);
  // Non-consumer passthrough unchanged: merchant actors never face a PIN.
  const merchantPassthrough = await requireConsumerStepUpForActor(
    mkReq("http://t/x", { xff: XFF("f3-pass") }) as any,
    { type: "merchant", id: "m-test" } as any,
    "consumer.agent-pay"
  );
  ok("non-consumer callers pass step-up untouched (no new PIN requirement)", merchantPassthrough === null);

  // Consumer-reachable fixture: agent SCA == consumer wallet, PIN enrolled.
  const wPay = mkWallet();
  const aPay = await prisma.consumerAccount.create({
    data: { walletAddress: wPay, walletType: "CIRCLE", onboardingSource: "web" },
  });
  const PAY_PIN = "4821";
  await prisma.consumerAccount.update({
    where: { id: aPay.id },
    data: { pinHash: await hashConsumerPin(PAY_PIN), pinFailedAttempts: 0, pinLockedUntil: null },
  });
  const tPay = await issueConsumerSessionToken(aPay.id, wPay);
  const payAgent = await prisma.agentRegistry.create({
    data: {
      name: `ws-hard-pay-${RUN}`,
      tokenId: `wshardpay${RUN}`.slice(0, 30),
      scaAddress: wPay,
      ownerNode: "ws-hard-test",
      status: "ACTIVE",
    },
  });
  agentIds.push(payAgent.id);
  const payBody = (key: string) => ({ to: mkWallet(), amount: "0.01", idempotencyKey: key });

  // Unauthorized: no PIN → rejected, key NOT squatted.
  const badKey = mkKey("bad");
  const badRes = await executeAgentToAgentPayment(
    mkReq("http://t/agents/pay", { method: "POST", token: tPay, body: payBody(badKey), xff: XFF("f3-bad") }) as any,
    payAgent.id,
    payBody(badKey)
  );
  const badBody = await json(badRes);
  ok("unstepped consumer rejected before claim (403 STEP_UP_REQUIRED)", badRes.status === 403 && (badBody.code === "STEP_UP_REQUIRED" || badBody.code === "STEP_UP_FAILED"), `status=${badRes.status} code=${badBody.code}`);
  ok("rejected consumer reserved NO idempotency row", (await prisma.paymentLog.findUnique({ where: { idempotencyKey: badKey } })) === null);

  // Replay preserved: pre-existing PENDING row replays after passing step-up.
  const replayKey = mkKey("replay");
  await prisma.paymentLog.create({
    data: {
      reference: `ws-hard-replay-${RUN}-${Math.random().toString(36).slice(2, 6)}`,
      idempotencyKey: replayKey,
      amount: 0.01,
      currency: "USDC",
      chain: "Arc Testnet",
      senderEmail: "pending-agent-pay",
      merchant: payAgent.name,
      direction: "send",
      status: "PENDING",
    },
  });
  const replayRes = await executeAgentToAgentPayment(
    mkReq("http://t/agents/pay", { method: "POST", token: tPay, pin: PAY_PIN, body: payBody(replayKey), xff: XFF("f3-replay") }) as any,
    payAgent.id,
    payBody(replayKey)
  );
  ok("stepped-up replay of in-progress key → 409 (no double-spend)", replayRes.status === 409, `status=${replayRes.status}`);

  // Legitimate stepped-up consumer reserves the key (claim row exists even
  // though the later on-chain stage cannot succeed for an unfunded EOA).
  const goodKey = mkKey("good");
  let goodRes: any = null;
  try {
    goodRes = await executeAgentToAgentPayment(
      mkReq("http://t/agents/pay", { method: "POST", token: tPay, pin: PAY_PIN, body: payBody(goodKey), xff: XFF("f3-good") }) as any,
      payAgent.id,
      payBody(goodKey)
    );
  } catch (e: any) {
    goodRes = { status: 0, __threw: String(e?.message ?? e).slice(0, 120) };
  }
  const goodRow = await prisma.paymentLog.findUnique({ where: { idempotencyKey: goodKey } });
  ok("stepped-up consumer reserves the idempotency key", !!goodRow, `status=${goodRes?.status} row=${goodRow ? goodRow.status : "none"}`);
  const goodReplay = await executeAgentToAgentPayment(
    mkReq("http://t/agents/pay", { method: "POST", token: tPay, pin: PAY_PIN, body: payBody(goodKey), xff: XFF("f3-good2") }) as any,
    payAgent.id,
    payBody(goodKey)
  );
  ok("second use of the reserved key replays (no second execution)", goodReplay.status === 409 || goodReplay.status === 200, `status=${goodReplay.status}`);

  console.log("[F4] agent-wallet provisioning order");
  const routeSrc = fs.readFileSync(path.join(process.cwd(), "src/app/api/agents/[id]/wallet/route.ts"), "utf8");
  const rAuth = routeSrc.indexOf("verifyCallerControlsAddress");
  const rStep = routeSrc.indexOf("requireConsumerStepUpForActor");
  const rProv = routeSrc.indexOf("await getOrCreateAgentWallet");
  ok("static: auth precedes provisioning", rAuth >= 0 && rProv > rAuth);
  ok("static: step-up precedes provisioning", rStep >= 0 && rProv > rStep);
  ok("static: pre-auth uses read-only lookup (no provisioning before gate)", routeSrc.includes("getAgentWalletAddress"));

  const mkMerchant = async (tag: string) => {
    const email = `ws-hard-${tag}-${RUN}@example.com`.toLowerCase();
    merchantEmails.push(email);
    const m = await prisma.merchant.create({
      data: {
        email,
        businessName: `ws-hard ${tag} ${RUN}`,
        passwordHash: "ws-hard-not-a-real-hash",
        apiKey: `ws-hard-${tag}-${RUN}-${Math.random().toString(36).slice(2, 10)}`,
        verified: true,
        active: true,
      },
    });
    return m;
  };
  const mA = await mkMerchant("ownera");
  const mB = await mkMerchant("otherb");
  const wAgent = mkWallet();
  const wAgentRow = await prisma.agentRegistry.create({
    data: {
      name: `ws-hard-wallet-${RUN}`,
      tokenId: `wshardwal${RUN}`.slice(0, 30),
      scaAddress: wAgent,
      ownerNode: "ws-hard-test",
      status: "ACTIVE",
      merchantId: mA.id,
    },
  });
  agentIds.push(wAgentRow.id);
  const ctxFor = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as any;

  const noAuthRes = await walletGET(mkReq("http://t/wallet", { xff: XFF("f4-noauth") }) as any, ctxFor(wAgentRow.id));
  ok("no credentials → 401, no wallet material", noAuthRes.status === 401, `status=${noAuthRes.status}`);
  ok(
    "unauthorized request provisions NOTHING",
    (await prisma.x402EoaWallet.findUnique({ where: { agentRegistryId: wAgentRow.id } })) === null
  );
  const otherRes = await walletGET(
    mkReq("http://t/wallet", { apiKey: mB.apiKey, xff: XFF("f4-other") }) as any,
    ctxFor(wAgentRow.id)
  );
  ok("unrelated merchant → 403", otherRes.status === 403, `status=${otherRes.status}`);
  ok(
    "rejected caller provisions NOTHING",
    (await prisma.x402EoaWallet.findUnique({ where: { agentRegistryId: wAgentRow.id } })) === null
  );
  const ownerRes = await walletGET(
    mkReq("http://t/wallet", { apiKey: mA.apiKey, xff: XFF("f4-owner") }) as any,
    ctxFor(wAgentRow.id)
  );
  const ownerBody = await json(ownerRes);
  ok("owner merchant reads/creates wallet (200 + address)", ownerRes.status === 200 && /^0x[a-fA-F0-9]{40}$/.test(ownerBody.address ?? ""), `status=${ownerRes.status}`);
  ok("wallet response leaks no key material", !("privateKey" in ownerBody) && !("encryptedKey" in ownerBody) && !("keyIv" in ownerBody));
  const ownerRes2 = await walletGET(
    mkReq("http://t/wallet", { apiKey: mA.apiKey, xff: XFF("f4-owner2") }) as any,
    ctxFor(wAgentRow.id)
  );
  ok("authorized re-read idempotent (same address)", (await json(ownerRes2)).address === ownerBody.address);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log("FAILURES:"); for (const f of failures) console.log(` - ${f}`); }
}

async function cleanup() {
  if (idemKeys.length) await prisma.paymentLog.deleteMany({ where: { idempotencyKey: { in: idemKeys } } }).catch(() => {});
  await prisma.paymentLog.deleteMany({ where: { reference: { startsWith: `ws-hard-replay-${RUN}` } } }).catch(() => {});
  if (agentIds.length) await prisma.x402EoaWallet.deleteMany({ where: { agentRegistryId: { in: agentIds } } }).catch(() => {});
  if (agentIds.length) await prisma.agentRegistry.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
  if (emails.length) await prisma.consumerEmailOtp.deleteMany({ where: { email: { in: emails } } }).catch(() => {});
  if (wallets.length) await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: wallets } } }).catch(() => {});
  if (merchantEmails.length) await prisma.merchant.deleteMany({ where: { email: { in: merchantEmails } } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
}

main().then(cleanup).then(() => process.exit(failed ? 1 : 0)).catch(async (e) => {
  console.error("FATAL", e);
  await cleanup();
  process.exit(1);
});
