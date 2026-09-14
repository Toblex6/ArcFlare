// scripts/consumer-circle-auth-tests.ts
//
// Consumer Circle user-controlled wallet auth (Google / email OTP) tests.
//
// Static source proofs + pure unit checks: no RPC, no DB, no funds, no
// network. Run:
//   npx tsx scripts/consumer-circle-auth-tests.ts
//
// Covers:
//   session route: circleAuth link path verifies via server-side Circle
//     listWallets (never trusts a client address alone), hinted-address
//     mismatch refused, returning users dedup via circleUserId OR address,
//     CUSTODY_CONFLICT guard, external challenge (Path A) + legacy creation
//     (Path B) preserved, same consumer_token session, isNew flag.
//   userControlled.ts: server-only guard, 5 Circle REST actions, fail-closed
//     config, Arc-wallet selection, no user key material.
//   proxy route: all 5 actions, rate-limited, never logs tokens.
//   settle + scheduled: USER_CONTROLLED fails closed (no server signing, no
//     shared-wallet fallback).
//   frontend: Google performLogin + email verifyOtp + challenge execute +
//     circleAuth link, memory-only credentials, cancel/failure paths.
//   consumer page: Google/email primary, external connect preserved, legacy
//     recovery demoted, legacy instant creation preserved.
//   swap: only EXTERNAL is wagmi-signable (USER_CONTROLLED gets the managed
//     notice — no swap math touched).
//   schema/migration/env/docs: circleUserId unique, additive migration,
//     new vars documented, no secrets committed.
//   boundaries: merchant auth untouched, withGateway untouched.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const sessionRoute = read("src/app/api/consumer/session/route.ts");
const helper = read("src/lib/circle/userControlled.ts");
const proxy = read("src/app/api/consumer/circle/route.ts");
const settle = read("src/app/api/payments/settle/route.ts");
const scheduled = read("src/app/api/payments/scheduled/route.ts");
const panel = read("src/components/consumer/CircleUserWallet.tsx");
const consumerPage = read("src/app/consumer/page.tsx");
const swapView = read("src/components/swap/FlowSwapView.tsx");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260913000000_consumer_circle_user_controlled/migration.sql");
const envExample = read(".env.example");
const merchantLogin = read("src/app/api/merchant/login/route.ts");
const merchantSignup = read("src/app/api/merchant/signup/route.ts");
const gateway = read("src/lib/x402.ts");
const pkg = JSON.parse(read("package.json"));

console.log("── session link (Path C) ────────────");
ok("circleAuth path exists", sessionRoute.includes("body?.circleAuth"), "no circleAuth branch");
ok("verifies via server-side listWallets", sessionRoute.includes("listUserControlledWallets(userToken)"), "missing server verification");
ok("hinted address must be in Circle list", sessionRoute.includes("CIRCLE_WALLET_MISMATCH"), "no mismatch refusal");
ok("returning-user dedup via OR", sessionRoute.includes("circleUserId") && sessionRoute.includes("findFirst") && sessionRoute.includes("OR: or"), "no dedup query");
ok("creates USER_CONTROLLED rows", sessionRoute.includes("walletType: 'USER_CONTROLLED'"), "wrong walletType");
ok("CUSTODY_CONFLICT guard for dev wallets", sessionRoute.includes("CUSTODY_CONFLICT"), "missing guard");
ok("same session mechanism (issueSession)", sessionRoute.includes("issueSession(account"), "session model changed");
ok("isNew flag for first-run UX", sessionRoute.includes("isNew"), "no isNew");
ok("401 without userToken", sessionRoute.includes("complete Google or email login first"), "no auth-required 401");
ok("expired Circle session maps to 401", sessionRoute.includes("CIRCLE_AUTH_EXPIRED"), "no expiry mapping");
ok("no wallet yet maps to 404", sessionRoute.includes("CIRCLE_WALLET_NOT_FOUND"), "no 404 path");
ok("Path A external challenge preserved", sessionRoute.includes("verifyMessage") && sessionRoute.includes("consumer_connect_nonce"), "external flow changed");
ok("Path B legacy creation preserved", sessionRoute.includes("createAccountWallet(`consumer_${Date.now()}`)"), "legacy creation changed");
ok("no userToken logging", !/console\.(log|error)\([^)]*userToken/i.test(sessionRoute), "userToken may be logged");

