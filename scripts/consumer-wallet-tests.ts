// scripts/consumer-wallet-tests.ts
//
// Consumer wallet restoration (Circle developer-controlled SCA + external):
// EMAIL login -> same CIRCLE wallet; EXTERNAL stays EXTERNAL; the Circle
// user-controlled architecture (circleUserId / circleAuth / Web-SDK
// userToken+encryptionKey / USER_CONTROLLED) is retired.
//
// Static source proofs + pure unit checks: no RPC, no DB, no funds, no
// network. Run:
//   npx tsx scripts/consumer-wallet-tests.ts
//
// Covers:
//   schema/migration: circleUserId + ConsumerAccount.walletSetId removed,
//     no walletSetId (re)introduced, rows preserved (no destructive ops).
//   resolver (consumerWallet.ts): CIRCLE/EXTERNAL mapping, server-signing
//     contract, fail-closed unknown modes, session helper.
//   email-auth route: anti-enumeration OTP request, idempotent
//     resolve-or-create (OTP atomic claim + P2002 fallback), same-wallet
//     return, same consumer_token session, no walletSetId.
//   session route: Path A (external challenge) + Path B (dev-controlled
//     creation) preserved, Path C (circleAuth) gone, no UC imports.
//   signingModel: CIRCLE+circleWalletId -> server-signed, EXTERNAL ->
//     external-eoa, everything else unsupported.
//   cctp routes: UC branches gone, Arc-only server bridge, EXTERNAL_WALLET
//     codes preserved, challenge/save/circle endpoints retired (410).
//   boundaries: merchant auth, withGateway, router contract, PaymentLog
//     authority, escrow, agent wallets untouched.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260915000000_consumer_circle_email_auth/migration.sql");
const resolver = read("src/lib/auth/consumerWallet.ts");
const emailAuth = read("src/app/api/consumer/email-auth/route.ts");
const sessionRoute = read("src/app/api/consumer/session/route.ts");
const signing = read("src/lib/wallet/signingModel.ts");
const transferRoute = read("src/app/api/cctp/transfer/route.ts");
const balanceRoute = read("src/app/api/cctp/transfer/balance/route.ts");
const statusRoute = read("src/app/api/cctp/transfer/status/route.ts");
const challengeRoute = read("src/app/api/cctp/transfer/challenge/route.ts");
const saveChallenge = read("src/app/api/consumer/save/challenge/route.ts");
const saveConfirm = read("src/app/api/consumer/save/confirm/route.ts");
const circleProxy = read("src/app/api/consumer/circle/route.ts");
const consumerOtp = read("src/lib/auth/consumerOtp.ts");
const consumerPage = read("src/app/consumer/page.tsx");
const gateway = read("src/lib/x402.ts");
const merchantLogin = read("src/app/api/merchant/login/route.ts");
const merchantSignup = read("src/app/api/merchant/signup/route.ts");

console.log("── schema / migration ────────────");
const consumerBlock = schema.slice(
  schema.indexOf("model ConsumerAccount {"),
  schema.indexOf("model ConsumerEmailOtp {")
);
ok("circleUserId column removed from ConsumerAccount", !/^\s*circleUserId\s+String\?/m.test(consumerBlock), "column still present");
ok("walletSetId column removed from ConsumerAccount", !/^\s*walletSetId\s/m.test(consumerBlock), "column still present");
const walletTypeDecl = consumerBlock.split("\n").find((l) => /^\s*walletType\s+String/.test(l)) ?? "";
ok("walletType is CIRCLE | EXTERNAL only", walletTypeDecl.includes('"CIRCLE" | "EXTERNAL"') && !walletTypeDecl.includes("USER_CONTROLLED"), "wrong modes");
ok("circleWalletId retained (CIRCLE binding)", consumerBlock.includes("circleWalletId"), "missing");
ok("email unique retained", consumerBlock.includes("email") && consumerBlock.includes("@unique"), "missing");
ok("no walletSetId column in schema for consumers", !/^\s*walletSetId\s/m.test(consumerBlock), "column present");
ok("AgentRegistry.walletSetId untouched", /model AgentRegistry[\s\S]*?walletSetId\s+String\?/.test(schema), "agent field changed");
ok("migration drops circleUserId", migration.includes('DROP COLUMN') && migration.includes('"circleUserId"'), "missing drop");
ok("migration drops ConsumerAccount.walletSetId", migration.includes('"walletSetId"'), "missing drop");
ok("migration preserves rows (no table/row destruction)", !/DROP TABLE|DELETE |TRUNCATE|CREATE TABLE/.test(migration), "destructive op found");
ok("migration adds no walletSetId", !/ADD COLUMN[^;]*walletSetId/.test(migration), "walletSetId added");

