/**
 * multicurrency-safety-tests.ts
 *
 * Isolated Multicurrency safety-cleanup regression suite. Targets the three
 * LEGACY CCTP execution paths that can accept/derive an EURC-labelled payment
 * yet still execute USDC:
 *
 *   1. src/app/api/payments/detect            (POST /api/payments/detect)
 *   2. src/app/api/settle-cross-chain         (POST /api/settle-cross-chain)
 *   3. src/app/api/webhooks/circle            (autoSettleV2 on Circle V2 webhook)
 *
 * The invariant this proves, for EACH path:
 *   - USDC continues to work (the USDC CCTP mint path is retained).
 *   - EURC is rejected/ignored.
 *   - rejection happens BEFORE any mint/settlement ledger side-effect.
 *   - no client-supplied override can bypass the token restriction.
 *   - the existing authentication / webhook-signature guards are unchanged.
 *
 * Unit + static proofs only (no dev server / DB / chain / real funds). The
 * routes resolve currency through the SAME canonical resolver the Phase 1
 * read-model uses (`resolveCurrency` / `resolveRowCurrency`), so the live
 * resolver checks below prove what the routes' gates will do at runtime.
 *
 * Run: npx tsx scripts/multicurrency-safety-tests.ts
 */

import fs from "fs";
import path from "path";
import {
  resolveCurrency,
  resolveRowCurrency,
  tokenAddressFor,
} from "@/lib/tokens/resolveCurrency";
import { SUPPORTED_TOKENS } from "@/lib/tokens/supportedTokens";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const USDC_ADDR = SUPPORTED_TOKENS.USDC.address;
const EURC_ADDR = SUPPORTED_TOKENS.EURC.address;

async function main() {
  // ── Live resolver behaviour the routes rely on ────────────────────────────
  console.log("\n[L1] resolver semantics drive every gate in this track");
  ok("EURC resolves to EURC (~guards' `symbol !== 'USDC'` rejects it)",
    resolveCurrency({ currency: "EURC" }).symbol === "EURC", JSON.stringify(resolveCurrency({ currency: "EURC" })));
  ok("USDC resolves to USDC (routes accept it)",
    resolveCurrency({ currency: "USDC" }).symbol === "USDC");
  ok("null/empty currency defaults to USDC (legacy callers keep working)",
    resolveCurrency({ currency: null }).symbol === "USDC");
  ok("row resolver: USDC row -> USDC", resolveRowCurrency({ currency: "USDC", tokenAddress: USDC_ADDR }).symbol === "USDC");
  ok("row resolver: USDC symbol + EURC token is a MISMATCH (cannot swap token identity)",
    throws(() => resolveRowCurrency({ currency: "USDC", tokenAddress: EURC_ADDR })));
  ok("row resolver: EURC row resolves to EURC", resolveRowCurrency({ currency: "EURC", tokenAddress: EURC_ADDR }).symbol === "EURC");
  ok("tokenAddressFor('USDC') is the canonical USDC address (persisted on writes)",
    tokenAddressFor("USDC") === USDC_ADDR);

  // ── 1. /api/payments/detect ───────────────────────────────────────────────
  console.log("\n[P1] payments/detect");
  const detect = read("src/app/api/payments/detect/route.ts");
  ok("gates EURC before any ledger write", detect.indexOf("EURC SAFETY GATE") < detect.indexOf("prisma.paymentLog.create"));
  ok("gates EURC before any mint", detect.indexOf("EURC SAFETY GATE") < detect.indexOf("mintOnArc(message, attestation)"));
  ok("restricts accepted currency to USDC via canonical resolver",
    detect.includes("resolveCurrency({ currency: currency ?? 'USDC' })") && detect.includes("if (detectCurrency.symbol !== 'USDC')"));
  ok("write always records the enforced (post-gate) USDC symbol, never a raw override",
    detect.includes("currency: detectCurrency.symbol"));
  ok("write persists the canonical USDC token address", detect.includes("tokenAddress: tokenAddressFor('USDC')"));
  ok("USDC behavior preserved (still polls + mints)",
    detect.includes("pollForAttestation(messageHash)") && detect.includes("mintOnArc(message, attestation)"));
  ok("external API-key auth unchanged", detect.includes("export const POST = withApiKey(detectHandler);"));
  ok("no EURC execution address in transfer code", !detect.includes(EURC_ADDR));

  // ── 2. /api/settle-cross-chain ────────────────────────────────────────────
  console.log("\n[P2] settle-cross-chain");
  const xc = read("src/app/api/settle-cross-chain/route.ts");
  ok("gates before any settlement row write", xc.indexOf("EURC SAFETY GATE") < xc.indexOf("POLLING_CIRCLE_TESTNET_IRIS_API"));
  ok("gates before any mint (receiveMessage)", xc.indexOf("EURC SAFETY GATE") < xc.indexOf("functionName: 'receiveMessage'"));
  ok("resolves currency/token from the DB row, not the client", xc.includes("resolveRowCurrency(paymentRow)"));
  ok("request body carries no currency override field",
    /const\s*\{\s*reference,\s*messageHash,\s*rawMessage\s*\}\s*=\s*await request\.json\(\)/.test(xc)
    && !/\{\s*[^}]*\bcurrency\b[^}]*\}\s*=\s*await request\.json\(\)/.test(xc));
  ok("internal-key authorization unchanged (auth precedes the gate)",
    xc.indexOf("isInternalServiceCall") < xc.indexOf("record.active === true")
    && xc.indexOf("isInternalServiceCall") < xc.indexOf("EURC SAFETY GATE"));
  ok("USDC behavior preserved (still redeems + marks settled)",
    xc.includes("functionName: 'receiveMessage'") && xc.includes("REDEEMED_AND_MINTED"));
  ok("no EURC execution address in transfer code", !xc.includes(EURC_ADDR));

  // ── 3. Circle webhook autoSettleV2 ────────────────────────────────────────
  console.log("\n[P3] webhooks/circle (autoSettleV2)");
  const wh = read("src/app/api/webhooks/circle/route.ts");
  ok("webhook remains signature-authenticated", wh.includes("verifyCircleWebhookSignature(rawBody, signature)"));
  ok("ignores non-USDC transfer before any ledger write",
    wh.indexOf("EURC SAFETY GATE") < wh.indexOf("prisma.paymentLog.create"));
  ok("ignores non-USDC before any auto-settle mint",
    wh.indexOf("EURC SAFETY GATE") < wh.indexOf("autoSettleV2(") && wh.indexOf("if (messageHash && isUsdc)") < wh.indexOf("autoSettleV2("));
  ok("non-USDC path is explicitly ignored (else-if branch)", wh.includes("else if (messageHash && !isUsdc)"));
  ok("row write hardcodes USDC + canonical token address",
    wh.includes("currency: 'USDC'") && wh.includes("tokenAddress: tokenAddressFor('USDC')"));
  ok("defense-in-depth gate inside autoSettleV2 before any mint",
    wh.indexOf("rowIsUsdc") < wh.indexOf("pollForAttestation(messageHash)")
    && wh.indexOf("rowIsUsdc") < wh.indexOf("mintOnArc(message, attestation)"));
  ok("USDC behavior preserved (still polls + mints + marks settled)",
    wh.includes("pollForAttestation(messageHash)") && wh.includes("mintOnArc(message, attestation)") && wh.includes("REDEEMED_AND_MINTED"));
  ok("no EURC execution address in transfer code", !wh.includes(EURC_ADDR));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();