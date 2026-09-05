/**
 * multicurrency-tests.ts
 *
 * Track B — Multicurrency Phase 1 (additive/read-model foundation).
 * Unit + static proofs (no dev server / DB / chain required):
 *   B1  resolver: symbol lookup, address lookup, unsupported rejection,
 *       symbol/address mismatch rejection, legacy NULL -> USDC.
 *   B2  schema: additive tokenAddress on PaymentLog + AgentLedgerEntry,
 *       currency/token fields untouched, migration is additive-only.
 *   B3  initialization: accepts USDC|EURC (+optional token address), resolves
 *       through the canonical resolver, persists symbol + tokenAddress,
 *       returns resolved token identity.
 *   B4  read paths: verify / all / history / consumer activity expose token
 *       identity with legacy NULL defaulting to USDC.
 *   B5  every execution path remains USDC-only — the settlement engines
 *       (x402/CCTP/payroll/nano/scheduled) settle USDC and never move EURC.
 *       The two files that now carry explicit Phase 1 EURC fail-safes
 *       (payments/settle, payroll) are asserted to STILL hardcode USDC and
 *       to gate EURC rows, not to have gained EURC execution.
 *   B6  checkout data path carries the resolved token without changing the
 *       USDC transfer and without a fabricated EURC payment path.
 *   B7  client-safe token metadata (supportedTokens is dependency-free).
 *   B8  EURC fail-safe gates — Phase 1 safety correction. An EURC invoice
 *       row may exist (read-model) but must be refused by every USDC-only
 *       execution/verification path before any transfer/verification can
 *       happen, and Checkout must not expose an actionable EURC pay button:
 *       verify-onchain / settle / cctp-settle reject EURC rows with a
 *       Phase 2 message; payroll fund rejects an EURC token parameter;
 *       CheckoutWidget disables Pay for EURC invoices.
 *
 * Run: npx tsx scripts/multicurrency-tests.ts
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { pathToFileURL } from "url";
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

const USDC = SUPPORTED_TOKENS.USDC.address;
const EURC = SUPPORTED_TOKENS.EURC.address;

async function main() {
  console.log("\n[B1] resolver — symbol lookup");
  const usdc = resolveCurrency({ currency: "USDC" });
  ok("USDC symbol resolves to canonical address + 6 decimals", usdc.symbol === "USDC" && usdc.address === USDC && usdc.decimals === 6, JSON.stringify(usdc));
  const eurc = resolveCurrency({ currency: "EURC" });
  ok("EURC symbol resolves to canonical address + 6 decimals", eurc.symbol === "EURC" && eurc.address === EURC && eurc.decimals === 6, JSON.stringify(eurc));
  ok("symbol lookup is case-insensitive", resolveCurrency({ currency: "eurc" }).symbol === "EURC" && resolveCurrency({ currency: "usdc" }).symbol === "USDC");
  ok("symbol lookup trims whitespace", resolveCurrency({ currency: "  EURC " }).address === EURC);
  ok("resolveRowCurrency resolves from symbol", resolveRowCurrency({ currency: "EURC" }).address === EURC);

  console.log("\n[B1] resolver — address lookup");
  const byAddr = resolveCurrency({ tokenAddress: EURC });
  ok("explicit tokenAddress resolves to the supported token", byAddr.symbol === "EURC" && byAddr.address === EURC && byAddr.decimals === 6, JSON.stringify(byAddr));
  ok("address lookup is case-insensitive", resolveCurrency({ tokenAddress: USDC.toLowerCase() }).symbol === "USDC");
  ok("matching symbol+address pair is accepted", resolveCurrency({ currency: "USDC", tokenAddress: USDC }).address === USDC);

  console.log("\n[B1] resolver — unsupported token rejection");
  ok("unsupported symbol (USDT) throws", throws(() => resolveCurrency({ currency: "USDT" })));
  ok("arbitrary ERC-20 address throws (never silently accepted)", throws(() => resolveCurrency({ tokenAddress: "0x1111111111111111111111111111111111111111" })));
  ok("garbage tokenAddress throws", throws(() => resolveCurrency({ tokenAddress: "not-an-address" })));
  ok("tokenAddressFor throws on unsupported symbol", throws(() => tokenAddressFor("USDT")));
  ok("tokenAddressFor('USDC') / ('EURC') canonical", tokenAddressFor("USDC") === USDC && tokenAddressFor("EURC") === EURC);

  console.log("\n[B1] resolver — symbol/address mismatch rejection");
  ok("USDC symbol + EURC address throws", throws(() => resolveCurrency({ currency: "USDC", tokenAddress: EURC })));
  ok("EURC symbol + USDC address throws", throws(() => resolveCurrency({ currency: "EURC", tokenAddress: USDC })));

  console.log("\n[B1] resolver — legacy NULL -> USDC");
  const legacy = resolveCurrency({ currency: null, tokenAddress: null });
  ok("NULL currency + NULL tokenAddress -> USDC", legacy.symbol === "USDC" && legacy.address === USDC && legacy.decimals === 6, JSON.stringify(legacy));
  ok("empty ref (legacy write shape) -> USDC", resolveCurrency({}).symbol === "USDC" && resolveCurrency({}).address === USDC);
  ok("legacy row: currency=USDC, tokenAddress NULL -> USDC", resolveRowCurrency({ currency: "USDC", tokenAddress: null }).address === USDC);
  ok("legacy row with EURC currency + NULL address resolves EURC identity (read-model)", resolveRowCurrency({ currency: "EURC", tokenAddress: null }).symbol === "EURC");
  const resolveSrc = read("src/lib/tokens/resolveCurrency.ts");
  ok("resolver reuses supportedTokens (no duplicated token table)", resolveSrc.includes("from './supportedTokens'"));
  ok("resolver hardcodes no token addresses", !resolveSrc.includes("0x3600") && !resolveSrc.includes("0x89B508"));

  console.log("\n[B2] schema — additive only");
  const schema = read("prisma/schema.prisma");
  const mig = read("prisma/migrations/20260905040000_add_payment_token_address/migration.sql");
  ok("PaymentLog.tokenAddress added (nullable)", /\n\s*tokenAddress\s+String\?/.test(schema.slice(schema.indexOf("model PaymentLog"), schema.indexOf("model PaymentLog") + 2000)));
  ok("AgentLedgerEntry.tokenAddress added (nullable)", /\n\s*tokenAddress\s+String\?/.test(schema.slice(schema.indexOf("model AgentLedgerEntry"), schema.indexOf("model AgentLedgerEntry") + 2000)));
  ok("PaymentLog.currency untouched (non-nullable)", /currency\s+String\n/.test(schema.slice(schema.indexOf("model PaymentLog"), schema.indexOf("model PaymentLog") + 2000)));
  ok("AgentLedgerEntry.token field untouched with USDC default", /token\s+String\s+@default\("USDC"\)/.test(schema.slice(schema.indexOf("model AgentLedgerEntry"), schema.indexOf("model AgentLedgerEntry") + 2000)));
  ok("migration adds both columns", mig.includes('ALTER TABLE "PaymentLog" ADD COLUMN "tokenAddress" TEXT;') && mig.includes('ALTER TABLE "agent_ledger_entries" ADD COLUMN "tokenAddress" TEXT;'));
  ok("migration is additive — no DROP/DELETE/UPDATE/TRUNCATE", !/DROP|DELETE|UPDATE|TRUNCATE/i.test(mig));
  ok("no destructive backfill in migration", !mig.includes("SET") && !mig.includes("BACKFILL"));

  console.log("\n[B3] initialization — accepts USDC | EURC via canonical resolver");
  const validation = read("src/lib/validation.ts");
  const init = read("src/app/api/payments/initialize/route.ts");
  ok("InitializeSchema accepts USDC|EURC", validation.includes("z.enum(['USDC', 'EURC'])"));
  ok("currency defaults to USDC (legacy callers unchanged)", validation.includes(".default('USDC')"));
  ok("optional tokenAddress validated as a 0x address", validation.includes("tokenAddress: scaAddress.optional()"));
  ok("route resolves the pair through the canonical resolver", init.includes("resolveCurrency({ currency, tokenAddress })"));
  ok("route persists canonical symbol", init.includes("currency: token.symbol"));
  ok("route persists canonical tokenAddress", init.includes("tokenAddress: token.address"));
  ok("response returns resolved token identity", /token:\s*\{\s*symbol:\s*token\.symbol,\s*address:\s*token\.address,\s*decimals:\s*token\.decimals,\s*\}/.test(init));
  ok("route documents Phase 1 scope (no EURC settlement)", init.includes("does NOT enable EURC settlement"));

  console.log("\n[B4] read paths — canonical token identity + legacy defaulting");
  const verify = read("src/app/api/payments/verify/[reference]/route.ts");
  const all = read("src/app/api/payments/all/route.ts");
  const history = read("src/app/api/payments/history/route.ts");
  const activity = read("src/app/api/consumer/activity/route.ts");
  for (const [name, src] of [["verify", verify], ["payments/all", all], ["history", history], ["consumer/activity", activity]] as const) {
    ok(`${name}: resolves row currency via canonical resolver`, src.includes("resolveRowCurrency("));
    ok(`${name}: exposes token identity`, /token,/.test(src) || /token:\s*\{/.test(src));
    ok(`${name}: unsupported legacy data degrades to USDC instead of failing the read`, src.includes("tokenAddressFor('USDC')") || src.includes('tokenAddressFor("USDC")'));
  }
  ok("verify keeps legacy response shape (status/amount/reference intact)", verify.includes("reference:") && verify.includes("amount:") && verify.includes("status:"));
  ok("history keeps legacy per-row fields intact", history.includes("currency: log.currency") && history.includes("amount: log.amount"));

  console.log("\n[B5] execution paths stay USDC-only (Phase 2 excluded)");
  const changed = execSync("git diff --name-only", { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  // Execution engines with no EURC input anywhere must remain byte-untouched.
  const protectedPaths = [
    "src/lib/x402.ts",
    "src/app/api/x402",
    "src/lib/circle",
    "src/lib/settlementRecovery",
    "src/app/api/nano",
    "src/app/api/scheduled",
  ];
  for (const p of protectedPaths) {
    ok(`untouched: ${p}`, !changed.some((f) => f.startsWith(p)));
  }
  // payments/settle + payroll legitimately changed: they now carry explicit
  // Phase 1 EURC fail-safe gates. Assert they STILL settle USDC and gained no
  // EURC execution path (see B8 for the gate assertions).
  const settleSrc = read("src/app/api/payments/settle/route.ts");
  ok("settle still moves USDC (USDC_ARC token hardcoded)", settleSrc.includes("tokenAddress: USDC_ARC"));
  ok("settle gained no EURC transfer token", !settleSrc.includes("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"));
  const payrollSrc = read("src/lib/payroll/payrollExecution.ts");
  ok("payroll x402 still defaults to USDC", payrollSrc.includes("token ?? getUsdcAddress()"));
  ok("payroll gained no EURC transfer token", !payrollSrc.includes("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"));
  const checkout = read("src/components/CheckoutWidget.tsx");
  ok("checkout widget does not import the resolver (transfer path unchanged)", !checkout.includes("resolveCurrency"));
  ok("checkout transfer still signs USDC explicitly", checkout.includes("USDC_CONTRACT") && checkout.includes("USDC_DECIMALS"));

  console.log("\n[B8] EURC fail-safe gates (Phase 1 safety correction)");
  const verifyOnchain = read("src/app/api/payments/verify-onchain/route.ts");
  const cctpSettle = read("src/app/api/payments/cctp-settle/route.ts");
  // B8.1 — every USDC-only settlement/verification path refuses EURC rows
  // BEFORE any transfer/verification work, with a user-visible Phase 2 message.
  for (const [name, src] of [
    ["verify-onchain", verifyOnchain],
    ["settle", settleSrc],
    ["cctp-settle", cctpSettle],
  ] as const) {
    ok(`${name} gates EURC rows before settlement`, src.includes("toUpperCase() === 'EURC'"));
    ok(`${name} gate is user-visible (Phase 2 message)`, /Phase 2/.test(src));
    ok(`${name} never executes EURC (no EURC address in transfer code)`, !src.includes("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"));
  }
  // The gates must be early enough: verify-onchain rejects before it reads the
  // receipt; settle rejects before the payer-control/expiry/lock stages could
  // classify the row as something else. Assert gate precedes the merchant
  // recipient requirement in verify-onchain (i.e., fails BEFORE verification).
  ok("verify-onchain EURC gate precedes receipt verification", verifyOnchain.indexOf("toUpperCase() === 'EURC'") < verifyOnchain.indexOf("getTransactionReceipt"));
  // B8.2 — Checkout must not expose an actionable EURC transfer.
  ok("widget disables Pay for EURC invoices", checkout.includes("disabled={isEurc ||") && checkout.includes("isEurc ? 'EURC not yet supported'"));
  ok("widget shows a Phase 2 notice for EURC invoices", checkout.includes("EURC support coming in Phase 2"));
  // B8.3 — payroll x402 cannot accidentally execute EURC before Phase 2.
  ok("payroll x402 rejects an EURC token parameter", payrollSrc.includes("resolvedToken?.symbol === 'EURC'"));
  // B8.4 — EURC init (read-model) is untouched by the gates.
  ok("EURC initialization still accepted (read-model)", init.includes("currency: token.symbol") && validation.includes("z.enum(['USDC', 'EURC'])"));

  console.log("\n[B6] checkout data path — carries resolved token, no fake EURC path");
  ok("verify response token flows into CheckoutWidget's PaymentLogData", checkout.includes("token?: { symbol: string; address: string; decimals: number } | null;"));
  ok("widget documents the carried-but-not-used Phase 1 contract", checkout.includes("CARRIED but NOT USED"));
  const verifyHook = read("src/components/checkout/usePaymentVerify.ts");
  ok("checkout bootstrap passes the API payload (incl. token) through untouched", verifyHook.includes("setPayment(result.data)"));
  ok("no EURC/flexible contract address in the checkout transfer call", checkout.includes("address: USDC_CONTRACT as `0x${string}`") && !checkout.includes("payment.token?.address") && !checkout.includes("payment.token.address"));

  console.log("\n[B7] client-safe token metadata");
  const tokensSrc = read("src/lib/tokens/supportedTokens.ts");
  ok("supportedTokens.ts is dependency-free (no imports/require, browser + server safe)", !/\bimport\b/.test(tokensSrc) && !tokensSrc.includes("require("));
  ok("registry contains only symbol/address/decimals presentation metadata", tokensSrc.includes("symbol") && tokensSrc.includes("address") && tokensSrc.includes("decimals"));
  ok("registry defines exactly USDC + EURC at 6 decimals", Object.keys(SUPPORTED_TOKENS).sort().join(",") === "EURC,USDC" && SUPPORTED_TOKENS.USDC.decimals === 6 && SUPPORTED_TOKENS.EURC.decimals === 6);
  // Live proof the module evaluates in an isolated ESM context (no server deps).
  const mod = await import(pathToFileURL(path.join(root, "src/lib/tokens/supportedTokens.ts")).href);
  ok("module imports cleanly and exports the registry + lookups", !!mod.SUPPORTED_TOKENS && mod.getTokenBySymbol("USDC").address === SUPPORTED_TOKENS.USDC.address);

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
