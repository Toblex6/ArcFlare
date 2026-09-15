// scripts/consumer-money-e2e.ts
//
// Prompt-2 LIVE verification: real CIRCLE consumer money movement on Arc
// Testnet (chain 5042002). Throwaway resources only, tiny amounts, full
// cleanup — nothing here touches existing users, merchants, agents, or
// production schedules.
//
// Flow:
//   1. Provision a throwaway Circle SCA + ConsumerAccount (CIRCLE, bound) + session.
//   2. Fund 0.10 USDC (native) from RELAYER_PRIVATE_KEY (controlled test wallet).
//   3. SEND: initialize (direction=send) + settle 0.01 USDC -> relayer.
//      Assert SUCCESS + arcTxHash.
//   4. SCHEDULED SAVE: create + run a 0.01 USDC -> relayer schedule (maxRuns 1).
//      Assert COMPLETED + txHash.
//   5. SWAP: quote + server-execute 0.01 USDC -> EURC (no unwrap leg).
//      Assert EXECUTED + verified actuals.
//   6. Best-effort sweep of remaining native back to the relayer.
//   7. Delete every throwaway row (account, payments, schedule, intent).
//
// Any step may be skipped cleanly when the environment cannot support it
// (no relayer funds, RPC down, Circle rejects) — the script reports exactly
// what ran on-chain vs what did not, and always cleans up.
//
// Run: ROUTING_PROVIDER_UNITFLOW_V3_ENABLED=1 npx tsx scripts/consumer-money-e2e.ts

process.env.ROUTING_PROVIDER_UNITFLOW_V3_ENABLED =
  process.env.ROUTING_PROVIDER_UNITFLOW_V3_ENABLED ?? "1";

import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: ".env.local" });

import { PrismaClient } from "@prisma/client";
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getArcChain, getNetworkConfig, explorerTxUrl } from "@/lib/config/network";
import { getTokenBySymbol } from "@/src/lib/tokens/supportedTokens";
import { createAccountWallet, getWalletBalance } from "@/src/lib/circle/client";
import { transferUsdc } from "@/src/lib/circle/transfers";
import { issueConsumerSessionToken } from "@/lib/auth/consumerSession";
import { POST as initializePOST } from "@/app/api/payments/initialize/route";
import { POST as settlePOST } from "@/app/api/payments/settle/route";
import { POST as scheduledPOST } from "@/app/api/payments/scheduled/route";
import { POST as scheduledRunPOST } from "@/app/api/payments/scheduled/run/route";
import { POST as swapQuotePOST } from "@/app/api/swap/quote/route";
import { POST as swapExecutePOST } from "@/app/api/swap/execute/route";
import { NextRequest } from "next/server";

const prisma = new PrismaClient() as any;
const RUN = Date.now().toString(36);
const XFF = (t: string) => `money-e2e-${t}-${RUN}`;
const FUND_AMOUNT = "0.06";
const OP_AMOUNT = "0.01";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
}

function mkReq(url: string, opts: { method?: string; token?: string; apiKey?: string; body?: unknown; xff: string }): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.xff,
  };
  if (opts.token) headers.cookie = `consumer_token=${opts.token}`;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  return new NextRequest(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  } as any);
}
const json = async (res: any) => { try { return await res.json(); } catch { return {}; } };

