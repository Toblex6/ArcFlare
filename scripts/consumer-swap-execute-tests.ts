// scripts/consumer-swap-execute-tests.ts
//
// Prompt-2 consumer feature restoration verification: the single feature
// signing rule + server-executed CIRCLE swap + canonical-resolver adoption
// across send/scheduled/bridge.
//
// Static source proofs + pure unit checks + live negative-path route probes
// (throwaway fixtures with cleanup, NO chain writes, NO Circle calls — every
// probe fails before any broadcast step). Run:
//   npx tsx scripts/consumer-swap-execute-tests.ts
// No dev server required.
//
// Covers:
//   signing rule (consumerWallet.ts): requireServerSigning + ConsumerFeatureError,
//     CIRCLE-bound -> binding, EXTERNAL -> 409 browser code, CIRCLE-unbound ->
//     400 recoverable, null/legacy -> 403 fail-closed, no walletSetId.
//   swap execute route: canonical resolver, step-up consumer.swap, EXTERNAL
//     409 with browser-flow pointer, no router/pool/calldata in responses.
//   serverExecute lib: envelope callData reuse, live rebinding, sequential
//     submission, service.ts stays sign-free.
//   browser swap path preserved (quote/execute-intent/verify/unwrap/verify-unwrap).
//   settle Path B: canonical resolver, no walletType string checks, typed errors.
//   scheduled create: canonical resolver, no walletType string checks, 400 unbound.
//   scheduled run: execution-time consumer revalidation.
//   cctp transfer: pinned foundation strings intact + canonical + unbound branch.
//   session route: mode/canServerSign exposure (recoverable state).
//   retired 410s intact (challenge/save/circle).

import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: ".env.local" });

import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { issueConsumerSessionToken } from "@/lib/auth/consumerSession";
import { POST as swapExecutePOST } from "@/app/api/swap/execute/route";
import { GET as sessionCheckGET } from "@/app/api/consumer/session/route";

