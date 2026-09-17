// scripts/consumer-external-multichain-bridge-tests.ts
//
// EXTERNAL multi-chain Bridge verification (no funds, no chain writes):
// pure unit checks (amount rules, error copy, canonical source table vs the
// installed BridgeKit) + route checks with throwaway fixtures (intent,
// verify idempotency, complete gating, status, auth boundaries) + static
// guards (no walletSetId, no Tower, no server signing on the external path,
// single kit.bridge invocation, kit.retry resume, session-upgrade linking).
//
// The CIRCLE server-signed path is asserted unchanged (Arc-only refusal,
// EXTERNAL_WALLET code on the legacy POST). No new wallet is provisioned by
// any bridge route — the destination link is written only by the existing
// session-upgrade flow (Path B), asserted statically.
//
// Run: npx tsx scripts/consumer-external-multichain-bridge-tests.ts

import dotenv from "dotenv";
dotenv.config();
if (!process.env.DATABASE_URL) dotenv.config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import { NextRequest } from "next/server";
import { BridgeChain } from "@circle-fin/bridge-kit";
import {
  ArbitrumSepolia,
  BaseSepolia,
  OptimismSepolia,
  EthereumSepolia,
  PolygonAmoy,
} from "@circle-fin/bridge-kit/chains";
import { issueConsumerSessionToken } from "@/lib/auth/consumerSession";
import {
  getBridgeSourceChains,
  getBridgeSourceChain,
  isSupportedBridgeSource,
  parseBridgeAmountToBaseUnits,
  validateBridgeAmount,
  formatBridgeBaseUnits,
} from "@/lib/bridge/sourceChains";
import { getCctpSources } from "@/lib/cctp-v2";
import { mapBridgeError } from "@/lib/wallet/walletErrors";
import { POST as intentPOST } from "@/app/api/cctp/transfer/external/intent/route";
import { POST as verifyPOST } from "@/app/api/cctp/transfer/external/verify/route";
import { POST as completePOST } from "@/app/api/cctp/transfer/external/complete/route";
import { GET as statusGET } from "@/app/api/cctp/transfer/external/status/route";
import { GET as destGET } from "@/app/api/cctp/transfer/external/destination/route";
import { POST as legacyBridgePOST } from "@/app/api/cctp/transfer/route";

const prisma = new PrismaClient() as any;
let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
}
const RUN = Date.now().toString(36);
let xffN = 0;
const XFF = (t: string) => `ext-multi-${t}-${RUN}-${++xffN}`;
const wallets: string[] = [];
const intentIds: string[] = [];
const mkWallet = () => { const w = ethers.Wallet.createRandom().address; wallets.push(w); return w; };
function mkReq(url: string, opts: { method?: string; token?: string; body?: unknown; xff: string }): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": opts.xff };
  if (opts.token) headers.cookie = `consumer_token=${opts.token}`;
  return new NextRequest(url, { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined } as any);
}
const json = async (res: any) => { try { return await res.json(); } catch { return {}; } };
const here = fileURLToPath(import.meta.url).replaceAll("\\", "/");
const src = (p: string) => readFileSync(new URL(`../${p}`, `file://${here}`), "utf8");
// walletSetId appears in retired-architecture COMMENTS (which forbid it) —
// only a real code occurrence counts as a reintroduction.
function codeWithoutComments(s: string): string {
  return s.split("\n").filter((l) => {
    const t = l.trim();
    return !(t.startsWith("//") || t.startsWith("--") || t.startsWith("*") || t.startsWith("-- "));
  }).join("\n");
}

