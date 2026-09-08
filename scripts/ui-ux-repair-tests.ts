/**
 * ui-ux-repair-tests.ts
 *
 * FlareHQ UI/UX repair — focused regression tests covering:
 *   1. Homepage nav destinations — every navbar section link has a matching,
 *      unique `<section id="…">` target (no broken/hash-only links, no dup IDs).
 *   2. Desktop + mobile navigation — desktop section nav is present; the mobile
 *      hamburger + dropdown cover <lg so the 768–1023 px band is never a dead
 *      zone (previous bug: nav was lg-only while the hamburger was md-only).
 *   3. No manual wallet-address input — consumer sign-in must not ask the user
 *      to type/paste a wallet address as proof of ownership.
 *   4. WalletConnect / connector path — existing-wallet connect uses the real
 *      wagmi connector flow (useConnect/connectAsync) with the connected
 *      account address, never a typed string.
 *   5. Public marketplace stays public — browsing never forces login; only
 *      authenticated ACTIONS redirect through the returnTo gate.
 *   6. returnTo remains valid — login shim + merchant login honor returnTo,
 *      normalized to a same-origin relative path.
 *
 * Static, content-based proofs (mirrors phase2b-ux-tests.ts) — no server/DB/chain.
 * Run: npx tsx scripts/ui-ux-repair-tests.ts
 */

import fs from "fs";
import path from "path";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ": " + detail : ""}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

// ── 1. Homepage nav destinations ────────────────────────────────────────
const sections = ["system", "personas", "products", "agents", "developers"];
const homeFiles = [
  "src/components/home/SystemFlow.tsx",
  "src/components/home/PersonaTabs.tsx",
  "src/components/home/ProductGrid.tsx",
  "src/components/home/AgentRail.tsx",
  "src/components/home/DevSplit.tsx",
];
const homeSrc = homeFiles.map(read).join("\n");

console.log("\n[1] Homepage nav destinations");
for (const id of sections) {
  const hits = [...homeSrc.matchAll(new RegExp(`<section\\s+id=["']${id}["']`, "g"))].length;
  ok(`section target #${id} exists exactly once`, hits === 1, `found ${hits}`);
}

const navbarSrc = read("src/components/home/HomeNavbar.tsx");
// The nav renders a hash href from every SECTIONS entry (generic template),
// and each required section id is declared in that array.
const sectionsDecl = navbarSrc.split("const SECTIONS")[1].split("];")[0];
for (const id of sections) {
  const rendered = navbarSrc.includes("href={`#${id}`}");
  const declared = sectionsDecl.includes(`'${id}'`);
  ok(`navbar renders a hash link for #${id}`, declared && rendered, `declared=${declared} rendered=${rendered}`);
}

// ── 2. Desktop + mobile navigation (md dead-zone fix) ────────────────────
console.log("\n[2] Desktop & mobile navigation");
ok("desktop section nav present (lg+)", /hidden lg:flex[\s\S]*SECTIONS\.map/.test(navbarSrc), "");
ok("nav links carry hash hrefs", navbarSrc.includes("href={`#${id}`}"), "");
ok("scroll-to uses smooth scrollIntoView", navbarSrc.includes("scrollIntoView({ behavior: 'smooth'") || navbarSrc.includes("scrollIntoView({behavior: 'smooth'"), "");
ok("scroll-spy computes active section", navbarSrc.includes("setActive(current)"), "");
ok("toggle button carries aria-expanded", navbarSrc.includes("aria-expanded={open}"), "");
ok("toggle button carries aria-controls", navbarSrc.includes('aria-controls="home-menu"'), "");
ok("hamburger container is NOT md-only", !/className="flex md:hidden/.test(navbarSrc), "was 'flex md:hidden' — orphaned md band");
ok("hamburger container shows below lg", navbarSrc.includes('className="flex lg:hidden items-center gap-2"'), "");
ok("dropdown is NOT md-only", !/className="md:hidden/.test(navbarSrc), "was 'md:hidden'");
ok("dropdown shows below lg with id", navbarSrc.includes('id="home-menu"') && navbarSrc.includes('className="lg:hidden border-t'), "");
// ── 3. No manual wallet-address input ───────────────────────────────────
console.log("\n[3] No manual wallet-address input");
const consumerSrc = read("src/app/consumer/page.tsx");
ok("no 'I already have a wallet address' label", !consumerSrc.includes("I already have a wallet address"), "");
ok("no onboardingInput state", !consumerSrc.includes("onboardingInput"), "");
ok("no typed-address onboarding input", !/placeholder="0x\.\.\."/.test(consumerSrc), "");
ok("connect flow does not read a typed address", !/trimmed\.startsWith|onboardingInput\.trim/.test(consumerSrc), "");

// ── 4. WalletConnect / connector path ───────────────────────────────────
console.log("\n[4] WalletConnect / connector path");
ok("uses wagmi useConnect", consumerSrc.includes("useConnect"), "");
ok("uses connectAsync", consumerSrc.includes("connectAsync"), "");
ok("reads connected account address", consumerSrc.includes("address: connectedAddress") && consumerSrc.includes("useAccount()"), "");
ok("connector picker dedupes connectors", consumerSrc.includes("dedupeConnectors(connectors)"), "");
ok("sign challenge binds connected address", consumerSrc.includes("account: address as Address"), "");
ok("connect flow opens picker when nothing connected", consumerSrc.includes("setConnectPickerOpen(true)") && consumerSrc.includes("hasInjectedProvider()"), "");
ok("create-wallet path preserved", consumerSrc.includes("Create a FlareHQ wallet") && consumerSrc.includes("createNewWallet"), "");

// ── 5. Public marketplace stays public ──────────────────────────────────
console.log("\n[5] Public marketplace remains public");
const marketplaceSrc = read("src/app/marketplace/page.tsx");
ok("marketplace imports returnTo gate", marketplaceSrc.includes("deriveReturnTo") && marketplaceSrc.includes("loginRedirectUrl"), "");
ok("marketplace gates only authenticated actions", /requireAuth[\s\S]{0,200}loginRedirectUrl\(deriveReturnTo/.test(marketplaceSrc), "");
const agentDiscoverySrc = read("src/components/marketplace/AgentDiscovery.tsx");
ok("agent discovery signin honors returnTo", agentDiscoverySrc.includes("/login?returnTo"), "");

// ── 6. returnTo remains valid ───────────────────────────────────────────
console.log("\n[6] returnTo flow");
const returnToSrc = read("src/lib/auth/returnTo.ts");
ok("returnTo helpers exported", returnToSrc.includes("export function deriveReturnTo") && returnToSrc.includes("export function loginRedirectUrl"), "");
ok("returnTo normalized to same-origin relative path", returnToSrc.includes('returnTo.startsWith("/")'), "");
const loginShim = read("src/app/login/page.tsx");
ok("login shim reads returnTo", loginShim.includes('get("returnTo")'), "");
ok("login shim forwards same-origin only", loginShim.includes('raw.startsWith("/")'), "");
const merchantLogin = read("src/app/merchant/login/page.tsx");
ok("merchant login reads returnTo", merchantLogin.includes("returnTo"), "");

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}