const prisma = new PrismaClient() as any;
let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} — ${detail}`); }
}

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const RUN = Date.now().toString(36);
const XFF = (t: string) => `sw-exec-${t}-${RUN}`;
const wallets: string[] = [];
const mkWallet = () => {
  const w = ethers.Wallet.createRandom().address;
  wallets.push(w);
  return w;
};
function mkReq(url: string, opts: { method?: string; token?: string; body?: unknown; xff: string }): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.xff,
  };
  if (opts.token) headers.cookie = `consumer_token=${opts.token}`;
  return new NextRequest(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  } as any);
}
const json = async (res: any) => { try { return await res.json(); } catch { return {}; } };

async function main() {
  console.log("[0] environment");
  ok("DATABASE_URL present", !!process.env.DATABASE_URL);
  ok("CONSUMER_JWT_SECRET configured", (process.env.CONSUMER_JWT_SECRET ?? "").length >= 32);

  console.log("[1] single feature signing rule (static)");
  const resolver = read("src/lib/auth/consumerWallet.ts");
  ok("requireServerSigning exported", resolver.includes("export function requireServerSigning"), "missing");
  ok("ConsumerFeatureError exported", resolver.includes("export class ConsumerFeatureError"), "missing");
  ok("EXTERNAL browser code", resolver.includes("EXTERNAL_REQUIRES_BROWSER_SIGNATURE"), "missing");
  ok("unbound CIRCLE code", resolver.includes("CIRCLE_WALLET_UNBOUND"), "missing");
  ok("unsupported code", resolver.includes("WALLET_UNSUPPORTED"), "missing");
  ok("no walletSetId in resolver", !/walletSetId/.test(resolver), "present");
  ok("no UC auth primitives", !/userToken|encryptionKey|circleAuth/.test(resolver), "present");
  ok("resolveConsumerWallet still exported", resolver.includes("export function resolveConsumerWallet"), "missing");
  ok("getAuthenticatedConsumer still exported", resolver.includes("export async function getAuthenticatedConsumer"), "missing");

  console.log("[2] signing rule (pure unit)");
  const { requireServerSigning, ConsumerFeatureError, resolveConsumerWallet } = await import("@/src/lib/auth/consumerWallet");
  const bound = requireServerSigning({ mode: "CIRCLE", walletAddress: "0xabc", circleWalletId: "w_1", canServerSign: true });
  ok("CIRCLE-bound returns signing binding", bound.walletAddress === "0xabc" && bound.circleWalletId === "w_1", JSON.stringify(bound));
  try { requireServerSigning({ mode: "EXTERNAL", walletAddress: "0xabc", circleWalletId: null, canServerSign: false }); ok("EXTERNAL throws", false); }
  catch (e: any) { ok("EXTERNAL -> 409 browser code", e instanceof ConsumerFeatureError && e.status === 409 && e.code === "EXTERNAL_REQUIRES_BROWSER_SIGNATURE", `${e?.status} ${e?.code}`); }
  try { requireServerSigning({ mode: "CIRCLE", walletAddress: "0xabc", circleWalletId: null, canServerSign: false }); ok("unbound throws", false); }
  catch (e: any) { ok("CIRCLE-unbound -> 400 recoverable", e instanceof ConsumerFeatureError && e.status === 400 && e.code === "CIRCLE_WALLET_UNBOUND", `${e?.status} ${e?.code}`); }
  try { requireServerSigning(null); ok("null throws", false); }
  catch (e: any) { ok("null -> 403 fail-closed", e instanceof ConsumerFeatureError && e.status === 403 && e.code === "WALLET_UNSUPPORTED", `${e?.status} ${e?.code}`); }
  ok("legacy USER_CONTROLLED still resolves null", resolveConsumerWallet({ walletAddress: "0xabc", walletType: "USER_CONTROLLED" }) === null, "not fail-closed");

  console.log("[3] swap execute route (static)");
  const execRoute = read("src/app/api/swap/execute/route.ts");
  ok("execute route exists", true);
  ok("uses canonical session+wallet", execRoute.includes("getAuthenticatedConsumer") && execRoute.includes("requireServerSigning"), "missing");
  ok("no walletType string checks", !/walletType\s*===?/.test(execRoute), "scattered check present");
  ok("step-up consumer.swap", execRoute.includes("requireConsumerStepUp(") && execRoute.includes("consumer.swap"), "missing");
  ok("EXTERNAL 409 points at browser flow", execRoute.includes("EXTERNAL_REQUIRES_BROWSER_SIGNATURE") && execRoute.includes("/api/swap/execute-intent"), "missing");
  ok("legacy 403 WALLET_UNSUPPORTED", execRoute.includes("WALLET_UNSUPPORTED"), "missing");
  ok("ownership proof kept", execRoute.includes("verifyCallerControlsAddress"), "missing");
  ok("no router/pool/calldata in responses", !/deploymentRouter|poolAddress|callData|deploymentName|feeTier/.test(execRoute), "internals leak");
  ok("no Tower execution", !/tower/i.test(execRoute), "tower referenced");
  ok("SwapServerExecuteSchema validated", execRoute.includes("SwapServerExecuteSchema"), "missing");
  const stepUpSrc = read("src/lib/auth/consumerStepUp.ts");
  ok("consumer.swap action registered", stepUpSrc.includes('"consumer.swap"'), "missing");

  console.log("[4] serverExecute lib (static)");
  const serverExec = read("src/lib/swap/serverExecute.ts");
  ok("serverExecute module exists", true);
  ok("reuses envelope callData bytes", serverExec.includes("callData: step.data") || serverExec.includes("callData: envelope"), "not byte-bound");
  ok("rebinds executionIdentity to stored row", serverExec.includes("executionIdentity") && serverExec.includes("executionIdentity).toLowerCase()"), "no binding");
  ok("rebinds pool/fee/quotes", serverExec.includes("row.poolAddress") && serverExec.includes("row.feeTier"), "no term check");
  ok("sequential submission (awaited finality)", serverExec.includes("waitForCircleTxHash") && serverExec.includes("for (let i = 0"), "not sequential");
  ok("wrap carries native via Circle amount", serverExec.includes("nativeAmount") && serverExec.includes("formatUnits"), "no value path");
  ok("swap step asserts zero value", serverExec.includes("swapTx.value !== 0n"), "no guard");
  ok("registers then verifies (no broadcast-alone success)", serverExec.includes("registerFlowSwapExecution") && serverExec.includes("verifyFlowSwap"), "missing");
  ok("USDC-output unwrap exit preserved", serverExec.includes("requestFlowUnwrap") && serverExec.includes("verifyFlowUnwrap"), "missing");
  ok("UnitFlow-only (no tower import)", !/tower/i.test(serverExec), "tower referenced");
  ok("no wallet-set provisioning", !/walletSetId|ensureWalletOnChain/.test(serverExec), "present");
  const svc = read("src/lib/swap/service.ts");
  ok("shared service still never signs", !/createWalletClient|sendTransaction|writeContract/.test(svc), "signing leaked into service");

  console.log("[5] browser swap path preserved (static)");
  for (const f of [
    "src/app/api/swap/quote/route.ts",
    "src/app/api/swap/execute-intent/route.ts",
    "src/app/api/swap/verify/route.ts",
    "src/app/api/swap/unwrap/route.ts",
    "src/app/api/swap/verify-unwrap/route.ts",
  ]) {
    ok(`${f} exists`, fs.existsSync(path.join(ROOT, f)), "missing");
  }
  const flowView = read("src/components/swap/FlowSwapView.tsx");
  ok("browser flow still chains execute-intent/verify", flowView.includes("/api/swap/execute-intent") && flowView.includes("/api/swap/verify"), "changed");

  console.log("[6] send path — settle (static)");
  const settle = read("src/app/api/payments/settle/route.ts");
  ok("settle uses canonical resolver", settle.includes("resolveConsumerWallet(consumerAccount)"), "missing");
  ok("no walletType string checks in settle", !/walletType\s*===?/.test(settle), "scattered check present");
  ok("EXTERNAL browser guidance + verify-onchain pointer", settle.includes("EXTERNAL_REQUIRES_BROWSER_SIGNATURE") && settle.includes("/api/payments/verify-onchain"), "missing");
  ok("unbound CIRCLE fail-closed", settle.includes("CIRCLE_WALLET_UNBOUND"), "missing");
  ok("legacy fail-closed", settle.includes("WALLET_UNSUPPORTED"), "missing");
  ok("typed errors mapped to 4xx", settle.includes("error instanceof ConsumerFeatureError"), "missing");

  console.log("[7] save path — scheduled create/run (static)");
  const sched = read("src/app/api/payments/scheduled/route.ts");
  ok("scheduled create uses canonical resolver", sched.includes("resolveConsumerWallet(consumerAccount)"), "missing");
  ok("no walletType string checks in scheduled", !/walletType\s*===?/.test(sched), "scattered check present");
  ok("EXTERNAL refused with code", sched.includes("EXTERNAL_WALLET"), "missing");
  ok("unbound 400 recoverable", sched.includes("CIRCLE_WALLET_UNBOUND"), "missing");
  ok("legacy 403 fail-closed", sched.includes("WALLET_UNSUPPORTED"), "missing");
  const run = read("src/app/api/payments/scheduled/run/route.ts");
  ok("runner revalidates consumer binding", run.includes("resolveConsumerWallet(payerAccount)"), "missing");
  ok("runner rejects binding drift", run.includes("binding changed since creation"), "missing");
  ok("runner still fails closed on null wallet", run.includes("payerWalletId is null"), "missing");

  console.log("[8] bridge path — cctp transfer (static)");
  const transfer = read("src/app/api/cctp/transfer/route.ts");
  ok("transfer uses canonical resolver", transfer.includes("resolveConsumerWallet(account)"), "missing");
  ok("transfer keeps server-signed bridge", transfer.includes("startBridge({") && transfer.includes("bridgeEnabled(model)"), "bridge broken");
  ok("transfer keeps EXTERNAL_WALLET code", transfer.includes("EXTERNAL_WALLET"), "code changed");
  ok("transfer keeps BRIDGE_SOURCE_UNSUPPORTED", transfer.includes("BRIDGE_SOURCE_UNSUPPORTED"), "rule changed");
  ok("transfer keeps step-up + recipient validation", transfer.includes("requireConsumerStepUp") && transfer.includes("Recipient must be a valid 0x address"), "guards changed");
  ok("transfer adds unbound branch", transfer.includes("CIRCLE_WALLET_UNBOUND"), "missing");
  ok("transfer adds legacy 403", transfer.includes("WALLET_UNSUPPORTED"), "missing");
  ok("no wallet-set provisioning", !/ensureWalletOnChain|walletSetId/.test(transfer), "present");
  ok("no UC remnants", !/user-controlled-challenge|userToken|userBridge/.test(transfer), "present");

  console.log("[9] session recoverable state (static)");
  const session = read("src/app/api/consumer/session/route.ts");
  ok("session exposes mode/canServerSign", session.includes("canServerSign") && session.includes("mode: wallet?.mode"), "missing");
  ok("session has no step-up import", !session.includes("consumerStepUp"), "gated creation");

  console.log("[10] retired 410s intact (static)");
  ok("bridge challenge still 410", read("src/app/api/cctp/transfer/challenge/route.ts").includes("BRIDGE_CHALLENGE_RETIRED"), "changed");
  ok("save challenge still 410", read("src/app/api/consumer/save/challenge/route.ts").includes("SAVE_CHALLENGE_RETIRED"), "changed");
  ok("save confirm still 410", read("src/app/api/consumer/save/confirm/route.ts").includes("SAVE_CONFIRM_RETIRED"), "changed");
  ok("circle proxy still 410", read("src/app/api/consumer/circle/route.ts").includes("CIRCLE_USER_CONTROLLED_RETIRED"), "changed");

  console.log("[11] schema (pure unit)");
  const { SwapServerExecuteSchema } = await import("@/src/lib/validation");
  ok("execute schema rejects empty locator", !SwapServerExecuteSchema.safeParse({}).success, "accepted");
  ok("execute schema accepts intentId", SwapServerExecuteSchema.safeParse({ intentId: "123e4567-e89b-12d3-a456-426614174000" }).success, "rejected");
  ok("execute schema accepts quoteHash", SwapServerExecuteSchema.safeParse({ quoteHash: `0x${"a".repeat(64)}` }).success, "rejected");

  // ── Live negative-path probes (fixtures + cleanup, no chain, no Circle) ──
  console.log("[12] live route probes (fail-closed, no funds)");
  const wExt = mkWallet();
  const wUnbound = mkWallet();
  const aExt = await prisma.consumerAccount.create({ data: { walletAddress: wExt, walletType: "EXTERNAL", onboardingSource: "web" } });
  const aUnbound = await prisma.consumerAccount.create({ data: { walletAddress: wUnbound, walletType: "CIRCLE", onboardingSource: "web" } });
  const tExt = await issueConsumerSessionToken(aExt.id, wExt);
  const tUnbound = await issueConsumerSessionToken(aUnbound.id, wUnbound);
  try {
    const rNoSession = await swapExecutePOST(mkReq("http://t/api/swap/execute", { method: "POST", body: { intentId: "123e4567-e89b-12d3-a456-426614174000" }, xff: XFF("nosess") }) as any);
    ok("no session -> 401", rNoSession.status === 401, `status=${rNoSession.status}`);

    const rExt = await swapExecutePOST(mkReq("http://t/api/swap/execute", { method: "POST", token: tExt, body: { intentId: "123e4567-e89b-12d3-a456-426614174000" }, xff: XFF("ext") }) as any);
    const bExt = await json(rExt);
    ok("EXTERNAL -> 409 browser code (nothing broadcast)", rExt.status === 409 && bExt.code === "EXTERNAL_REQUIRES_BROWSER_SIGNATURE", `${rExt.status} ${bExt.code}`);

    const rUnbound = await swapExecutePOST(mkReq("http://t/api/swap/execute", { method: "POST", token: tUnbound, body: { intentId: "123e4567-e89b-12d3-a456-426614174000" }, xff: XFF("unbound") }) as any);
    const bUnbound = await json(rUnbound);
    ok("CIRCLE-unbound -> 400 recoverable", rUnbound.status === 400 && bUnbound.code === "CIRCLE_WALLET_UNBOUND", `${rUnbound.status} ${bUnbound.code}`);

    const rBadBody = await swapExecutePOST(mkReq("http://t/api/swap/execute", { method: "POST", token: tExt, body: {}, xff: XFF("badbody") }) as any);
    ok("empty locator rejected (validation)", rBadBody.status === 400, `status=${rBadBody.status}`);

    // Session exposes the recoverable state for both fixture shapes.
    const sExt = await json(await sessionCheckGET(mkReq("http://t/api/consumer/session", { token: tExt, xff: XFF("sessext") }) as any));
    ok("session: EXTERNAL view", sExt?.account?.mode === "EXTERNAL" && sExt?.account?.canServerSign === false, JSON.stringify(sExt?.account));
    const sUnbound = await json(await sessionCheckGET(mkReq("http://t/api/consumer/session", { token: tUnbound, xff: XFF("sessunb") }) as any));
    ok("session: CIRCLE-unbound view", sUnbound?.account?.mode === "CIRCLE" && sUnbound?.account?.canServerSign === false, JSON.stringify(sUnbound?.account));
  } finally {
    await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: wallets } } }).catch(() => {});
  }
  const leftover = await prisma.consumerAccount.findMany({ where: { walletAddress: { in: wallets } } }).catch(() => []);
  ok("fixtures cleaned up", leftover.length === 0, `${leftover.length} rows left`);

  console.log("[13] relayed verifier (pure matrix, no RPC)");
  await relayedMatrix();

  console.log(`\nconsumer-swap-execute-tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log("failures:", failures); process.exit(1); }
}

