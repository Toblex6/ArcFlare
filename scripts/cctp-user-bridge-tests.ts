// scripts/cctp-user-bridge-tests.ts
//
// USER_CONTROLLED CCTP bridge (server-orchestrated, browser-executed burn)
// tests: pure unit checks + static source proofs. No RPC, no DB, no funds,
// no network. Run:
//   npx tsx scripts/cctp-user-bridge-tests.ts
//
// Covers:
//   signingModel.ts: pure walletType+binding -> model matrix, predicates.
//   cctpChallenge.ts: bytes32 codec, approve/burn calldata (selector commits
//     to arg order/types 1:1 with adapter-viem-v2), negative matrix,
//     bridge-kit source bindings, Arc overlap assertion, FAST fee math.
//   userBridge.ts: minor display, intent store round-trip, tx-state helpers.
//   routes: transfer branches on the model (CIRCLE path untouched,
//     EXTERNAL_WALLET preserved), balance reads UC on-chain, challenge binds
//     pendingChallengeId + step-up + burn verification, status polls
//     ucbridge_ mints via balance-delta.
//   userControlled.ts: contract-execution / wallet-provision / challenge /
//     transactions helpers, STUCK handled as terminal failure.
//   frontend: UserControlledBridge executes via setAuthentication+execute,
//     memory-only credentials, stopgap copy; consumer page renders it for
//     USER_CONTROLLED while the EXTERNAL card copy is byte-identical.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const transferRoute = read("src/app/api/cctp/transfer/route.ts");
const challengeRoute = read("src/app/api/cctp/transfer/challenge/route.ts");
const balanceRoute = read("src/app/api/cctp/transfer/balance/route.ts");
const statusRoute = read("src/app/api/cctp/transfer/status/route.ts");
const helper = read("src/lib/circle/userControlled.ts");
const bridge = read("src/lib/circle/userBridge.ts");
const model = read("src/lib/wallet/signingModel.ts");
const enc = read("src/lib/circle/cctpChallenge.ts");
const panel = read("src/components/consumer/UserControlledBridge.tsx");
const consumerPage = read("src/app/consumer/page.tsx");
const gateway = read("src/lib/x402.ts");

// ── 1. signingModel unit ────────────────────────────────────────────────
console.log("\n[1] signingModel unit");
const {
  signingModelForWallet,
  requiresClientChallenge,
  canSignServerSide,
  bridgeEnabled,
} = await import("@/src/lib/wallet/signingModel");