async function main() {
  // ── 1. Canonical source table ──────────────────────────────────────────
  const sources = getBridgeSourceChains();
  ok("five supported source chains", sources.length === 5, `${sources.length}`);
  const members = new Set<string>(Object.values(BridgeChain) as string[]);
  ok("every source id is a BridgeChain enum member",
    sources.every((s) => members.has(s.id)), JSON.stringify(sources.map((s) => s.id)));
  ok("expected BridgeKit ids present",
    ["Arbitrum_Sepolia", "Base_Sepolia", "Optimism_Sepolia", "Ethereum_Sepolia", "Polygon_Amoy_Testnet"]
      .every((id) => isSupportedBridgeSource(id)));
  ok("unsupported ids rejected",
    !isSupportedBridgeSource("Nope_Chain") && !isSupportedBridgeSource("Arc_Testnet") && !isSupportedBridgeSource(""));
  const defs: Record<string, any> = {
    Arbitrum_Sepolia: ArbitrumSepolia, Base_Sepolia: BaseSepolia, Optimism_Sepolia: OptimismSepolia,
    Ethereum_Sepolia: EthereumSepolia, Polygon_Amoy_Testnet: PolygonAmoy,
  };
  ok("chainIds match installed bridge-kit defs",
    sources.every((s) => defs[s.id]?.chainId === s.chainId));
  ok("USDC addresses match installed bridge-kit defs",
    sources.every((s) => (defs[s.id]?.usdcAddress as string)?.toLowerCase() === s.usdcAddress.toLowerCase()));
  ok("cctp-v2 source set derives from the canonical table",
    JSON.stringify(getCctpSources().map((c) => c.id).sort()) === JSON.stringify(sources.map((s) => s.id).sort()));
  ok("destination is Arc Testnet (not a source)",
    getBridgeSourceChain("Arc_Testnet") === null);

  // ── 2. Amount rules ────────────────────────────────────────────────────
  ok("parse 10.00 -> 10000000n", parseBridgeAmountToBaseUnits("10.00") === 10_000_000n);
  ok("parse 0.000001 -> 1n", parseBridgeAmountToBaseUnits("0.000001") === 1n);
  ok("zero rejected", parseBridgeAmountToBaseUnits("0") === null && parseBridgeAmountToBaseUnits("0.00") === null);
  ok("negative rejected", parseBridgeAmountToBaseUnits("-5") === null);
  ok("malformed rejected", parseBridgeAmountToBaseUnits("abc") === null && parseBridgeAmountToBaseUnits("1,000") === null && parseBridgeAmountToBaseUnits("") === null);
  ok("7-decimal precision rejected", parseBridgeAmountToBaseUnits("1.0000001") === null);
  ok("validate flags insufficient balance",
    validateBridgeAmount("10", 9_000_000n).ok === false &&
    (validateBridgeAmount("10", 9_000_000n) as any).error === "INSUFFICIENT_BALANCE");
  ok("validate passes exact balance", validateBridgeAmount("9", 9_000_000n).ok === true);
  ok("format round-trips", formatBridgeBaseUnits(10_000_000n) === "10" && formatBridgeBaseUnits(1n) === "0.000001");

  // ── 3. Bridge error copy (no raw internals) ────────────────────────────
  ok("rejection copy", mapBridgeError(new Error("User rejected the request."), { sourceLabel: "Arbitrum Sepolia" }).message === "Bridge approval was cancelled.");
  ok("wrong-chain copy names the source",
    mapBridgeError(new Error("The current chain of the wallet does not match the target chain"), { sourceLabel: "Base Sepolia" }).message === "Switch your wallet to Base Sepolia to continue.");
  ok("insufficient copy names chain+USDC",
    mapBridgeError(new Error("insufficient funds"), { sourceLabel: "Optimism Sepolia" }).message === "Your connected wallet does not have enough USDC on Optimism Sepolia.");
  ok("unsupported source copy", mapBridgeError(new Error("unsupported source chain")).message === "This source chain is not currently supported.");
  ok("disconnected copy", mapBridgeError(new Error("connector disconnected")).message === "Reconnect your wallet to continue.");
  ok("bridge failure copy never claims fund safety falsely",
    mapBridgeError(new Error("attestation timeout")).message.includes("unless a transaction was confirmed"));

  // ── 4. Static guards ───────────────────────────────────────────────────
  // walletSetId lives on the AGENT deploy models (CircleWalletSet relation —
  // untouched by this change). The consumer model must not carry it: scope
  // the check to the ConsumerAccount block.
  const consumerBlock = (src("prisma/schema.prisma").match(/model ConsumerAccount \{[\s\S]*?^\}/m) ?? [""])[0];
  ok("walletSetId not reintroduced (consumer model)", !/walletSetId/i.test(codeWithoutComments(consumerBlock)));
  const bridgeFiles = [
    "src/app/api/cctp/transfer/external/intent/route.ts",
    "src/app/api/cctp/transfer/external/verify/route.ts",
    "src/app/api/cctp/transfer/external/complete/route.ts",
    "src/app/api/cctp/transfer/external/status/route.ts",
    "src/app/api/cctp/transfer/external/destination/route.ts",
    "src/lib/bridge/externalVerify.ts",
    "src/lib/bridge/externalDestination.ts",
    "src/components/bridge/ExternalBridge.tsx",
  ];
  for (const p of bridgeFiles) {
    const s = codeWithoutComments(src(p));
    ok(`${p}: no walletSetId`, !/walletSetId/i.test(s), "");
    ok(`${p}: no Tower`, !/tower/i.test(s), "");
  }
  const ui = src("src/components/bridge/ExternalBridge.tsx");
  ok("UI: single kit.bridge call site", (ui.match(/\.bridge\(\{/g) ?? []).length === 1, `${(ui.match(/\.bridge\(/g) ?? []).length} raw matches`);
  ok("UI: partial results resume via kit.retry", ui.includes("kit.retry("));
  ok("UI: never restarts after a succeeded step (resumeOnly)", ui.includes("resumeOnly"));
  ok("UI: double-submit busyRef guard", ui.includes("busyRef.current"));
  ok("UI: uses the viem browser adapter", ui.includes("createViemAdapterFromProvider"));
  ok("UI: forwarder mint (no destination signing)", ui.includes("useForwarder: true"));
  ok("UI: Arc_Testnet destination literal", ui.includes("'Arc_Testnet'"));
  ok("UI: chain switch happens before BridgeKit invocation",
    ui.indexOf("ensureOnSourceChain()") < ui.indexOf(".bridge({"));
  for (const p of [
    "src/app/api/cctp/transfer/external/intent/route.ts",
    "src/app/api/cctp/transfer/external/verify/route.ts",
    "src/app/api/cctp/transfer/external/complete/route.ts",
  ]) {
    const s = src(p);
    ok(`${p}: no server wallet signing`, !/createCircleWalletsAdapter|startBridge|createAccountWallet|CIRCLE_API_KEY|CIRCLE_ENTITY_SECRET/i.test(s));
    ok(`${p}: creates no wallet`, !/consumerAccount\.create|createAccountWallet/i.test(s));
  }
  const sessionRoute = src("src/app/api/consumer/session/route.ts");
  ok("session upgrade links (not replaces) the external row",
    sessionRoute.includes("linkedCircleAddress") && sessionRoute.includes("linkingExternalId"));
  ok("session upgrade never overwrites an existing link",
    sessionRoute.includes("!(prior as any)?.linkedCircleAddress"));
  ok("session upgrade still provisions Arc-only via createAccountWallet",
    sessionRoute.includes("createAccountWallet(`consumer_${Date.now()}`)"));
  const consumerSrc = src("src/app/consumer/page.tsx");
  ok("consumer page renders ExternalBridge for EXTERNAL", consumerSrc.includes("<ExternalBridge"));
  ok("consumer page keeps CIRCLE Arc-only copy", consumerSrc.includes("Your FlareHQ wallet is on Arc."));
  const wagmiSrc = src("src/lib/wagmi.ts");
  ok("wagmi registers source chains for switching", wagmiSrc.includes("arbitrumSepolia") && wagmiSrc.includes("polygonAmoy"));

  // ── 5. Route behavior with throwaway fixtures ──────────────────────────
  // Link states mirror exactly what the session-upgrade flow writes (the
  // bridge routes themselves never create wallets).
  const wExtNoLink = mkWallet();
  const wExtBroken = mkWallet();
  const wExt = mkWallet();
  const wCircle = mkWallet();
  const wGhost = mkWallet(); // linked address with no row
  const aExtNoLink = await prisma.consumerAccount.create({ data: { walletAddress: wExtNoLink, walletType: "EXTERNAL", onboardingSource: "web" } });
  const aExtBroken = await prisma.consumerAccount.create({ data: { walletAddress: wExtBroken, walletType: "EXTERNAL", linkedCircleAddress: wGhost, onboardingSource: "web" } });
  const aExt = await prisma.consumerAccount.create({ data: { walletAddress: wExt, walletType: "EXTERNAL", linkedCircleAddress: wCircle, onboardingSource: "web" } });
  const aCircle = await prisma.consumerAccount.create({ data: { walletAddress: wCircle, walletType: "CIRCLE", circleWalletId: `ext-multi-${RUN}`, onboardingSource: "web" } });
  const tExtNoLink = await issueConsumerSessionToken(aExtNoLink.id, wExtNoLink);
  const tExtBroken = await issueConsumerSessionToken(aExtBroken.id, wExtBroken);
  const tExt = await issueConsumerSessionToken(aExt.id, wExt);
  const tCircle = await issueConsumerSessionToken(aCircle.id, wCircle);
  try {
    // Unauthenticated on all endpoints.
    const u1 = await json(await intentPOST(mkReq("http://t/api/cctp/transfer/external/intent", { method: "POST", body: { sourceChain: "Base_Sepolia", amount: "1" }, xff: XFF("u1") }) as any));
    ok("intent unauthenticated -> 401", u1.success === false, JSON.stringify(u1).slice(0, 80));
    const u2 = await statusGET(mkReq("http://t/api/cctp/transfer/external/status?reference=x", { xff: XFF("u2") }) as any);
    ok("status unauthenticated -> 401", u2.status === 401, `${u2.status}`);
    const u3 = await json(await verifyPOST(mkReq("http://t/api/cctp/transfer/external/verify", { method: "POST", body: {}, xff: XFF("u3") }) as any));
    ok("verify unauthenticated fails closed", u3.success === false, "");
    const u4 = await json(await completePOST(mkReq("http://t/api/cctp/transfer/external/complete", { method: "POST", body: {}, xff: XFF("u4") }) as any));
    ok("complete unauthenticated fails closed", u4.success === false, "");

    // CIRCLE session cannot use the external path (modes never mixed).
    const c1 = await intentPOST(mkReq("http://t/api/cctp/transfer/external/intent", { method: "POST", token: tCircle, body: { sourceChain: "Base_Sepolia", amount: "1" }, xff: XFF("c1") }) as any);
    const c1b = await json(c1);
    ok("CIRCLE session refused on external intent", c1.status === 403 && c1b.code === "CIRCLE_CANNOT_USE_EXTERNAL_BRIDGE", `status=${c1.status} code=${c1b.code}`);

    // Legacy CIRCLE path unchanged: Arc-only refusal.
    const leg = await legacyBridgePOST(mkReq("http://t/api/cctp/transfer", { method: "POST", token: tCircle, body: { fromChain: "Base_Sepolia", toChain: "Arc_Testnet", amount: "1", recipient: wCircle }, xff: XFF("leg") }) as any);
    const legB = await json(leg);
    ok("CIRCLE legacy bridge still Arc-only", leg.status === 400 && legB.code === "BRIDGE_SOURCE_UNSUPPORTED", `code=${legB.code}`);

    // Amount validation matrix.
    for (const [amt, name] of [["0", "zero"], ["-5", "negative"], ["abc", "malformed"], ["1.0000001", "precision"]] as const) {
      const r = await intentPOST(mkReq("http://t/api/cctp/transfer/external/intent", { method: "POST", token: tExt, body: { sourceChain: "Base_Sepolia", amount: amt }, xff: XFF(`amt-${name}`) }) as any);
      const b = await json(r);
      ok(`amount ${name} rejected`, r.status === 400 && b.code === "AMOUNT_INVALID", `status=${r.status} code=${b.code}`);
    }
    const badSrc = await json(await intentPOST(mkReq("http://t/api/cctp/transfer/external/intent", { method: "POST", token: tExt, body: { sourceChain: "Nope_Chain", amount: "1" }, xff: XFF("badsrc") }) as any));
    ok("unsupported source rejected", badSrc.code === "UNSUPPORTED_SOURCE", `code=${badSrc.code}`);

    // Destination gating: unlinked and dangling links fail recoverable.
    const dNoLink = await destGET(mkReq("http://t/api/cctp/transfer/external/destination", { token: tExtNoLink, xff: XFF("dnl") }) as any);
    const dNoLinkB = await json(dNoLink);
    ok("unlinked wallet -> CIRCLE_WALLET_UNBOUND", dNoLink.status === 400 && dNoLinkB.code === "CIRCLE_WALLET_UNBOUND", `code=${dNoLinkB.code}`);
    const dBroken = await destGET(mkReq("http://t/api/cctp/transfer/external/destination", { token: tExtBroken, xff: XFF("dbr") }) as any);
    const dBrokenB = await json(dBroken);
    ok("dangling link -> CIRCLE_WALLET_UNBOUND", dBroken.status === 400 && dBrokenB.code === "CIRCLE_WALLET_UNBOUND", `code=${dBrokenB.code}`);
    const dLinked = await json(await destGET(mkReq("http://t/api/cctp/transfer/external/destination", { token: tExt, xff: XFF("dl") }) as any));
    ok("linked CIRCLE wallet resolves as destination", dLinked.success === true && dLinked.destination?.toLowerCase() === wCircle.toLowerCase(), JSON.stringify(dLinked).slice(0, 120));

    const iNoLink = await json(await intentPOST(mkReq("http://t/api/cctp/transfer/external/intent", { method: "POST", token: tExtNoLink, body: { sourceChain: "Base_Sepolia", amount: "1" }, xff: XFF("inl") }) as any));
    ok("intent without linked wallet -> CIRCLE_WALLET_UNBOUND", iNoLink.code === "CIRCLE_WALLET_UNBOUND", `code=${iNoLink.code}`);

    // Happy-path intent: browser-supplied recipient/destination ignored.
    const intent = await json(await intentPOST(mkReq("http://t/api/cctp/transfer/external/intent", {
      method: "POST", token: tExt,
      body: { sourceChain: "Arbitrum_Sepolia", amount: "10.00", recipient: mkWallet(), destination: mkWallet() },
      xff: XFF("intent"),
    }) as any));
    ok("intent issued", intent.success === true && !!intent.reference, JSON.stringify(intent).slice(0, 120));
    ok("destination is the linked CIRCLE wallet (browser address ignored)",
      (intent.destination ?? "").toLowerCase() === wCircle.toLowerCase(), `${intent.destination}`);
    ok("intent echoes source metadata", intent.source?.chainId === 421614 && intent.source?.id === "Arbitrum_Sepolia", JSON.stringify(intent.source));
    ok("intent amount exact base units", intent.amount === "10000000", `${intent.amount}`);
    if (intent.reference) intentIds.push(intent.reference);

    // Status follows the recorded state machine.
    const st1 = await json(await statusGET(mkReq(`http://t/api/cctp/transfer/external/status?reference=${intent.reference}`, { token: tExt, xff: XFF("st1") }) as any));
    ok("status pending after intent", st1.success === true && st1.state === "pending", `${st1.state}`);
    const stUnknown = await statusGET(mkReq("http://t/api/cctp/transfer/external/status?reference=does-not-exist", { token: tExt, xff: XFF("stx") }) as any);
    ok("unknown reference -> 404", stUnknown.status === 404, `${stUnknown.status}`);
    const stForeign = await statusGET(mkReq(`http://t/api/cctp/transfer/external/status?reference=${intent.reference}`, { token: tExtNoLink, xff: XFF("stf") }) as any);
    ok("foreign reference -> 404 (no oracle)", stForeign.status === 404, `${stForeign.status}`);

    // Complete before burn is rejected (no skipping the burn proof).
    const cpEarly = await completePOST(mkReq("http://t/api/cctp/transfer/external/complete", { method: "POST", token: tExt, body: { reference: intent.reference, mintTxHash: `0x${"ab".repeat(32)}` }, xff: XFF("cpe") }) as any);
    const cpEarlyB = await json(cpEarly);
    ok("complete-before-burn rejected", cpEarly.status === 400 && cpEarlyB.code === "COMPLETE_REQUIRES_BURN", `code=${cpEarlyB.code}`);

    // Verify idempotency: same hash twice is one record, never two.
    const fakeHash = `0x${"cd".repeat(32)}`;
    const bound = await (prisma as any).flowBridgeIntent.create({
      data: {
        sourceWallet: wExt, destination: wCircle, sourceChain: "Base_Sepolia",
        amount: "5000000", status: "BURN_CONFIRMED", burnTxHash: fakeHash,
        destinationBound: false, expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    intentIds.push(bound.id);
    const vSame = await json(await verifyPOST(mkReq("http://t/api/cctp/transfer/external/verify", { method: "POST", token: tExt, body: { reference: bound.id, burnTxHash: fakeHash }, xff: XFF("vsame") }) as any));
    ok("re-submitting the same burn hash is idempotent", vSame.success === true && vSame.state === "burn-confirmed", JSON.stringify(vSame).slice(0, 100));
    const vDiff = await verifyPOST(mkReq("http://t/api/cctp/transfer/external/verify", { method: "POST", token: tExt, body: { reference: bound.id, burnTxHash: `0x${"ef".repeat(32)}` }, xff: XFF("vdiff") }) as any);
    const vDiffB = await json(vDiff);
    ok("a second burn hash on one intent is refused", vDiff.status === 409 && vDiffB.code === "INTENT_ALREADY_USED", `status=${vDiff.status} code=${vDiffB.code}`);
    const rows = await (prisma as any).flowBridgeIntent.findMany({ where: { id: bound.id } });
    ok("no duplicate intent created by re-verify", rows.length === 1 && rows[0].burnTxHash?.toLowerCase() === fakeHash, "");
  } finally {
    if (intentIds.length) await prisma.flowBridgeIntent.deleteMany({ where: { id: { in: intentIds } } }).catch(() => {});
    await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: wallets } } }).catch(() => {});
  }
  const leftover = await prisma.consumerAccount.findMany({ where: { walletAddress: { in: wallets } } }).catch(() => []);
  ok("fixtures cleaned up", leftover.length === 0, `${leftover.length} left`);
  console.log(`\nconsumer-external-multichain-bridge-tests: ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}
main().catch(async (e) => { console.error("FATAL", e?.message ?? e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