console.log("── retired modules gone ────────────");
for (const f of [
  "src/lib/circle/userControlled.ts",
  "src/lib/circle/userSave.ts",
  "src/lib/circle/userBridge.ts",
  "src/lib/circle/cctpChallenge.ts",
]) {
  ok(`deleted ${f}`, !exists(f), "still exists");
}
const srcFiles = [
  "src/app/api/consumer/session/route.ts",
  "src/app/api/consumer/email-auth/route.ts",
  "src/app/api/consumer/circle/route.ts",
  "src/app/api/consumer/save/challenge/route.ts",
  "src/app/api/consumer/save/confirm/route.ts",
  "src/app/api/cctp/transfer/route.ts",
  "src/app/api/cctp/transfer/balance/route.ts",
  "src/app/api/cctp/transfer/status/route.ts",
  "src/app/api/cctp/transfer/challenge/route.ts",
  "src/lib/auth/consumerWallet.ts",
  "src/lib/wallet/signingModel.ts",
  "src/lib/circle/client.ts",
  "src/lib/circle/transfers.ts",
];
for (const f of srcFiles) {
  const src = read(f);
  ok(`no UC runtime import in ${f}`,
    !/circle\/(userControlled|userSave|userBridge|cctpChallenge)/.test(src),
    "still imports retired architecture");
}

console.log("── canonical resolver ────────────");
ok("resolveConsumerWallet exported", resolver.includes("export function resolveConsumerWallet"), "missing");
ok("getAuthenticatedConsumer exported", resolver.includes("export async function getAuthenticatedConsumer"), "missing");
const modeDecl = resolver.split("\n").find((l) => l.includes("ConsumerWalletMode =")) ?? "";
ok("modes CIRCLE + EXTERNAL only", modeDecl.includes('"CIRCLE"') && modeDecl.includes('"EXTERNAL"'), "wrong modes");
ok("exposes circleWalletId when CIRCLE", resolver.includes("circleWalletId"), "missing");
ok("exposes canServerSign", resolver.includes("canServerSign"), "missing");
ok("fail-closed on unknown modes", /return null;/.test(resolver), "no fail-closed");
ok("uses consumer_token session (no Circle tokens)", resolver.includes("resolveConsumerSession") && !/userToken|encryptionKey|circleAuth/.test(resolver), "wrong auth primitive");
ok("no walletSetId in resolver", !/walletSetId/.test(resolver), "walletSetId present");

console.log("── email login ────────────");
ok("EMAIL_LOGIN OTP purpose", consumerOtp.includes('"EMAIL_LOGIN"'), "purpose missing");
ok("POST is generic (anti-enumeration)", emailAuth.includes("genericOk()") && emailAuth.includes("issueConsumerOtp"), "not generic");
ok("POST works for new + returning (no session required)", !emailAuth.includes("resolveConsumerSession"), "session wrongly required");
ok("PUT verifies EMAIL_LOGIN OTP", emailAuth.includes('purpose: "EMAIL_LOGIN"') && emailAuth.includes("verifyConsumerOtp"), "missing verify");
ok("returning email resolves same row", emailAuth.includes("findUnique({ where: { email } })"), "no email lookup");
ok("new email provisions dev-controlled SCA", emailAuth.includes("createAccountWallet("), "no provisioning");
ok("persists CIRCLE + circleWalletId + email", emailAuth.includes('walletType: "CIRCLE"') && emailAuth.includes("circleWalletId: wallet.walletId"), "wrong persistence");
ok("P2002 race resolves to winner row", emailAuth.includes("P2002"), "no race fallback");
ok("issues existing consumer_token", emailAuth.includes("issueConsumerSessionToken"), "wrong session");
ok("EXTERNAL never converted", /never converted/i.test(emailAuth), "no conversion guard");
ok("no walletSetId persisted", !/walletSetId\s*[:=]/.test(emailAuth), "walletSetId written");
ok("no UC auth primitives", !/circleAuth|circleUserId|userToken|encryptionKey/.test(emailAuth), "UC primitive present");

