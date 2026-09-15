// scripts/consumer-external-bridge-tests.ts
//
// Prompt-2 negative-path verification (no funds, no chain writes): EXTERNAL
// consumers fail clearly on server-only operations, and the bridge network
// rules refuse explicitly.
//
//   EXTERNAL send    -> POST /api/payments/settle returns 409
//                      EXTERNAL_REQUIRES_BROWSER_SIGNATURE with a
//                      verify-onchain pointer (nothing broadcast).
//   EXTERNAL bridge  -> POST /api/cctp/transfer returns 400 EXTERNAL_WALLET.
//   CIRCLE bridge    -> Sepolia source returns 400 BRIDGE_SOURCE_UNSUPPORTED
//                      (Arc-only provisioning, explicit refusal).
//   cctp balance     -> EXTERNAL returns the EXTERNAL_WALLET code.
//   save challenge/confirm + bridge challenge + circle proxy -> still 410.
//
// Throwaway EXTERNAL fixture with cleanup. For the CIRCLE bridge probe the
// session maps to a throwaway CIRCLE row (unbound or bound — the source check
// runs after the binding checks, so an unbound row probes CIRCLE_WALLET_UNBOUND
// instead; both are asserted where reachable).
// Run: npx tsx scripts/consumer-external-bridge-tests.ts

import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: ".env.local" });

import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import { NextRequest } from "next/server";
import { issueConsumerSessionToken } from "@/lib/auth/consumerSession";
import { POST as initializePOST } from "@/app/api/payments/initialize/route";
import { POST as settlePOST } from "@/app/api/payments/settle/route";
import { POST as bridgePOST } from "@/app/api/cctp/transfer/route";
import { GET as bridgeBalanceGET } from "@/app/api/cctp/transfer/balance/route";
import { POST as saveChallengePOST } from "@/app/api/consumer/save/challenge/route";
import { POST as saveConfirmPOST } from "@/app/api/consumer/save/confirm/route";
import { POST as bridgeChallengePOST } from "@/app/api/cctp/transfer/challenge/route";

const prisma = new PrismaClient() as any;
let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
}
const RUN = Date.now().toString(36);
const XFF = (t: string) => `ext-bridge-${t}-${RUN}`;
const wallets: string[] = [];
const mkWallet = () => { const w = ethers.Wallet.createRandom().address; wallets.push(w); return w; };
function mkReq(url: string, opts: { method?: string; token?: string; body?: unknown; xff: string }): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": opts.xff };
  if (opts.token) headers.cookie = `consumer_token=${opts.token}`;
  return new NextRequest(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined } as any);
}
const json = async (res: any) => { try { return await res.json(); } catch { return {}; } };

async function main() {
  const wExt = mkWallet();
  const wCircle = mkWallet();
  const aExt = await prisma.consumerAccount.create({ data: { walletAddress: wExt, walletType: "EXTERNAL", onboardingSource: "web" } });
  const aCircle = await prisma.consumerAccount.create({ data: { walletAddress: wCircle, walletType: "CIRCLE", circleWalletId: `ext-bridge-${RUN}`, onboardingSource: "web" } });
  const tExt = await issueConsumerSessionToken(aExt.id, wExt);
  const tCircle = await issueConsumerSessionToken(aCircle.id, wCircle);
  const refs: string[] = [];
  try {
    // EXTERNAL send: initialize ok, settle refuses with browser guidance.
    const initRes = await initializePOST(mkReq("http://t/api/payments/initialize", {
      method: "POST", token: tExt,
      body: { amount: "1", currency: "USDC", payoutAddress: mkWallet(), merchant: "probe", direction: "send" },
      xff: XFF("init"),
    }) as any);
    const initBody = await json(initRes);
    ok("EXTERNAL send initializes an invoice", initRes.status === 200 && !!initBody.reference, `status=${initRes.status}`);
    if (initBody.reference) {
      refs.push(initBody.reference);
      const settleRes = await settlePOST(mkReq("http://t/api/payments/settle", {
        method: "POST", token: tExt, body: { reference: initBody.reference }, xff: XFF("settle"),
      }) as any);
      const settleBody = await json(settleRes);
      ok("EXTERNAL settle -> 409 browser code (nothing broadcast)",
        settleRes.status === 409 && settleBody.code === "EXTERNAL_REQUIRES_BROWSER_SIGNATURE" &&
        JSON.stringify(settleBody).includes("/api/payments/verify-onchain"),
        `status=${settleRes.status} code=${settleBody.code}`);
      const row = await prisma.paymentLog.findUnique({ where: { reference: initBody.reference } });
      ok("no success claimed for EXTERNAL settle", row?.status !== "SUCCESS" && !row?.arcTxHash, `status=${row?.status}`);
    }

    // EXTERNAL bridge + balance.
    const bExt = await json(await bridgePOST(mkReq("http://t/api/cctp/transfer", {
      method: "POST", token: tExt,
      body: { fromChain: "Base_Sepolia", toChain: "Arc_Testnet", amount: "1", recipient: wExt },
      xff: XFF("bext"),
    }) as any));
    ok("EXTERNAL bridge -> EXTERNAL_WALLET", bExt.code === "EXTERNAL_WALLET", `code=${bExt.code}`);
    const balExt = await json(await bridgeBalanceGET(mkReq(`http://t/api/cctp/transfer/balance?fromChain=Base_Sepolia`, { token: tExt, xff: XFF("balext") }) as any));
    ok("EXTERNAL balance -> EXTERNAL_WALLET code", balExt.code === "EXTERNAL_WALLET", `code=${balExt.code}`);

    // CIRCLE bridge network rule: non-Arc source refused explicitly.
    const bCircle = await bridgePOST(mkReq("http://t/api/cctp/transfer", {
      method: "POST", token: tCircle,
      body: { fromChain: "Base_Sepolia", toChain: "Arc_Testnet", amount: "1", recipient: wCircle },
      xff: XFF("bcircle"),
    }) as any);
    const bCircleBody = await json(bCircle);
    ok("CIRCLE non-Arc source -> BRIDGE_SOURCE_UNSUPPORTED",
      bCircle.status === 400 && bCircleBody.code === "BRIDGE_SOURCE_UNSUPPORTED",
      `status=${bCircle.status} code=${bCircleBody.code}`);
    const bBadSource = await json(await bridgePOST(mkReq("http://t/api/cctp/transfer", {
      method: "POST", token: tCircle,
      body: { fromChain: "Nope_Chain", toChain: "Arc_Testnet", amount: "1", recipient: wCircle },
      xff: XFF("bbad"),
    }) as any));
    ok("unknown source chain rejected", String(bBadSource.error ?? "").includes("Unsupported source chain"), JSON.stringify(bBadSource).slice(0, 100));

    // Retired UC ceremony still 410.
    ok("save challenge still 410", (await saveChallengePOST()).status === 410, "");
    ok("save confirm still 410", (await saveConfirmPOST()).status === 410, "");
    ok("bridge challenge still 410", (await bridgeChallengePOST()).status === 410, "");
  } finally {
    if (refs.length) await prisma.paymentLog.deleteMany({ where: { reference: { in: refs } } }).catch(() => {});
    await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: wallets } } }).catch(() => {});
  }
  const leftover = await prisma.consumerAccount.findMany({ where: { walletAddress: { in: wallets } } }).catch(() => []);
  ok("fixtures cleaned up", leftover.length === 0, `${leftover.length} left`);
  console.log(`\nconsumer-external-bridge-tests: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}
main().catch(async (e) => { console.error("FATAL", e?.message ?? e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