async function main() {
  const relayerKey = (process.env.RELAYER_PRIVATE_KEY ?? "").trim() as `0x${string}`;
  const internalKey = (process.env.INTERNAL_SETTLEMENT_API_KEY ?? "").trim();
  if (!relayerKey || !internalKey || !process.env.DATABASE_URL || !process.env.CIRCLE_API_KEY) {
    console.log("SKIP: RELAYER_PRIVATE_KEY / INTERNAL_SETTLEMENT_API_KEY / DATABASE_URL / CIRCLE_API_KEY required.");
    process.exit(2);
  }
  const relayer = privateKeyToAccount(relayerKey);
  const chain = getArcChain();
  const rpc = getNetworkConfig().primaryRpc;
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const relayerClient = createWalletClient({ account: relayer, chain, transport: http(rpc) });

  const relayerBal: bigint = await publicClient.getBalance({ address: relayer.address }).catch(() => 0n);
  console.log(`relayer ${relayer.address} native balance: ${formatUnits(relayerBal, 18)}`);
  if (relayerBal < parseUnits("0.08", 18)) {
    console.log("SKIP: relayer underfunded for the 0.06 funding leg.");
    process.exit(2);
  }

  // ── 1. Throwaway wallet + account + session ──
  const created = await createAccountWallet(`consumer_e2e_${RUN}`);
  const walletAddress = created.address as string;
  const circleWalletId = created.walletId as string;
  console.log(`throwaway SCA ${walletAddress} (${circleWalletId})`);
  const account = await prisma.consumerAccount.create({
    data: { walletAddress, walletType: "CIRCLE", circleWalletId, onboardingSource: "web" },
  });
  const token = await issueConsumerSessionToken(account.id, walletAddress);
  const refs: string[] = [];

  const cleanup = async () => {
    await prisma.flowSwapIntent.deleteMany({ where: { ownerWallet: walletAddress } }).catch(() => {});
    await prisma.paymentConversion.deleteMany({ where: { paymentLog: { senderEmail: walletAddress } } }).catch(() => {});
    await prisma.paymentLog.deleteMany({ where: { senderEmail: walletAddress } }).catch(() => {});
    await prisma.scheduledPayment.deleteMany({ where: { payerSCA: walletAddress } }).catch(() => {});
    await prisma.consumerAccount.deleteMany({ where: { walletAddress } }).catch(() => {});
  };

  try {
    // ── 2. Fund 0.10 native ──
    const fundHash = await relayerClient.sendTransaction({
      to: walletAddress as `0x${string}`,
      value: parseUnits(FUND_AMOUNT, 18),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
    ok(`funded throwaway wallet (${FUND_AMOUNT} native)`, true, fundHash);

    // ── 3. SEND: initialize + settle 0.01 -> relayer ──
    const initRes = await initializePOST(mkReq("http://t/api/payments/initialize", {
      method: "POST", token,
      body: { amount: OP_AMOUNT, currency: "USDC", payoutAddress: relayer.address, merchant: relayer.address, direction: "send" },
      xff: XFF("init"),
    }) as any);
    const initBody = await json(initRes);
    ok("send initialized", initRes.status === 200 && !!initBody.reference, `status=${initRes.status} ref=${initBody.reference}`);
    if (!initBody.reference) throw new Error("initialize failed — aborting live leg");
    refs.push(initBody.reference);
    const settleRes = await settlePOST(mkReq("http://t/api/payments/settle", {
      method: "POST", token, body: { reference: initBody.reference }, xff: XFF("settle"),
    }) as any);
    const settleBody = await json(settleRes);
    ok("CIRCLE send settled on-chain", settleRes.status === 200 && settleBody.success === true && !!settleBody.arcTxHash,
      `status=${settleRes.status} tx=${settleBody.arcTxHash} ${explorerTxUrl(settleBody.arcTxHash ?? "")}`);
    const settledRow = await prisma.paymentLog.findUnique({ where: { reference: initBody.reference } });
    ok("PaymentLog SUCCESS + sender/recipient intact",
      settledRow?.status === "SUCCESS" &&
      settledRow?.senderEmail?.toLowerCase() === walletAddress.toLowerCase() &&
      (settledRow?.merchantSCA?.toLowerCase() === relayer.address.toLowerCase()),
      `status=${settledRow?.status}`);

    // ── 4. SCHEDULED SAVE: create + run 0.01 -> relayer ──
    const schedRes = await scheduledPOST(mkReq("http://t/api/payments/scheduled", {
      method: "POST", token,
      body: { payerSCA: walletAddress, receiverSCA: relayer.address, amount: parseFloat(OP_AMOUNT), intervalDays: 30, maxRuns: 1, description: "e2e autosave" },
      xff: XFF("sched"),
    }) as any);
    const schedBody = await json(schedRes);
    const schedRef = schedBody?.scheduledPayment?.reference as string | undefined;
    ok("schedule created (automatic save)", schedRes.status === 200 && !!schedRef, `status=${schedRes.status} ref=${schedRef}`);
    if (!schedRef) throw new Error("schedule create failed — aborting live leg");
    const runRes = await scheduledRunPOST(mkReq("http://t/api/payments/scheduled/run", {
      method: "POST", apiKey: internalKey, body: {}, xff: XFF("run"),
    }) as any);
    const runBody = await json(runRes);
    const rowResult = (runBody?.results ?? []).find((r: any) => r.reference === schedRef);
    ok("scheduler executed the save on-chain", runRes.status === 200 && rowResult?.success === true && !!rowResult?.txHash,
      `tx=${rowResult?.txHash} ${explorerTxUrl(rowResult?.txHash ?? "")}`);
    const schedRow = await prisma.scheduledPayment.findUnique({ where: { reference: schedRef } }).catch(() => null);
    ok("schedule COMPLETED after maxRuns=1", schedRow?.status === "COMPLETED" && schedRow?.runCount === 1, `status=${schedRow?.status}`);

    // ── 5. SWAP: quote + server-execute 0.01 USDC -> EURC ──
    const quoteRes = await swapQuotePOST(mkReq("http://t/api/swap/quote", {
      method: "POST", token,
      body: { inputSymbol: "USDC", outputSymbol: "EURC", amount: OP_AMOUNT },
      xff: XFF("quote"),
    }) as any);
    const quoteBody = await json(quoteRes);
    ok("swap quoted (Tower discovery where available, UnitFlow executor)",
      quoteRes.status === 200 && !!quoteBody.intentId && quoteBody.venueId === "unitflow-v3",
      `status=${quoteRes.status} intent=${quoteBody.intentId}`);
    if (!quoteBody.intentId) throw new Error("swap quote failed — aborting live leg");
    const execRes = await swapExecutePOST(mkReq("http://t/api/swap/execute", {
      method: "POST", token, body: { intentId: quoteBody.intentId }, xff: XFF("exec"),
    }) as any);
    const execBody = await json(execRes);
    ok("CIRCLE swap executed + verified (no browser popup)",
      execRes.status === 200 && execBody.success === true && execBody.status === "EXECUTED",
      `status=${execRes.status} in=${execBody?.input?.amount} out=${execBody?.output?.actual} exec=${execBody?.executionTxHash} wrap=${execBody?.wrapTxHash}`);
    const intentRow = await prisma.flowSwapIntent.findUnique({ where: { id: quoteBody.intentId } }).catch(() => null);
    ok("intent EXECUTED with verified actuals",
      intentRow?.status === "EXECUTED" && !!intentRow?.executionTxHash && !!intentRow?.wrapTxHash,
      `status=${intentRow?.status}`);

    // ── 6. Best-effort sweep back (USDC view + EURC proceeds) ──
    const eurc = getTokenBySymbol("EURC");
    try {
      const balStr = await getWalletBalance(circleWalletId);
      const bal = parseFloat(balStr);
      if (bal > 0.006) {
        const sweep = (bal - 0.005).toFixed(6);
        const { arcTxHash } = await transferUsdc({
          walletId: circleWalletId, walletAddress,
          destinationAddress: relayer.address, amount: sweep,
        });
        ok("swept remainder to relayer", true, `${sweep} USDC tx=${arcTxHash}`);
      } else {
        ok("swept remainder to relayer", true, `dust only (${balStr}) — left in place`);
      }
    } catch (e: any) {
      ok("swept remainder to relayer", true, `best-effort failed (non-fatal): ${String(e?.message ?? e).slice(0, 120)}`);
    }
    try {
      const eurcBal = await publicClient.readContract({
        address: eurc.address as `0x${string}`,
        abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const,
        functionName: "balanceOf", args: [walletAddress as `0x${string}`],
      }).catch(() => 0n) as bigint;
      if (eurcBal > 0n) {
        const sweepEurc = Number(formatUnits(eurcBal, eurc.decimals)).toFixed(6);
        const { arcTxHash } = await transferUsdc({
          walletId: circleWalletId, walletAddress,
          destinationAddress: relayer.address, amount: sweepEurc,
          tokenAddress: eurc.address, decimals: eurc.decimals,
        });
        ok("swept EURC proceeds to relayer", true, `${sweepEurc} EURC tx=${arcTxHash}`);
      } else {
        ok("swept EURC proceeds to relayer", true, "no EURC balance");
      }
    } catch (e: any) {
      ok("swept EURC proceeds to relayer", true, `best-effort failed (non-fatal): ${String(e?.message ?? e).slice(0, 120)}`);
    }
  } finally {
    await cleanup();
  }
  const leftover = await prisma.consumerAccount.findMany({ where: { walletAddress } }).catch(() => []);
  ok("throwaway rows cleaned up", leftover.length === 0, `${leftover.length} left`);

  console.log(`\nconsumer-money-e2e: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error("FATAL", e?.message ?? e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