console.log("── server helper ────────────");
ok("server-only window guard", helper.includes('typeof window !== "undefined"'), "no browser-bundle guard");
ok("social device-token endpoint", helper.includes("/v1/w3s/users/social/token"), "missing");
ok("email device-token endpoint", helper.includes("/v1/w3s/users/email/token"), "missing");
ok("user initialize endpoint", helper.includes("/v1/w3s/user/initialize"), "missing");
ok("list wallets endpoint", helper.includes("/v1/w3s/wallets"), "missing");
ok("token refresh endpoint", helper.includes("/v1/w3s/users/token/refresh"), "missing");
ok("155106 already-initialized surfaced", helper.includes("155106"), "missing code");
ok("fail-closed without CIRCLE_APP_ID", helper.includes("CIRCLE_APP_ID_MISSING"), "missing gate");
ok("https-only base URL", helper.includes("must be an https URL"), "no URL guard");
ok("Arc blockchain server-resolved", helper.includes("getNetworkConfig().circleBlockchain"), "hardcoded chain?");
ok("selectArcWallet helper", helper.includes("export function selectArcWallet"), "missing");
ok("never handles user private keys", !/privateKey|mnemonic|seedPhrase/i.test(helper), "key material referenced");

console.log("── proxy route ────────────");
for (const a of ["social-token", "email-token", "initialize", "wallets", "refresh"]) {
  ok(`action "${a}"`, proxy.includes(`"${a}"`), "missing action");
}
ok("rate-limited", proxy.includes('checkRateLimit(req, "session")'), "no rate limit");
ok("returning-user code passed through", proxy.includes("155106"), "code swallowed");
ok("never logs tokens", !/console\.(log|error)\([^)]*(userToken|encryptionKey|refreshToken)/i.test(proxy), "token may be logged");
ok("GET status probe only", proxy.includes("export async function GET"), "missing probe");

console.log("── server-signing gates ────────────");
ok("settle refuses USER_CONTROLLED", settle.includes("USER_CONTROLLED") && settle.includes("only its owner can sign"), "no settle gate");
ok("settle keeps EXTERNAL refusal", settle.includes("is an external (non-custodial) wallet"), "external gate changed");
ok("settle keeps no-fallback invariant", settle.includes("refusing to debit a shared default wallet"), "fallback invariant changed");
ok("scheduled refuses USER_CONTROLLED", scheduled.includes("USER_CONTROLLED"), "no scheduled gate");
ok("withGateway untouched", gateway.includes("withGateway"), "gateway changed");

console.log("── frontend panel ────────────");
ok("Google performLogin flow", panel.includes("performLogin") && panel.includes("GOOGLE"), "no Google flow");
ok("email verifyOtp flow", panel.includes("verifyOtp") && panel.includes("otpToken"), "no email flow");
ok("challenge execute", panel.includes(".execute(") && panel.includes("setAuthentication"), "no execute");
ok("links via circleAuth", panel.includes("circleAuth"), "no session link");
ok("returning-user short-circuit", panel.includes("CIRCLE_155106"), "no 155106 handling");
ok("userToken never in localStorage", !/localStorage\.setItem\([^)]*(userToken|encryptionKey)/i.test(panel) && !/localStorage\.getItem\([^)]*(userToken|encryptionKey)/i.test(panel), "credential persisted!");
ok("sessionStorage holds device tokens only", panel.includes("flarehq-circle-pending-login") && panel.includes("deviceToken"), "no redirect bridge");
ok("cancel path clears pending state", panel.includes("Cancel") && panel.includes("removeItem"), "no cancel");
ok("failure/cancel copy", panel.includes("Sign-in was cancelled") && panel.includes("not configured yet"), "no failure copy");
ok("browser-only SDK import", panel.includes("await import('@circle-fin/w3s-pw-web-sdk')"), "SDK may bundle server-side");
ok("no NEXT_PUBLIC secret misuse", !/NEXT_PUBLIC_.*SECRET/i.test(panel), "secret in public var");
ok("no userToken logging", !/console\.(log|error)\([^)]*userToken/i.test(panel), "userToken may be logged");

console.log("── consumer page ────────────");
ok("Google primary entry", consumerPage.includes("Continue with Google"), "missing");
ok("email primary entry", consumerPage.includes("Continue with email"), "missing");
ok("Circle panel wired", consumerPage.includes("CircleUserWallet") && consumerPage.includes("circleOpen"), "not wired");
ok("external connect preserved", consumerPage.includes("Connect a wallet") && consumerPage.includes("connectExisting"), "external flow changed");
ok("legacy creation preserved", consumerPage.includes("Create a FlareHQ wallet") && consumerPage.includes("createNewWallet"), "legacy entry removed");
  ok("legacy recovery removed from primary onboarding", !consumerPage.includes("Recover a legacy wallet with email"), "recovery still shown as primary option");