async function relayedMatrix() {
  const {
    extractRelayedInner,
    proveRelayedSwapLogs,
    proveRelayedWrapLogs,
    proveRelayedUnwrapLogs,
    isDirectSubmissionShape,
  } = await import("@/src/lib/swap/relayedVerify");
  const { encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, toHex } = await import("viem");
  const { UNITFLOW_V3_ROUTER_ABI } = await import("@/src/lib/routing/providers/unitflowV3");

  const USER = "0x1111111111111111111111111111111111111111";
  const ROUTER = "0xEaF3195bE51861632cd32850973C9515DA48e76F";
  const POOL = "0xe8f7fA2A412e98C537554643F83DA34DfdD50c23";
  const WUSDC = "0x911b4000D3422F482F4062a913885f7b035382Df";
  const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
  const AMT_IN = 10_000_000_000_000_000n;
  const MIN_OUT = 6_187n;
  const ACT_OUT = 7_259n;
  const DEADLINE = 1_800_000_000n;

  const path = encodePacked(["address", "uint24", "address"], [WUSDC as `0x${string}`, 100, EURC as `0x${string}`]);
  const v3input = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
    [USER as `0x${string}`, AMT_IN, MIN_OUT, path, true]
  );
  const inner = encodeFunctionData({
    abi: UNITFLOW_V3_ROUTER_ABI, functionName: "execute", args: ["0x00" as `0x${string}`, [v3input], DEADLINE],
  });
  const accountCall =
    "0xb61d27f6" +
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [ROUTER as `0x${string}`, 0n, inner]
    ).slice(2);
  const blob =
    `0x${USER.slice(2).padStart(64, "0")}${accountCall.slice(2)}${"ab".repeat(65)}`;
  const outer =
    `0x765e827f${encodeAbiParameters([{ type: "bytes" }], [blob as `0x${string}`]).slice(2)}`;

  const throwCase = (label: string, fn: () => unknown, needle: string) => {
    try { fn(); ok(label, false, "did NOT throw"); }
    catch (e: any) {
      ok(label, String(e?.message ?? e).includes(needle), `got: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  };

  // extraction happy path
  const ex = extractRelayedInner(outer, ROUTER, USER);
  ok("extraction finds bound inner call", ex.target.toLowerCase() === ROUTER.toLowerCase() && ex.value === 0n && ex.innerData.toLowerCase() === inner.toLowerCase(), ex.target);
  // extraction negatives
  throwCase("non-envelope input rejected", () => extractRelayedInner(inner, ROUTER, USER), "not a recognized relay envelope");
  throwCase("truncated envelope rejected", () => extractRelayedInner("0x765e827f1234", ROUTER, USER), "truncated");
  throwCase("wrong SCA rejected", () => extractRelayedInner(outer, ROUTER, "0x2222222222222222222222222222222222222222"), "does not address");
  throwCase("foreign target rejected", () => extractRelayedInner(outer, POOL, USER), "exactly one inner call");
  throwCase("non-hex rejected", () => extractRelayedInner("nope", ROUTER, USER), "not hex");
  ok("direct shape detected", isDirectSubmissionShape(ROUTER, inner, ROUTER) === true, "");
  ok("relay shape not direct", isDirectSubmissionShape("0x0000000071727de22e5e9d8baf0edac6f37da032", outer, ROUTER) === false, "");
  ok("foreign router not direct", isDirectSubmissionShape("0x0000000000000000000000000000000000000001", inner, ROUTER) === false, "");

  const padTopic = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
  const transferLog = (token: string, from: string, to: string, value: bigint) => ({
    address: token,
    topics: [keccak256(toHex("Transfer(address,address,uint256)")), padTopic(from), padTopic(to)],
    data: `0x${value.toString(16).padStart(64, "0")}`,
  });
  // token0 = EURC (output), token1 = WUSDC (input): amount0 = -out, amount1 = +in.
  const swapData = encodeAbiParameters(
    [{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }],
    [-ACT_OUT, AMT_IN, 1000n, 1000n, 1]
  );
  const swapLog = {
    address: POOL,
    topics: [keccak256(toHex("Swap(address,address,int256,int256,uint160,uint128,int24)")), padTopic(ROUTER), padTopic(USER)],
    data: swapData,
  };
  const swapExp = {
    pool: POOL, router: ROUTER, ownerWallet: USER,
    tokenInSwap: WUSDC, tokenOutSwap: EURC,
    amountInSwap: AMT_IN, minOutSwap: MIN_OUT, token0IsInput: false,
  };
  const swapLogs = [swapLog, transferLog(WUSDC, USER, POOL, AMT_IN), transferLog(EURC, POOL, USER, ACT_OUT)];
  const proven = proveRelayedSwapLogs(swapLogs, swapExp);
  ok("swap log proof happy path", proven.actualInputSwap === AMT_IN && proven.actualOutputSwap === ACT_OUT, "");
  throwCase("missing Swap log rejected", () => proveRelayedSwapLogs(swapLogs.slice(1), swapExp), "Swap proof failed");
  throwCase("foreign router Swap rejected", () =>
    proveRelayedSwapLogs([{ ...swapLog, topics: [swapLog.topics[0]!, padTopic(POOL), padTopic(USER)] }, ...swapLogs.slice(1)], swapExp),
    "not the bound router");
  throwCase("wrong recipient Swap rejected", () =>
    proveRelayedSwapLogs([{ ...swapLog, topics: [swapLog.topics[0]!, padTopic(ROUTER), padTopic(POOL)] }, ...swapLogs.slice(1)], swapExp),
    "exactly one Swap");
  throwCase("input amount tamper rejected", () =>
    proveRelayedSwapLogs([swapLog, transferLog(WUSDC, USER, POOL, AMT_IN - 1n), transferLog(EURC, POOL, USER, ACT_OUT)], swapExp),
    "input-leg proof failed");
  throwCase("minOut shortfall rejected", () =>
    proveRelayedSwapLogs([swapLog, transferLog(WUSDC, USER, POOL, AMT_IN), transferLog(EURC, POOL, USER, MIN_OUT - 1n)], swapExp),
    "Transfer amount != Swap output");
  throwCase("missing output leg rejected", () => proveRelayedSwapLogs(swapLogs.slice(0, 2), swapExp), "output-leg proof failed");
  throwCase("duplicate Swap rejected", () => proveRelayedSwapLogs([swapLog, swapLog, ...swapLogs.slice(1)], swapExp), "exactly one Swap");

  const depositLog = {
    address: WUSDC,
    topics: [keccak256(toHex("Deposit(address,uint256)")), padTopic(USER)],
    data: `0x${AMT_IN.toString(16).padStart(64, "0")}`,
  };
  proveRelayedWrapLogs([depositLog], { wusdc: WUSDC, ownerWallet: USER, amountInSwap: AMT_IN });
  ok("wrap Deposit proof happy path", true, "");
  throwCase("wrong wad Deposit rejected", () =>
    proveRelayedWrapLogs([{ ...depositLog, data: `0x${(AMT_IN - 1n).toString(16).padStart(64, "0")}` }], { wusdc: WUSDC, ownerWallet: USER, amountInSwap: AMT_IN }),
    "minted amount");
  throwCase("foreign Deposit rejected", () =>
    proveRelayedWrapLogs([{ ...depositLog, address: EURC }], { wusdc: WUSDC, ownerWallet: USER, amountInSwap: AMT_IN }),
    "exactly one WUSDC Deposit");

  const WAD = 7_259_000_000_000_000n;
  const burnLog = {
    address: WUSDC,
    topics: [keccak256(toHex("Withdrawal(address,uint256)")), padTopic(USER)],
    data: `0x${WAD.toString(16).padStart(64, "0")}`,
  };
  proveRelayedUnwrapLogs([burnLog], { wusdc: WUSDC, ownerWallet: USER, wad: WAD });
  ok("unwrap Withdrawal proof happy path", true, "");
  throwCase("wrong wad Withdrawal rejected", () =>
    proveRelayedUnwrapLogs([{ ...burnLog, data: `0x${(WAD - 1n).toString(16).padStart(64, "0")}` }], { wusdc: WUSDC, ownerWallet: USER, wad: WAD }),
    "burned amount");
  throwCase("foreign Withdrawal rejected", () =>
    proveRelayedUnwrapLogs([{ ...burnLog, address: EURC }], { wusdc: WUSDC, ownerWallet: USER, wad: WAD }),
    "exactly one WUSDC Withdrawal");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