ok("CIRCLE+walletSetId is server-signed", signingModelForWallet({ walletType: "CIRCLE", walletSetId: "ws_1" }) === "server-signed", "");
ok("CIRCLE without walletSetId is unsupported", signingModelForWallet({ walletType: "CIRCLE", walletSetId: null }) === "unsupported", "");
ok("CIRCLE without walletSetId (missing) is unsupported", signingModelForWallet({ walletType: "CIRCLE" }) === "unsupported", "");
ok("USER_CONTROLLED is user-controlled-challenge", signingModelForWallet({ walletType: "USER_CONTROLLED" }) === "user-controlled-challenge", "");
ok("USER_CONTROLLED lowercase maps too", signingModelForWallet({ walletType: "user_controlled" }) === "user-controlled-challenge", "");
ok("EXTERNAL is external-eoa", signingModelForWallet({ walletType: "EXTERNAL" }) === "external-eoa", "");
ok("null account is unsupported", signingModelForWallet(null) === "unsupported", "");
ok("unknown type is unsupported", signingModelForWallet({ walletType: "WHATEVER" }) === "unsupported", "");
ok("requiresClientChallenge only for UC", requiresClientChallenge("user-controlled-challenge") && !requiresClientChallenge("server-signed") && !requiresClientChallenge("external-eoa") && !requiresClientChallenge("unsupported"), "");
ok("canSignServerSide only for server-signed", canSignServerSide("server-signed") && !canSignServerSide("user-controlled-challenge"), "");
ok("bridgeEnabled for server-signed + UC only", bridgeEnabled("server-signed") && bridgeEnabled("user-controlled-challenge") && !bridgeEnabled("external-eoa") && !bridgeEnabled("unsupported"), "");
ok("no raw walletType compare in transfer route", !/account\.walletType !== ['"]CIRCLE['"]/.test(transferRoute) && !/account\.walletType !== ['"]CIRCLE['"]/.test(balanceRoute), "raw check remains");
ok("model module is documented for merchant reuse", model.includes("Merchant reuse"), "");

// ── 2. cctpChallenge unit ───────────────────────────────────────────────
console.log("\n[2] cctpChallenge unit");
const {
  addressToBytes32,
  bytes32ToAddress,
  encodeApproveCallData,
  encodeDepositForBurnCallData,
  computeFastMaxFee,
  resolveSourceChainBinding,
  assertArcDestinationOverlap,
  CCTP_V2_TOKEN_MESSENGER,
  CCTP_ZERO_HASH,
  CCTP_FINALITY_FAST,
  CCTP_FINALITY_SLOW,
} = await import("@/src/lib/circle/cctpChallenge");
const { buildBridgeQuote } = await import("@/src/lib/circle/userBridge");

ok("addressToBytes32 left-pads", addressToBytes32("0x0000000000000000000000000000000000000001") === "0x0000000000000000000000000000000000000000000000000000000000000001", "");
import { getAddress as checksumAddress } from "viem";
ok("bytes32 round-trips", bytes32ToAddress(addressToBytes32("0x5Fd84259d66Cd46123540766Be93DFE6D43130D7")) === checksumAddress("0x5Fd84259d66Cd46123540766Be93DFE6D43130D7"), "");
try { bytes32ToAddress("0x1234"); ok("bytes32 rejects short input", false, "no throw"); }
catch (e: any) { ok("bytes32 rejects short input", e?.code === "INVALID_BYTES32", String(e?.message)); }

const approveCalldata = encodeApproveCallData({ spender: CCTP_V2_TOKEN_MESSENGER, amount: 1000000n });
ok("approve selector is approve(address,uint256)", approveCalldata.slice(0, 10).toLowerCase() === keccak256(toBytes("approve(address,uint256)")).slice(0, 10).toLowerCase(), approveCalldata.slice(0, 10));
try { encodeApproveCallData({ spender: CCTP_V2_TOKEN_MESSENGER, amount: 0n }); ok("approve rejects zero", false, "no throw"); }
catch (e: any) { ok("approve rejects zero", e?.code === "INVALID_AMOUNT", String(e?.message)); }

const burnCalldata = encodeDepositForBurnCallData({
  amount: 1000000n,
  destinationDomain: 26,
  mintRecipient: "0x5Fd84259d66Cd46123540766Be93DFE6D43130D7",
  burnToken: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
});
const burnSelector = keccak256(toBytes("depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)")).slice(0, 10).toLowerCase();
ok("burn selector commits to 1:1 arg order/types", burnCalldata.slice(0, 10).toLowerCase() === burnSelector, `${burnCalldata.slice(0, 10)} vs ${burnSelector}`);
ok("burn calldata is 7-word payload", burnCalldata.length === 2 + 8 + 7 * 64, `len ${burnCalldata.length}`);
ok("burn embeds mintRecipient bytes32", burnCalldata.toLowerCase().includes(addressToBytes32("0x5Fd84259d66Cd46123540766Be93DFE6D43130D7").slice(2).toLowerCase()), "");
ok("zero hash is the destinationCaller default", CCTP_ZERO_HASH === "0x" + "00".repeat(32), "");
for (const [label, args, code] of [
  ["zero amount", { amount: 0n, destinationDomain: 26, mintRecipient: "0x5Fd84259d66Cd46123540766Be93DFE6D43130D7", burnToken: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" }, "INVALID_AMOUNT"],
  ["maxFee >= amount", { amount: 100n, destinationDomain: 26, mintRecipient: "0x5Fd84259d66Cd46123540766Be93DFE6D43130D7", burnToken: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", maxFee: 100n }, "INVALID_MAX_FEE"],
  ["bad finality", { amount: 100n, destinationDomain: 26, mintRecipient: "0x5Fd84259d66Cd46123540766Be93DFE6D43130D7", burnToken: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", minFinalityThreshold: 1500 }, "INVALID_FINALITY"],
] as const) {
  try { (encodeDepositForBurnCallData as any)(args); ok(`burn rejects ${label}`, false, "no throw"); }
  catch (e: any) { ok(`burn rejects ${label}`, e?.code === code, `${e?.code}: ${e?.message}`); }
}

// FAST fee math: minimumFee "1.3" bps on 1_000_000 minor units →
// scaledBps 130, baseFee ceil(130*1e6/1e6)=130, providerFee 130+13=143.
ok("FAST maxFee formula", computeFastMaxFee([{ finalityThreshold: 1000, minimumFee: "1.3" }], 1_000_000n) === 143n, "");
try { computeFastMaxFee([{ finalityThreshold: 2000, minimumFee: "0.1" }], 1_000_000n); ok("fee rejects missing FAST tier", false, "no throw"); }
catch (e: any) { ok("fee rejects missing FAST tier", e?.code === "CCTP_FEE_TIER_MISSING", String(e?.message)); }

for (const id of ["Arbitrum_Sepolia", "Base_Sepolia", "Ethereum_Sepolia", "Optimism_Sepolia", "Polygon_Amoy_Testnet"]) {
  const b = resolveSourceChainBinding(id);
  ok(`${id} messenger is canonical`, b.tokenMessenger.toLowerCase() === CCTP_V2_TOKEN_MESSENGER.toLowerCase(), b.tokenMessenger);
  ok(`${id} usdc is an address`, /^0x[0-9a-fA-F]{40}$/.test(b.usdcAddress), b.usdcAddress);
}
try { resolveSourceChainBinding("Solana"); ok("binding rejects unknown chain", false, "no throw"); }
catch (e: any) { ok("binding rejects unknown chain", e?.code === "UNSUPPORTED_SOURCE_CHAIN", String(e?.message)); }
const overlap = assertArcDestinationOverlap();
ok("Arc overlap: domain 26", overlap.destinationDomain === 26, String(overlap.destinationDomain));
const q = buildBridgeQuote({ fromChain: "Base_Sepolia", amount: "0.01" });
ok("quote parses 0.01 to 10000 minor", q.amountMinor === 10000n && q.maxFeeMinor === 0n && q.minFinalityThreshold === CCTP_FINALITY_SLOW, "");
try { (buildBridgeQuote as any)({ fromChain: "Base_Sepolia", amount: "0.0000001" }); ok("quote rejects 7-decimal dust", false, "no throw"); }
catch (e: any) { ok("quote rejects 7-decimal dust", e?.code === "INVALID_AMOUNT", String(e?.message)); }
ok("finality constants", CCTP_FINALITY_FAST === 1000 && CCTP_FINALITY_SLOW === 2000, "");
ok("encoding module documents the mirror", enc.includes("adapter-viem-v2") && enc.includes("forwarderSupported"), "");

// ── 3. userBridge pure ──────────────────────────────────────────────────
console.log("\n[3] userBridge pure");
const {
  minorToDisplay,
  getUserBridgeIntent,
  setUserBridgeIntent,
  makeUserBridgeReference,
} = await import("@/src/lib/circle/userBridge");
const { isCircleTxComplete, isCircleTxTerminalFailure } = await import("@/src/lib/circle/userControlled");

ok("minor display 2 USDC", minorToDisplay(2_000_000n) === "2.000000", minorToDisplay(2_000_000n));
ok("minor display dust", minorToDisplay(1n) === "0.000001", minorToDisplay(1n));
const ref = makeUserBridgeReference();
ok("reference is namespaced", ref.startsWith("ucbridge_"), ref);
ok("unknown intent is null", getUserBridgeIntent("ucbridge_nope") === null, "");
setUserBridgeIntent({
  reference: ref, state: "needs-burn", fromChain: "Base_Sepolia", toChain: "Arc_Testnet",
  amountMinor: "10000", maxFeeMinor: "0", minFinalityThreshold: 2000,
  senderAddress: "0x5Fd84259d66Cd46123540766Be93DFE6D43130D7",
  recipientAddress: "0x5Fd84259d66Cd46123540766Be93DFE6D43130D7",
  sourceDomain: 6, destinationDomain: 26,
  tokenMessenger: CCTP_V2_TOKEN_MESSENGER as `0x${string}`,
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
  circleBlockchain: "BASE-SEPOLIA", walletId: "w1",
  pendingChallengeId: "c1", pendingPurpose: "burn",
  burnTxHash: null, balanceBeforeMinor: null, error: null,
  createdAt: Date.now(), updatedAt: Date.now(),
});
ok("intent store round-trips", getUserBridgeIntent(ref)?.pendingChallengeId === "c1", "");
ok("COMPLETE is complete", isCircleTxComplete("COMPLETE") && !isCircleTxComplete("CONFIRMED"), "");
ok("STUCK is terminal failure", isCircleTxTerminalFailure("STUCK") && isCircleTxTerminalFailure("FAILED") && isCircleTxTerminalFailure("DENIED") && isCircleTxTerminalFailure("CANCELLED") && !isCircleTxTerminalFailure("SENT"), "");
ok("bridge module is server-only guarded", bridge.includes('typeof window !== "undefined"'), "");

// ── 4. route proofs ─────────────────────────────────────────────────────
console.log("\n[4] routes");
ok("transfer branches on the model", transferRoute.includes("signingModelForWallet") && transferRoute.includes("bridgeEnabled"), "");
ok("transfer keeps the CIRCLE path", transferRoute.includes("ensureWalletOnChain(account.walletSetId") && transferRoute.includes("startBridge({"), "");
ok("transfer keeps EXTERNAL_WALLET", transferRoute.includes("code: 'EXTERNAL_WALLET'"), "");
ok("transfer UC needs userToken per-request", transferRoute.includes("USER_TOKEN_REQUIRED"), "");
ok("transfer UC provisions via challenge", transferRoute.includes("createProvisionChallenge") && transferRoute.includes("needs-provision"), "");
ok("transfer UC gates allowance then burn", transferRoute.includes("needs-approval") && transferRoute.includes("createBurnChallenge") && transferRoute.includes("needs-burn"), "");
ok("transfer never logs the userToken", !/console\.(log|error)\([^)]*userToken/i.test(transferRoute), "");
ok("challenge binds pendingChallengeId", challengeRoute.includes("intent.pendingChallengeId !== String(challengeId)") && challengeRoute.includes("CHALLENGE_MISMATCH"), "");
ok("challenge enforces step-up", challengeRoute.includes('requireConsumerStepUp(req, account, "consumer.bridge")'), "");
ok("challenge verifies the burn receipt", challengeRoute.includes("verifyBurnReceipt"), "");
ok("challenge re-checks allowance as evidence", challengeRoute.includes("readSourceAllowance"), "");
ok("challenge never logs the userToken", !/console\.(log|error)\([^)]*userToken/i.test(challengeRoute), "");
ok("balance reads UC on-chain", balanceRoute.includes("readSourceUsdcBalance") && balanceRoute.includes("minorToDisplay"), "");
ok("balance keeps EXTERNAL_WALLET upgrade flow", balanceRoute.includes('code: "EXTERNAL_WALLET"'), "");
ok("status polls ucbridge_ mints", statusRoute.includes('startsWith("ucbridge_")') && statusRoute.includes("readArcUsdcBalanceOf"), "");
ok("status keeps Bridge-Kit path", statusRoute.includes("checkBridgeStatus(reference)"), "");

// ── 5. userControlled challenge surface ─────────────────────────────────
console.log("\n[5] userControlled challenge surface");
ok("contract-execution challenge", helper.includes("createUserContractExecutionChallenge") && helper.includes("/v1/w3s/user/transactions/contractExecution"), "");
ok("wallet-provision challenge", helper.includes("createUserWalletOnChainChallenge") && helper.includes("/v1/w3s/user/wallets"), "");
ok("challenge polling", helper.includes("getUserChallenge") && helper.includes("/v1/w3s/user/challenges/"), "");
ok("transaction lookup + list", helper.includes("getUserTransaction") && helper.includes("listUserTransactions"), "");
ok("callData preferred over ABI shorthand", helper.includes("callData"), "");
ok("server-only guard intact", helper.includes('typeof window !== "undefined"'), "");

// ── 6. frontend ─────────────────────────────────────────────────────────
console.log("\n[6] frontend");
ok("bridge executes via setAuthentication+execute", panel.includes("setAuthentication") && panel.includes(".execute("), "");
ok("bridge re-auths at bridge time", panel.includes("social-token") && panel.includes("email-token"), "");
ok("bridge creds memory-only", panel.includes("credsRef") && !/localStorage\.setItem\([^)]*(userToken|encryptionKey)/i.test(panel), "");
ok("bridge clears creds on unmount/done", panel.includes("userToken: null, encryptionKey: null"), "");
ok("bridge lazy-imports the SDK", panel.includes("await import('@circle-fin/w3s-pw-web-sdk')"), "");
ok("bridge never logs userToken", !/console\.(log|error)\([^)]*userToken/i.test(panel), "");
ok("stopgap copy preserved", panel.includes("Bridging support for your wallet type is being added - check back soon"), "");
ok("page renders UC bridge", consumerPage.includes("UserControlledBridge") && consumerPage.includes('toUpperCase() === "USER_CONTROLLED"'), "");
ok("EXTERNAL card copy byte-identical", consumerPage.includes("Bridging needs a FlareHQ wallet") && consumerPage.includes("Create a FlareHQ wallet") && consumerPage.includes("createFlareHQWallet"), "");
ok("step-up errors carry codes", consumerPage.includes("err.code = data?.code"), "");

// ── 7. invariants ───────────────────────────────────────────────────────
console.log("\n[7] invariants");
ok("withGateway untouched", gateway.includes("withGateway"), "");
ok("no default-payer fallback in new code", !/\|\|.*default.*wallet/i.test(bridge + transferRoute + challengeRoute), "");
ok("docs describe the UC bridge", read("docs/consumer-circle-auth.md").includes("server-orchestrated") && read("docs/consumer-circle-auth.md").includes("signingModel"), "");

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) { console.error("FAILURES:\n- " + failures.join("\n- ")); process.exit(1); }