ok("link lands in app", consumerPage.includes('setWalletType(account.walletType ?? "USER_CONTROLLED")'), "link not wired");
ok("wallet switching untouched", consumerPage.includes("openWalletSwitch") && consumerPage.includes("completeWalletSwitch"), "switch flow changed");

console.log("── swap custody distinction ────────────");
ok("only EXTERNAL is self-custody", swapView.includes("(walletType ?? '').toUpperCase() === 'EXTERNAL'"), "swap gate changed");
ok("managed notice preserved", swapView.includes("Use a wallet you control"), "notice changed");

console.log("── schema / migration / env / docs ────────────");
ok("circleUserId unique in schema", schema.includes("circleUserId") && schema.includes("@unique"), "missing field");
ok("USER_CONTROLLED documented in schema", schema.includes("USER_CONTROLLED"), "missing comment");
ok("additive migration", migration.includes('ADD COLUMN "circleUserId"') && migration.includes("CREATE UNIQUE INDEX"), "migration wrong");
ok("CIRCLE_APP_ID documented", envExample.includes("CIRCLE_APP_ID"), "missing var");
ok("NEXT_PUBLIC_CIRCLE_APP_ID documented", envExample.includes("NEXT_PUBLIC_CIRCLE_APP_ID"), "missing var");
ok("NEXT_PUBLIC_GOOGLE_CLIENT_ID documented", envExample.includes("NEXT_PUBLIC_GOOGLE_CLIENT_ID"), "missing var");
ok("no secrets in .env.example additions", !/0x[0-9a-fA-F]{64}/.test(envExample), "possible secret!");
ok("SDK dependency installed", typeof pkg.dependencies["@circle-fin/w3s-pw-web-sdk"] === "string", "dep missing");
ok("console config doc exists", fs.existsSync(path.join(ROOT, "docs/consumer-circle-auth.md")), "doc missing");

console.log("── boundaries ────────────");
ok("merchant login untouched by Circle UC", !/circleAuth|USER_CONTROLLED|SocialLoginProvider/i.test(merchantLogin), "merchant login changed");
ok("merchant signup untouched by Circle UC", !/circleAuth|USER_CONTROLLED|SocialLoginProvider/i.test(merchantSignup), "merchant signup changed");
ok("payment router contract untouched", fs.existsSync(path.join(ROOT, "contracts/ArcFlarePaymentRouter.sol")), "contract missing");

console.log("── pure unit checks ────────────");
async function unit() {
  const { selectArcWallet, getUserControlledConfig } = await import("@/src/lib/circle/userControlled");
  const wallets = [
    { id: "a", address: "0x1111111111111111111111111111111111111111", blockchain: "ETH-SEPOLIA" },
    { id: "b", address: "0x2222222222222222222222222222222222222222", blockchain: "ARC-TESTNET" },
  ];
  ok("selectArcWallet prefers Arc", selectArcWallet(wallets as any, "ARC-TESTNET")?.id === "b", "wrong pick");
  ok("selectArcWallet falls back", selectArcWallet([wallets[0]] as any, "ARC-TESTNET")?.id === "a", "no fallback");
  ok("selectArcWallet null on empty", selectArcWallet([], "ARC-TESTNET") === null, "not null");

  const savedKey = process.env.CIRCLE_API_KEY;
  const savedApp = process.env.CIRCLE_APP_ID;
  process.env.CIRCLE_API_KEY = "TEST_API_KEY:dummy";
  delete process.env.CIRCLE_APP_ID;
  try {
    getUserControlledConfig();
    ok("fail-closed without CIRCLE_APP_ID", false, "did NOT throw");
  } catch (e: any) {
    ok("fail-closed without CIRCLE_APP_ID", e?.code === "CIRCLE_APP_ID_MISSING", String(e?.message ?? e).slice(0, 100));
  }
  delete process.env.CIRCLE_API_KEY;
  try {
    getUserControlledConfig();
    ok("fail-closed without CIRCLE_API_KEY", false, "did NOT throw");
  } catch (e: any) {
    ok("fail-closed without CIRCLE_API_KEY", e?.code === "CIRCLE_NOT_CONFIGURED", String(e?.message ?? e).slice(0, 100));
  }
  if (savedKey !== undefined) process.env.CIRCLE_API_KEY = savedKey;
  if (savedApp !== undefined) process.env.CIRCLE_APP_ID = savedApp;
}

unit().then(() => {
  console.log(`\nconsumer-circle-auth-tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("failures:", failures);
    process.exit(1);
  }
});