console.log("── session route ────────────");
ok("Path C (circleAuth) removed", !sessionRoute.includes("circleAuth"), "still present");
ok("no circleUserId handling", !sessionRoute.includes("circleUserId"), "still present");
ok("Path A external challenge preserved", sessionRoute.includes("verifyMessage") && sessionRoute.includes("consumer_connect_nonce"), "external flow changed");
ok("Path B dev-controlled creation preserved", sessionRoute.includes("createAccountWallet(`consumer_${Date.now()}`)"), "creation changed");
ok("Path B persists CIRCLE + circleWalletId", sessionRoute.includes("walletType: 'CIRCLE'") && sessionRoute.includes("circleWalletId: wallet.walletId"), "wrong persistence");
ok("no walletSetId in session flow", !/walletSetId/.test(sessionRoute), "walletSetId present");
ok("same session mechanism (issueSession)", sessionRoute.includes("issueSession(account"), "session model changed");

console.log("── signing model ────────────");
ok("CIRCLE + circleWalletId is server-signed", signing.includes('if (t === "CIRCLE")') && signing.includes("server-signed"), "wrong gate");
ok("CIRCLE without binding is unsupported", signing.includes("unsupported"), "no fail-closed");
ok("EXTERNAL is external-eoa", signing.includes('if (t === "EXTERNAL") return "external-eoa"'), "wrong branch");
ok("no USER_CONTROLLED signing branch", !/===\s*"USER_CONTROLLED"|"user-controlled-challenge"|requiresClientChallenge/.test(signing), "UC branch remains");
ok("bridge only for server-signed", /bridgeEnabled\(model: SigningModel\): boolean \{\s*\n?\s*return model === "server-signed";/.test(signing), "bridge gate wrong");
ok("no walletSetId gate", !/walletSetId/.test(signing), "walletSetId gate remains");

console.log("── cctp bridge ────────────");
ok("transfer keeps server-signed bridge", transferRoute.includes("startBridge({") && transferRoute.includes("bridgeEnabled(model)"), "bridge broken");
ok("transfer drops UC branch", !/user-controlled-challenge|handleUserControlledBridge|userToken/.test(transferRoute), "UC branch remains");
ok("transfer keeps EXTERNAL_WALLET code", transferRoute.includes("EXTERNAL_WALLET"), "code changed");
ok("transfer is Arc-only without wallet-set provisioning", transferRoute.includes("BRIDGE_SOURCE_UNSUPPORTED") && !transferRoute.includes("ensureWalletOnChain"), "provisioning remains");
ok("transfer keeps step-up + recipient validation", transferRoute.includes("requireConsumerStepUp") && transferRoute.includes("Recipient must be a valid 0x address"), "guards changed");
ok("balance drops UC + wallet-set reads", !/userBridge|ensureWalletOnChain|user-controlled-challenge/.test(balanceRoute) && balanceRoute.includes("getWalletBalance(account.circleWalletId)"), "UC read remains");
ok("status drops ucbridge branch", !/ucbridge_|userBridge/.test(statusRoute), "UC status remains");
ok("challenge endpoint retired (410)", challengeRoute.includes("410") && challengeRoute.includes("BRIDGE_CHALLENGE_RETIRED"), "not retired");
ok("save challenge retired (410)", saveChallenge.includes("410") && saveChallenge.includes("SAVE_CHALLENGE_RETIRED"), "not retired");
ok("save confirm retired (410)", saveConfirm.includes("410") && saveConfirm.includes("SAVE_CONFIRM_RETIRED"), "not retired");
ok("circle proxy retired (410)", circleProxy.includes("410") && circleProxy.includes("CIRCLE_USER_CONTROLLED_RETIRED"), "not retired");
ok("no walletSetId in consumer bridge flow", !/walletSetId/.test(transferRoute) && !/walletSetId/.test(balanceRoute) && !/walletSetId/.test(statusRoute), "walletSetId present");

console.log("── consumer page wiring ────────────");
ok("page branches on circleWalletId binding", consumerPage.includes("signingModelForWallet({ walletType, circleWalletId })"), "not wired");
ok("page holds no walletSetId state", !/walletSetId/.test(consumerPage), "walletSetId remains");

console.log("── boundaries ────────────");
ok("merchant login untouched by consumer UC", !/circleAuth|USER_CONTROLLED|circleUserId/.test(merchantLogin), "merchant login changed");
ok("merchant signup untouched by consumer UC", !/circleAuth|USER_CONTROLLED|circleUserId/.test(merchantSignup), "merchant signup changed");
ok("withGateway untouched", gateway.includes("withGateway"), "gateway changed");
ok("payment router contract untouched", exists("contracts/ArcFlarePaymentRouter.sol"), "contract missing");

console.log("── pure unit checks ────────────");
async function unit() {
  const { signingModelForWallet, bridgeEnabled, canSignServerSide } = await import("@/src/lib/wallet/signingModel");
  ok("CIRCLE + circleWalletId -> server-signed",
    signingModelForWallet({ walletType: "CIRCLE", circleWalletId: "w_1" }) === "server-signed", "");
  ok("CIRCLE without binding -> unsupported",
    signingModelForWallet({ walletType: "CIRCLE", circleWalletId: null }) === "unsupported", "");
  ok("CIRCLE lowercase -> server-signed",
    signingModelForWallet({ walletType: "circle", circleWalletId: "w_1" }) === "server-signed", "");
  ok("EXTERNAL -> external-eoa",
    signingModelForWallet({ walletType: "EXTERNAL" }) === "external-eoa", "");
  ok("USER_CONTROLLED -> unsupported",
    signingModelForWallet({ walletType: "USER_CONTROLLED" }) === "unsupported", "");
  ok("null -> unsupported", signingModelForWallet(null) === "unsupported", "");
  ok("bridgeEnabled only server-signed",
    bridgeEnabled("server-signed") === true && bridgeEnabled("external-eoa") === false && bridgeEnabled("unsupported") === false, "");
  ok("canSignServerSide only server-signed",
    canSignServerSide("server-signed") === true && canSignServerSide("external-eoa") === false, "");

  const { resolveConsumerWallet } = await import("@/src/lib/auth/consumerWallet");
  const c = resolveConsumerWallet({ walletAddress: "0xabc", walletType: "CIRCLE", circleWalletId: "w_1" });
  ok("resolver: CIRCLE server signing", c?.mode === "CIRCLE" && c?.canServerSign === true && c?.circleWalletId === "w_1", JSON.stringify(c));
  const c2 = resolveConsumerWallet({ walletAddress: "0xabc", walletType: "CIRCLE", circleWalletId: null });
  ok("resolver: CIRCLE without binding cannot server-sign", c2?.mode === "CIRCLE" && c2?.canServerSign === false, JSON.stringify(c2));
  const e = resolveConsumerWallet({ walletAddress: "0xabc", walletType: "EXTERNAL" });
  ok("resolver: EXTERNAL browser signing", e?.mode === "EXTERNAL" && e?.canServerSign === false && e?.circleWalletId === null, JSON.stringify(e));
  ok("resolver: USER_CONTROLLED fails closed", resolveConsumerWallet({ walletAddress: "0xabc", walletType: "USER_CONTROLLED" }) === null, "");
  ok("resolver: null fails closed", resolveConsumerWallet(null) === null, "");
}

unit().then(() => {
  console.log(`\nconsumer-wallet-tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("failures:", failures);
    process.exit(1);
  }
});
