/**
 * multicurrency-tests.ts
 *
 * FlareHQ Multicurrency — durable layered regression suite.
 * Unit + static proofs (no dev server / DB / chain required).
 *
 * This file used to be the Phase-1-only suite and carried Phase-1 assertions
 * that intentionally conflict with completed Phase 2A/2B behavior (USDC-only
 * settlement engines, EURC fail-safe gates, disabled EURC checkout). Those
 * obsolete assertions are REMOVED here — the implementation was not weakened
 * to satisfy old tests. Each layer below asserts the CURRENT contract:
 *
 *   Phase 1 — foundation (durable):
 *     P1  supported token registry + canonical resolver + legacy NULL -> USDC.
 *     P1  additive schema / read-model (tokenAddress nullable, currency/token
 *         fields untouched, migrations additive-only).
 *     P1  initialization accepts USDC|EURC via the resolver and persists the
 *         canonical identity; read paths expose it with legacy USDC default.
 *   Phase 2A — native settlement + verification:
 *     2A  settlement resolves the invoice token; settle Path B is token-native
 *         (resolved address/decimals, both transfer branches), guards
 *         unchanged (payer-control 403, expiry, atomic lock, 409).
 *     2A  token mismatch rejection + decimals driven by the resolver.
 *     2A  CCTP stays explicitly USDC-only (settle Path A + cctp-settle).
 *     2A  verify-onchain matches ONLY the invoice token; fee leg token-native.
 *   Phase 2B — user-facing USDC+EURC experience:
 *     2B  Checkout transfers the resolved token (USDC fallback for legacy
 *         rows), Pay enabled for EURC, CCTP tab blocked for EURC.
 *     2B  payment creation (merchant link + dashboard Currency selector).
 *     2B  consumer token selection (send/request + balance route + labels).
 *   Phase 2C — Nano / Scheduled / Payroll token semantics:
 *     2C  mixed-token batch splitting, per-row/per-pair token execution,
 *         single-token payroll batches, x402 fund path stays USDC-only,
 *         idempotency/retry preserved.
 *   Phase 2D — Ledger token identity (static only here; live-DB proofs live
 *     in scripts/phase2d-ledger-tests.ts):
 *     2D  canonical identity helpers, explicit writer identity, no FX,
 *         byToken readers, unchanged dedupe keys.
 *   Legacy safety — detect / settle-cross-chain / webhook stay USDC-only:
 *     S   EURC rejected/ignored BEFORE any mint/ledger side-effect, USDC
 *         behavior + auth guards preserved.
 *
 * Deep per-phase proofs live in the dedicated suites (all must stay green):
 *   scripts/phase2a-settlement-tests.ts
 *   scripts/phase2b-ux-tests.ts
 *   scripts/multicurrency-phase2c-tests.ts
 *   scripts/phase2d-ledger-tests.ts   (live DB)
 *   scripts/multicurrency-safety-tests.ts
 *
 * Run: npx tsx scripts/multicurrency-tests.ts
 */

import fs from "fs";
import path from "path";
import { parseUnits } from "viem";
import { pathToFileURL } from "url";
import {
  resolveCurrency,
  resolveRowCurrency,
  tokenAddressFor,
} from "@/lib/tokens/resolveCurrency";
import { SUPPORTED_TOKENS } from "@/lib/tokens/supportedTokens";
import {
  SUPPORTED_CURRENCIES,
  isCctpSupported,
  normalizeClientSymbol,
  getClientToken,
  resolveClientToken,
  formatTokenAmount,
  shortTokenAddress,
  USDC_CONTRACT,
  USDC_DECIMALS,
} from "@/lib/tokens/clientTokens";
import {
  groupNanoRowsByToken,
  resolveNanoToken,
} from "@/lib/nanopayment";
import {
  buildDedupeKey,
  resolveLedgerToken,
  usdcLedgerIdentity,
} from "@/lib/ledger/ledgerService";

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
const EURC_LITERAL = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const OTHER = "0x1111111111111111111111111111111111111111";

// Mirror of the verify-onchain matching rule (address + decimals + recipient
// + amount), driven by the RESOLVED invoice token — not by a constant.
function matchesInvoiceToken(args: {
  invoice: { currency?: string | null; tokenAddress?: string | null };
  logAddress: string;
  logTo: string;
  logValue: bigint;
  merchant: string;
  amount: string;
}): boolean {
  const token = resolveRowCurrency({
    currency: args.invoice.currency ?? null,
    tokenAddress: args.invoice.tokenAddress ?? null,
  });
  if (args.logAddress.toLowerCase() !== token.address.toLowerCase()) return false;
  if (args.logTo.toLowerCase() !== args.merchant.toLowerCase()) return false;
  return args.logValue >= parseUnits(args.amount, token.decimals);
}

async function main() {
  const MERCHANT = "0x902C565bE31c146a79350387C1f77d6896814B58";
  const AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  // ── Phase 1: registry + resolver (durable) ──────────────────────────────
  console.log("\n[Phase 1] registry — supported token table");
  ok("registry defines exactly USDC + EURC at 6 decimals", Object.keys(SUPPORTED_TOKENS).sort().join(",") === "EURC,USDC" && SUPPORTED_TOKENS.USDC.decimals === 6 && SUPPORTED_TOKENS.EURC.decimals === 6);
  ok("USDC and EURC have distinct canonical addresses", USDC !== EURC);
  ok("tokenAddressFor('USDC') / ('EURC') canonical", tokenAddressFor("USDC") === USDC && tokenAddressFor("EURC") === EURC);
  const tokensSrc = read("src/lib/tokens/supportedTokens.ts");
  ok("supportedTokens.ts is dependency-free (no imports/require, browser + server safe)", !/\bimport\b/.test(tokensSrc) && !tokensSrc.includes("require("));
  const mod = await import(pathToFileURL(path.join(root, "src/lib/tokens/supportedTokens.ts")).href);
  ok("module imports cleanly and exports the registry + lookups", !!mod.SUPPORTED_TOKENS && mod.getTokenBySymbol("USDC").address === SUPPORTED_TOKENS.USDC.address);

  console.log("\n[Phase 1] resolver — lookup, rejection, legacy default");
  ok("USDC symbol resolves to canonical address + 6 decimals", resolveCurrency({ currency: "USDC" }).address === USDC && resolveCurrency({ currency: "USDC" }).decimals === 6);
  ok("EURC symbol resolves to canonical address + 6 decimals", resolveCurrency({ currency: "EURC" }).address === EURC && resolveCurrency({ currency: "EURC" }).decimals === 6);
  ok("symbol lookup is case-insensitive + trims whitespace", resolveCurrency({ currency: "eurc" }).symbol === "EURC" && resolveCurrency({ currency: "  EURC " }).address === EURC);
  ok("explicit tokenAddress resolves to the supported token", resolveCurrency({ tokenAddress: EURC }).symbol === "EURC" && resolveCurrency({ tokenAddress: USDC.toLowerCase() }).symbol === "USDC");
  ok("matching symbol+address pair is accepted", resolveCurrency({ currency: "USDC", tokenAddress: USDC }).address === USDC);
  ok("unsupported symbol (USDT) throws", throws(() => resolveCurrency({ currency: "USDT" })));
  ok("arbitrary ERC-20 address throws (never silently accepted)", throws(() => resolveCurrency({ tokenAddress: OTHER })));
  ok("garbage tokenAddress throws", throws(() => resolveCurrency({ tokenAddress: "not-an-address" })));
  ok("tokenAddressFor throws on unsupported symbol", throws(() => tokenAddressFor("USDT")));
  ok("USDC symbol + EURC address throws (never mixed)", throws(() => resolveCurrency({ currency: "USDC", tokenAddress: EURC })));
  ok("EURC symbol + USDC address throws (never mixed)", throws(() => resolveCurrency({ currency: "EURC", tokenAddress: USDC })));
  ok("NULL currency + NULL tokenAddress -> USDC (legacy default)", resolveCurrency({ currency: null, tokenAddress: null }).symbol === "USDC");
  ok("empty ref (legacy write shape) -> USDC", resolveCurrency({}).symbol === "USDC" && resolveCurrency({}).address === USDC);
  ok("legacy row: currency=USDC, tokenAddress NULL -> USDC", resolveRowCurrency({ currency: "USDC", tokenAddress: null }).address === USDC);
  ok("read-model row with EURC currency + NULL address resolves EURC identity", resolveRowCurrency({ currency: "EURC", tokenAddress: null }).symbol === "EURC");
  const resolveSrc = read("src/lib/tokens/resolveCurrency.ts");
  ok("resolver reuses supportedTokens (no duplicated token table)", resolveSrc.includes("from './supportedTokens'"));
  ok("resolver hardcodes no token addresses", !resolveSrc.includes("0x3600") && !resolveSrc.includes("0x89B508"));

  console.log("\n[Phase 1] schema — additive tokenAddress, legacy fields untouched");
  const schema = read("prisma/schema.prisma");
  const mig1 = read("prisma/migrations/20260905040000_add_payment_token_address/migration.sql");
  ok("PaymentLog.tokenAddress added (nullable)", /\n\s*tokenAddress\s+String\?/.test(schema.slice(schema.indexOf("model PaymentLog"), schema.indexOf("model PaymentLog") + 2000)));
  ok("AgentLedgerEntry.tokenAddress added (nullable)", /\n\s*tokenAddress\s+String\?/.test(schema.slice(schema.indexOf("model AgentLedgerEntry"), schema.indexOf("model AgentLedgerEntry") + 2000)));
  // CRLF-tolerant: the file uses \r\n, so a bare `String\n` never matches.
  ok("PaymentLog.currency untouched (non-nullable String)", /currency\s+String\r?\n/.test(schema.slice(schema.indexOf("model PaymentLog"), schema.indexOf("model PaymentLog") + 2000)) && !/currency\s+String\?/.test(schema));
  ok("AgentLedgerEntry.token field untouched with USDC default", /token\s+String\s+@default\("USDC"\)/.test(schema.slice(schema.indexOf("model AgentLedgerEntry"), schema.indexOf("model AgentLedgerEntry") + 2000)));
  ok("migration adds both columns", mig1.includes('ALTER TABLE "PaymentLog" ADD COLUMN "tokenAddress" TEXT;') && mig1.includes('ALTER TABLE "agent_ledger_entries" ADD COLUMN "tokenAddress" TEXT;'));
  ok("migration is additive — no DROP/DELETE/UPDATE/TRUNCATE", !/DROP|DELETE|UPDATE|TRUNCATE/i.test(mig1));
  ok("no destructive backfill in migration", !mig1.includes("SET") && !mig1.includes("BACKFILL"));

  console.log("\n[Phase 1] initialization — accepts USDC | EURC via canonical resolver");
  const validation = read("src/lib/validation.ts");
  const init = read("src/app/api/payments/initialize/route.ts");
  ok("InitializeSchema accepts USDC|EURC", validation.includes("z.enum(['USDC', 'EURC'])"));
  ok("currency defaults to USDC (legacy callers unchanged)", validation.includes(".default('USDC')"));
  ok("optional tokenAddress validated as a 0x address", validation.includes("tokenAddress: scaAddress.optional()"));
  ok("route resolves the pair through the canonical resolver", init.includes("resolveCurrency({ currency, tokenAddress })"));
  ok("route persists canonical symbol", init.includes("currency: token.symbol"));
  ok("route persists canonical tokenAddress", init.includes("tokenAddress: token.address"));
  ok("response returns resolved token identity", /token:\s*\{\s*symbol:\s*token\.symbol,\s*address:\s*token\.address,\s*decimals:\s*token\.decimals,\s*\}/.test(init));
  // NOTE: the old assertion on the Phase-1-only comment ("does NOT enable
  // EURC settlement") was removed — Phase 2A/2B enabled native EURC
  // settlement and verification, so that comment is superseded.

  console.log("\n[Phase 1] read paths — canonical token identity + legacy defaulting");
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

  console.log("\n[Phase 1] client-safe token metadata layer");
  const clientTokens = read("src/lib/tokens/clientTokens.ts");
  ok("client layer imports the canonical registry (no second token table)", clientTokens.includes("from './supportedTokens'"));
  ok("client layer hardcodes no token addresses", !clientTokens.includes("0x3600") && !clientTokens.includes("0x89B508"));
  ok("client layer hardcodes no decimals", !/decimals\s*[:=]\s*6/.test(clientTokens));
  ok("client layer exposes exactly USDC + EURC", [...SUPPORTED_CURRENCIES].sort().join(",") === "EURC,USDC");
  ok("legacy aliases derive from the registry", USDC_CONTRACT === USDC && USDC_DECIMALS === 6);
  ok("CCTP supported for USDC, unavailable for EURC/unknown", isCctpSupported("USDC") && !isCctpSupported("EURC") && !isCctpSupported("USDT") && !isCctpSupported(null));
  ok("normalize never guesses (USDT -> null)", normalizeClientSymbol("USDT") === null && normalizeClientSymbol("") === null);
  ok("getClientToken throws on unsupported", throws(() => getClientToken("USDT")));
  ok("resolveClientToken falls back to USDC for legacy rows, honors server identity", resolveClientToken({}).symbol === "USDC" && resolveClientToken({ currency: "EURC", token: { symbol: "EURC", address: EURC, decimals: 6 } }).address === EURC);
  ok("amount formatting always carries the symbol", formatTokenAmount(1.5, "EURC") === "1.5 EURC" && formatTokenAmount(1.5, "USDC") === "1.5 USDC");
  ok("short address helper keeps identity visible", shortTokenAddress(EURC).includes("…") && shortTokenAddress(EURC).length < EURC.length);

  // ── Phase 2A: native settlement ─────────────────────────────────────────
  console.log("\n[Phase 2A] settle Path B is token-native (native EURC settlement)");
  const settle = read("src/app/api/payments/settle/route.ts");
  ok("settle resolves via canonical resolver", settle.includes("resolveRowCurrency("));
  ok("native Circle transfer uses resolved address", settle.includes("tokenAddress: token.address"));
  ok("fallback ERC-20 uses resolved contract address", settle.includes("contractAddress: token.address"));
  ok("amounts use resolved decimals", settle.includes("toFixed(token.decimals)") && settle.includes("parseUnits(payment.amount.toFixed(token.decimals), token.decimals)"));
  ok("no hardcoded USDC transfer token left in Path B", !settle.includes("tokenAddress: USDC_ARC") && !settle.includes("contractAddress: USDC_ARC"));
  ok("no EURC literal in settle (resolver owns the table)", !settle.includes(EURC_LITERAL));
  ok("no SwapPool in settle (never converted)", !/from\s+['"][^'"]*[Ss]wap[Pp]ool[^'"]*['"]/.test(settle) && !/swapPool\s*\(/i.test(settle));
  ok("no client-controlled token (no body/data tokenAddress)", !settle.includes("body.tokenAddress") && !settle.includes("data.tokenAddress"));
  ok("SUCCESS preserves canonical currency + tokenAddress", settle.includes("currency: token.symbol") && settle.includes("tokenAddress: token.address"));
  ok("payer-control guard present (403, no drain)", settle.includes("payerAuthorized") && settle.includes("You are not a party to this payment") && settle.includes("status: 403"));
  ok("no default-payer fallback reintroduced", !settle.includes("payerWalletId = payerWalletId ||") && settle.includes("refusing to debit a shared default wallet"));
  ok("expiry behavior unchanged", settle.includes("has expired") && settle.includes("status: 'EXPIRED'"));
  ok("atomic PROCESSING_ONCHAIN lock + idempotency 409 unchanged", settle.includes("PROCESSING_ONCHAIN") && settle.includes("lock.count === 0") && settle.includes("Payment already processing or settled") && settle.includes("status: 409"));

  console.log("\n[Phase 2A] CCTP stays explicitly USDC-only");
  ok("settle Path A rejects non-USDC before bridging", settle.includes("token.symbol !== 'USDC'") && settle.includes("CCTP settlement is USDC-only"));
  const cctp = read("src/app/api/payments/cctp-settle/route.ts");
  ok("cctp-settle resolves via canonical resolver", cctp.includes("resolveRowCurrency("));
  ok("cctp-settle rejects non-USDC invoices", cctp.includes("cctpToken.symbol !== 'USDC'") && cctp.includes("CCTP settlement is USDC-only"));
  ok("cctp-settle rejects unsupported token identity", cctp.includes("Unsupported settlement token"));
  ok("cctp amount check stays USDC-denominated with documented reason", cctp.includes("USDC_DECIMALS") && /gate above/.test(cctp));
  ok("no EURC literal in cctp-settle (no fake EURC CCTP path)", !cctp.includes(EURC_LITERAL));

  console.log("\n[Phase 2A] verify-onchain matches ONLY the invoice token (native EURC verification)");
  const verifyOnchain = read("src/app/api/payments/verify-onchain/route.ts");
  ok("verify resolves via canonical resolver", verifyOnchain.includes("resolveRowCurrency("));
  ok("verify rejects unsupported token identity (400)", verifyOnchain.includes("Unsupported settlement token"));
  ok("Transfer log filtered by resolved contract address", verifyOnchain.includes("log.address.toLowerCase() !== token.address.toLowerCase()"));
  ok("no hardcoded USDC contract in matching", !verifyOnchain.includes("USDC_CONTRACT") && !verifyOnchain.includes("0x3600000000000000000000000000000000000000"));
  ok("expected amount uses resolved decimals", verifyOnchain.includes("parseUnits(payment.amount.toString(), token.decimals)"));
  ok("mismatch error names the invoice token", verifyOnchain.includes("No matching ${token.symbol} transfer"));
  ok("fee math is token-unit based (no 1 EURC == 1 USDC assumption)", verifyOnchain.includes("unitsPerToken") && /never treated as 1 USDC/.test(verifyOnchain));
  ok("fee balance reads + debit use the resolved token contract", verifyOnchain.includes("readTokenBalance(") && verifyOnchain.includes("address: token.address") && verifyOnchain.includes("tokenAddress: token.address") && verifyOnchain.includes("decimals: token.decimals"));
  ok("no hardcoded USDC address left in verify", !verifyOnchain.includes("USDC_ARC") && !verifyOnchain.includes("0x3600000000000000000000000000000000000000"));
  ok("SUCCESS preserves canonical currency + tokenAddress", verifyOnchain.includes("currency: token.symbol") && verifyOnchain.includes("tokenAddress: token.address"));
  const transfers = read("src/lib/circle/transfers.ts");
  ok("Circle helper backward-compatible (USDC default)", transfers.includes("tokenAddress = USDC_ARC") && transfers.includes("decimals = 6"));

  console.log("\n[Phase 2A] cross-token matrix (simulated matching rule)");
  const usdcFull = parseUnits("1.5", 6);
  ok("USDC invoice + matching USDC log -> success", matchesInvoiceToken({ invoice: { currency: "USDC", tokenAddress: null }, logAddress: USDC, logTo: MERCHANT, logValue: usdcFull, merchant: MERCHANT, amount: "1.5" }));
  ok("EURC invoice + matching EURC log -> success", matchesInvoiceToken({ invoice: { currency: "EURC", tokenAddress: null }, logAddress: EURC, logTo: MERCHANT, logValue: usdcFull, merchant: MERCHANT, amount: "1.5" }));
  ok("USDC log vs EURC invoice -> reject", !matchesInvoiceToken({ invoice: { currency: "EURC", tokenAddress: null }, logAddress: USDC, logTo: MERCHANT, logValue: usdcFull, merchant: MERCHANT, amount: "1.5" }));
  ok("EURC log vs USDC invoice -> reject", !matchesInvoiceToken({ invoice: { currency: "USDC", tokenAddress: null }, logAddress: EURC, logTo: MERCHANT, logValue: usdcFull, merchant: MERCHANT, amount: "1.5" }));
  ok("wrong token log ignored", !matchesInvoiceToken({ invoice: { currency: "USDC", tokenAddress: null }, logAddress: OTHER, logTo: MERCHANT, logValue: usdcFull, merchant: MERCHANT, amount: "1.5" }));
  ok("underpayment rejected", !matchesInvoiceToken({ invoice: { currency: "USDC", tokenAddress: null }, logAddress: USDC, logTo: MERCHANT, logValue: parseUnits("1.0", 6), merchant: MERCHANT, amount: "1.5" }));
  ok("wrong recipient rejected", !matchesInvoiceToken({ invoice: { currency: "USDC", tokenAddress: null }, logAddress: USDC, logTo: OTHER, logValue: usdcFull, merchant: MERCHANT, amount: "1.5" }));
  ok("legacy NULL invoice verifies a USDC log (readable as USDC)", matchesInvoiceToken({ invoice: { currency: null, tokenAddress: null }, logAddress: USDC, logTo: MERCHANT, logValue: usdcFull, merchant: MERCHANT, amount: "1.5" }));
  ok("symbol/address mismatch invoice throws before matching", throws(() => matchesInvoiceToken({ invoice: { currency: "USDC", tokenAddress: EURC }, logAddress: EURC, logTo: MERCHANT, logValue: usdcFull, merchant: MERCHANT, amount: "1.5" })));
  ok("decimals come from the resolver (6 for both supported tokens today)", resolveRowCurrency({ currency: "EURC" }).decimals === 6 && resolveRowCurrency({ currency: "USDC" }).decimals === 6 && resolveCurrency({}).decimals === 6);

  // ── Phase 2B: user-facing checkout + creation ───────────────────────────
  console.log("\n[Phase 2B] Checkout — native USDC+EURC, CCTP USDC-only");
  const widget = read("src/components/CheckoutWidget.tsx");
  ok("transfer signs the resolved invoice token (USDC fallback for legacy)", widget.includes("payment.token?.address || USDC_CONTRACT") && widget.includes("payment.token?.decimals ?? USDC_DECIMALS"));
  ok("Pay button enabled for EURC (no Phase-1 block)", !widget.includes("disabled={isEurc ||") && !widget.includes("EURC not yet supported") && !widget.includes("EURC support coming in Phase 2"));
  ok("Pay button names the invoice token", widget.includes("`Pay ${payment.amount} ${invoiceSymbol}`"));
  ok("Amount Due row carries the invoice symbol", widget.includes("{invoiceSymbol}</span>}"));
  ok("token identity row shown (symbol + contract)", widget.includes("shortTokenAddress(invoiceToken.address)"));
  ok("banner names the signed token for every invoice", widget.includes("Paying in {invoiceSymbol}"));
  ok("balance display names the invoice token", widget.includes("Your {invoiceSymbol} balance"));
  ok("insufficient-balance warning names the token + forbids cross-token pay", widget.includes("Insufficient ${invoiceSymbol} balance") && widget.includes("cannot pay this invoice"));
  ok("tx-rejection mapping names the invoice token", widget.includes("Insufficient ${invoiceSymbol} for this transaction"));
  ok("confirmation names the settled token", widget.includes("settled on Arc Testnet in {invoiceSymbol}"));
  ok("CCTP tab disabled for EURC (USDC-only label)", widget.includes("(USDC-only)") && widget.includes("Cross-chain (CCTP) is USDC-only"));
  ok("widget auto-switches EURC off the CCTP tab", widget.includes("!cctpAvailable && method === 'cctp'"));
  ok("CCTP verify button still blocked for EURC", widget.includes("isEurc || !cctpTxHash.trim()"));
  ok("EURC fallback notice when CCTP selected", widget.includes("Cross-chain unavailable for {invoiceSymbol}") && widget.includes("cannot settle this ${invoiceSymbol} invoice"));
  ok("no SwapPool in checkout (never converted)", !/swapPool/i.test(widget));
  ok("no duplicated token table in widget", !widget.includes(EURC_LITERAL));

  console.log("\n[Phase 2B] payment creation — merchant link + dashboard");
  const link = read("src/app/api/merchant/payment-link/route.ts");
  ok("link resolves through the canonical resolver", link.includes("resolveCurrency({ currency })"));
  ok("link persists canonical symbol + tokenAddress", link.includes("currency: token.symbol") && link.includes("tokenAddress: token.address"));
  ok("link rejects unsupported currencies (never converted)", link.includes("Unsupported currency"));
  ok("link response returns token identity", link.includes("address: token.address"));
  ok("link list view exposes per-row token identity", link.includes("resolveRowCurrency("));
  ok("no second payment creation API introduced", !fs.existsSync(path.join(root, "src/app/api/merchant/payment-link-v2/route.ts")));
  const dash = read("src/app/merchant/dashboard/page.tsx");
  ok("dashboard exposes Currency: USDC | EURC", dash.includes("setCurrency") && dash.includes('<option value="USDC">USDC</option>') && dash.includes('<option value="EURC">EURC</option>'));
  ok("dashboard sends the selected currency", dash.includes("currency,") && !dash.includes("currency: 'USDC'"));
  ok("dashboard confirmation shows the selected token", dash.includes("{newLink.amount} {newLink.currency"));
  ok("merchant table shows per-row currency", dash.includes("{payment.currency}"));

  console.log("\n[Phase 2B] consumer token selection + balance + labels");
  const consumer = read("src/app/consumer/page.tsx");
  ok("send currency selection exists (USDC|EURC)", consumer.includes("sendCurrency") && consumer.includes("setSendCurrency"));
  ok("request currency selection exists (USDC|EURC)", consumer.includes("requestCurrency") && consumer.includes("setRequestCurrency"));
  ok("send posts the selected currency to the canonical field", consumer.includes("currency: sendCurrency"));
  ok("request posts the selected currency to the canonical field", consumer.includes("currency: requestCurrency"));
  ok("no hardcoded currency in send/request payloads", !consumer.includes('currency: "USDC",') && !consumer.includes("currency: 'USDC',"));
  ok("send confirmation names the selected token", consumer.includes("Sent ${amount} ${sendCurrency}"));
  ok("request confirmation names the selected token", consumer.includes("${requestCurrency} payment link"));
  ok("send form shows the correct-token balance", consumer.includes("api/consumer/balance?currency=${sendCurrency}"));
  ok("home balance toggles USDC/EURC with matching symbol", consumer.includes("setBalanceCurrency") && consumer.includes("{balanceCurrency}</span>"));
  ok("bridge stays USDC-only (no EURC option)", consumer.includes("Move USDC into Arc") && !consumer.includes("bridgeCurrency"));
  ok("save (scheduled) untouched — no currency selector", !consumer.includes("saveCurrency") && consumer.includes('"Automatic savings"'));
  const bal = read("src/app/api/consumer/balance/route.ts");
  ok("balance route serves the requested token", bal.includes('searchParams.get("currency")') && bal.includes("getTokenBalance"));
  ok("balance route rejects unsupported currencies", bal.includes("Unsupported currency") && bal.includes("status: 400"));
  ok("balance route returns token identity + defaults USDC for legacy", bal.includes("token: {") && bal.includes('?? "USDC"'));
  const tokenBal = read("src/lib/wallet/tokenBalance.ts");
  ok("generic balance resolves via canonical resolver, hardcodes nothing", tokenBal.includes("resolveCurrency({ currency") && !tokenBal.includes("0x3600") && !tokenBal.includes("0x89B508"));
  ok("consumer activity UI shows amount + currency", consumer.includes('{a.amount.toFixed(2)} {a.currency || a.token?.symbol || "USDC"}'));
  const invoice = read("src/components/Invoice.tsx");
  ok("invoice receipt names the settlement token", invoice.includes("Token:") && invoice.includes("payment.token"));
  ok("invoice tx block names the transfer token", invoice.includes("transfer)"));
  const checkoutPage = read("src/app/checkout/[reference]/page.tsx");
  ok("checkout order summary carries amount + currency, passes token to invoice", checkoutPage.includes("{payment.currency}</span>") && checkoutPage.includes("token: payment.token"));

  // ── Phase 2C: Nano / Scheduled / Payroll ────────────────────────────────
  console.log("\n[Phase 2C] nano mixed-token batch splitting (unit)");
  const mixed = [
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.4, currency: "USDC", tokenAddress: USDC },
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.7, currency: "EURC", tokenAddress: EURC },
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.5, currency: "USDC", tokenAddress: USDC },
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.1, currency: "USDC", tokenAddress: null },
  ];
  const groups = groupNanoRowsByToken(mixed as any);
  ok("mixed USDC+EURC rows split into exactly 2 groups", groups.length === 2, `got ${groups.length}`);
  const usdcGroup = groups.find((g) => g.currency === "USDC");
  const eurcGroup = groups.find((g) => g.currency === "EURC");
  ok("USDC group carries canonical USDC address; EURC group EURC address", usdcGroup?.tokenAddress === USDC && eurcGroup?.tokenAddress === EURC);
  ok("USDC rows combine (0.4+0.5+legacy 0.1 = 1.0); EURC holds only its row", usdcGroup?.total === 1.0 && eurcGroup?.total === 0.7 && eurcGroup?.rows.length === 1, `got ${usdcGroup?.total}/${eurcGroup?.total}`);
  ok("legacy NULL-address row joined USDC (3 rows), never EURC", usdcGroup?.rows.length === 3);
  ok("same-token rows stay one group; same token + different merchant splits", groupNanoRowsByToken([{ agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.2, currency: "EURC", tokenAddress: EURC }, { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.3, currency: "EURC", tokenAddress: EURC }] as any).length === 1 && groupNanoRowsByToken([{ agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.2, currency: "USDC", tokenAddress: USDC }, { agentSCA: AGENT, merchantSCA: "0xcccccccccccccccccccccccccccccccccccccccc", amount: 0.2, currency: "USDC", tokenAddress: USDC }] as any).length === 2);
  ok("legacy nano rows resolve via canonical reader", resolveNanoToken({ currency: "USDC", tokenAddress: null }).address === USDC && resolveNanoToken({}).address === USDC && resolveNanoToken({ currency: "EURC", tokenAddress: null }).symbol === "EURC");
  const hostile = { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 1.0, currency: "USDC", tokenAddress: EURC } as any;
  ok("hostile USDC-claim/EURC-address row throws (never trusted as either token)", throws(() => resolveNanoToken(hostile)) && throws(() => groupNanoRowsByToken([hostile])));

  console.log("\n[Phase 2C] nano settle — token-scoped execution (static)");
  const nanoLib = read("src/lib/nanopayment.ts");
  const nanoCreate = read("src/app/api/payments/nano/route.ts");
  const nanoSettle = read("src/app/api/payments/nano/settle/route.ts");
  ok("lib resolves every row through the canonical resolver, groups by agent+merchant+token", nanoLib.includes("resolveRowCurrency") && nanoLib.includes("token.address.toLowerCase()"));
  ok("getUnsettledPairs returns per-token triples; record keeps currency+tokenAddress", nanoLib.includes("Promise<NanoBatchKey[]>") && nanoLib.includes("currency: token.symbol") && nanoLib.includes("tokenAddress: token.address"));
  ok("create resolves currency/tokenAddress via resolver, rejects bad pairs", nanoCreate.includes("resolveCurrency({ currency, tokenAddress })") && nanoCreate.includes("status: 400"));
  ok("create scopes balance/threshold per token", nanoCreate.includes("getUnsettledBalance(agentSCA, merchantSCA, {"));
  ok("settle reads token identity without touching validation.ts", nanoSettle.includes("rawBody") && nanoSettle.includes("resolveCurrency({ currency: rawBody.currency"));
  ok("settle locks only rows resolving to the settlement token, rejects alien rows", nanoSettle.includes("candidates.filter((n) => logMatchesToken(n as any, token))") && nanoSettle.includes("are not ${token.symbol}"));
  ok("settle transfers the resolved token (never hardcoded USDC)", nanoSettle.includes("tokenAddress: token.address") && nanoSettle.includes("contractAddress: token.address") && !nanoSettle.includes("USDC_ARC"));
  ok("settle PaymentLog persists currency + tokenAddress", nanoSettle.includes("currency: token.symbol,") && nanoSettle.includes("tokenAddress: token.address,"));
  ok("stale-lock recovery + resume are token-scoped", nanoSettle.includes("recoverStaleLocks(agentSCA, merchantSCA, token)") && nanoSettle.includes("resumeExistingTransaction(agentSCA, merchantSCA, token)"));
  ok("mixed pair settles one transfer per token (never merged)", nanoSettle.includes("mixedTokens: true") && nanoSettle.includes("Settled ${settlements"));
  ok("autoSettle iterates per-token pairs; guards preserved", nanoSettle.includes("p.tokenAddress.toLowerCase()") && nanoSettle.includes("verifyCallerControlsAddress") && nanoSettle.includes("DEFAULT_PAYER_WALLET_ID"));

  console.log("\n[Phase 2C] scheduled — per-row token execution (static)");
  const schedCreate = read("src/app/api/payments/scheduled/route.ts");
  const schedRun = read("src/app/api/payments/scheduled/run/route.ts");
  ok("create resolves + persists currency/tokenAddress, rejects bad pairs", schedCreate.includes("resolveCurrency({ currency, tokenAddress })") && schedCreate.includes("currency: token.symbol,") && schedCreate.includes("tokenAddress: token.address,") && schedCreate.includes("status: 400"));
  ok("runner resolves EACH row's token (no batch-level assumption)", schedRun.includes("resolveRowCurrency(scheduled)"));
  ok("runner transfers the row's token (native + ERC-20 fallback)", schedRun.includes("tokenAddress: token.address,") && schedRun.includes("contractAddress: token.address,") && !schedRun.includes("USDC_ARC"));
  ok("unresolvable-token rows fail closed (never paid in wrong asset)", schedRun.includes("has an unresolvable token"));
  ok("results + webhook carry currency/tokenAddress", schedRun.includes("currency: execution.currency,") && schedRun.includes("tokenAddress: execution.tokenAddress,"));
  ok("idempotency preserved (atomic claim + stale reclaim + retry release)", schedRun.includes("status: 'PROCESSING', lastRunAt: now") && schedRun.includes("claim.count === 0") && schedRun.includes("STALE_CLAIM_MS") && schedRun.includes("data: { status: 'ACTIVE' }") && schedRun.includes("already claimed by another runner"));
  ok("fail-closed null payer + status transitions preserved", schedRun.includes("has no resolved payer wallet") && schedRun.includes("isComplete ? 'COMPLETED' : 'ACTIVE'"));
  ok("amount math uses resolver decimals", schedRun.includes("toFixed(token.decimals)") && schedRun.includes("parseUnits(amountStr, token.decimals)") && nanoSettle.includes("10 ** token.decimals") && nanoSettle.includes("total.toFixed(token.decimals)"));

  console.log("\n[Phase 2C] payroll lifecycle — single-token end to end (static)");
  const payrollRun = read("src/app/api/payroll/run/route.ts");
  const payrollFund = read("src/lib/payroll/payrollExecution.ts");
  ok("run resolves the batch token via the canonical resolver, rejects bad pairs", payrollRun.includes("resolveCurrency({ currency, tokenAddress })") && payrollRun.includes("error: tokenError.message"));
  ok("run persists currency + tokenAddress on the batch", payrollRun.includes("currency: token.symbol,") && payrollRun.includes("tokenAddress: token.address,"));
  ok("run transfers via transferToken on the batch token with resolver decimals", payrollRun.includes("walletProvider.transferToken(") && payrollRun.includes("token.address,") && payrollRun.includes("token.decimals,"));
  ok("external-wallet payload targets the batch token contract", payrollRun.includes("to: token.address,") && payrollRun.includes("parseUnits(amountStr, token.decimals)"));
  ok("ledger entries carry token symbol + address", payrollRun.includes("token: token.symbol,") && payrollRun.includes("tokenAddress: token.address,"));
  ok("provider interface exposes transferToken; circle provider validates the token", read("src/lib/wallet/provider.ts").includes("transferToken(to: string, amount: string, tokenAddress: string, decimals: number") && read("src/lib/wallet/circleProvider.ts").includes("getTokenByAddress(tokenAddress)"));
  ok("messaging uses the batch symbol (no hardcoded USDC totals)", !payrollRun.includes("${totalAmount} USDC") && payrollRun.includes("${totalAmount} ${token.symbol}"));
  ok("idempotency replay refuses cross-token retries (P2002 race replay kept)", payrollRun.includes("refusing to replay across tokens") && payrollRun.includes("replayed: true") && payrollRun.includes("P2002"));
  ok("batch state machine untouched", payrollRun.includes("'AWAITING_SIGNATURES'") && payrollRun.includes("'PARTIAL_FAILURE'"));
  ok("x402 fund path keeps its USDC-only EURC gate with explicit USDC persistence", payrollFund.includes("resolvedToken?.symbol === 'EURC'") && payrollFund.includes('currency: "USDC",') && payrollFund.includes("tokenAddress: usdcAddress,"));
  ok("nano/scheduled/payroll schema + migration additive", /model NanoPayment[\s\S]*?tokenAddress\s+String\?/.test(schema) && /model ScheduledPayment[\s\S]*?tokenAddress\s+String\?/.test(schema) && /model PayrollBatch[\s\S]*?tokenAddress\s+String\?/.test(schema) && read("prisma/migrations/20260906000000_multicurrency_phase2c_token_address/migration.sql").includes('ALTER TABLE "NanoPayment" ADD COLUMN "tokenAddress" TEXT;'));

  // ── Phase 2D: ledger token identity (static only; live-DB in phase2d) ───
  console.log("\n[Phase 2D] ledger token identity (static + pure-unit)");
  ok("usdcLedgerIdentity carries canonical USDC symbol + address", usdcLedgerIdentity().token === "USDC" && usdcLedgerIdentity().tokenAddress === USDC);
  const usdcRow = resolveLedgerToken({ token: "USDC", tokenAddress: USDC });
  const eurcRow = resolveLedgerToken({ token: "EURC", tokenAddress: EURC });
  const legacyRow = resolveLedgerToken({ token: "USDC", tokenAddress: null });
  ok("resolveLedgerToken: USDC row -> USDC (not legacy)", usdcRow.symbol === "USDC" && usdcRow.address === USDC && usdcRow.legacy === false);
  ok("resolveLedgerToken: EURC row -> EURC (not legacy)", eurcRow.symbol === "EURC" && eurcRow.address === EURC && eurcRow.legacy === false);
  ok("resolveLedgerToken: legacy NULL -> USDC + legacy flag", legacyRow.symbol === "USDC" && legacyRow.address === USDC && legacyRow.legacy === true);
  ok("dedupe key shape unchanged (txHash:agentId:TYPE, no token qualifier)", buildDedupeKey({ agentRegistryId: 7, type: "REVENUE", amount: 1n, direction: "CREDIT", txHash: "0xabc" }) === "0xabc:7:REVENUE");
  const ledgerSrc = read("src/lib/ledger/ledgerService.ts");
  ok("ledger resolves identity through the canonical resolver", ledgerSrc.includes("resolveCurrency({ currency: params.token"));
  ok("ledger persists amounts verbatim (no FX)", ledgerSrc.includes("amount: params.amount.toString()"));
  ok("ledger never converts between tokens (no FX identifiers)", !/exchangeRate|fxRate|convertTo|_toUsdc|toUSDC\(|EURC_TO_USDC|USDC_TO_EURC/i.test(ledgerSrc));
  const ledgerFlat = ledgerSrc.replace(/\r\n/g, "\n");
  const dedupeFn = ledgerFlat.slice(ledgerFlat.indexOf("export function buildDedupeKey"), ledgerFlat.indexOf("\n}\n", ledgerFlat.indexOf("export function buildDedupeKey")));
  ok("buildDedupeKey carries no token qualifier", !/token/i.test(dedupeFn));
  const ledgerModel = schema.slice(schema.indexOf("model AgentLedgerEntry"), schema.indexOf("model AgentLedgerEntry") + 2500);
  ok("AgentLedgerEntry.token untouched (USDC default) + tokenAddress additive + dedupeKey unique", /token\s+String\s+@default\("USDC"\)/.test(ledgerModel) && /tokenAddress\s+String\?/.test(ledgerModel) && /dedupeKey\s+String\s+@unique/.test(ledgerModel));
  const treasurySrc = read("src/lib/ledger/treasuryService.ts");
  ok("treasury exposes byToken + hasMixedTokens + legacyEntryCount via canonical reader", treasurySrc.includes("byToken") && treasurySrc.includes("hasMixedTokens") && treasurySrc.includes("legacyEntryCount") && treasurySrc.includes("resolveRowCurrency"));
  const agentsPage = read("src/app/agents/page.tsx");
  ok("economics shows per-entry token + legacy marker + by-token panel", agentsPage.includes("{e.token || 'USDC'}") && agentsPage.includes("(legacy)") && agentsPage.includes("Balances by token"));
  ok("trust + track-record expose per-token volume", read("src/lib/trust/trustScore.ts").includes("validatedVolumeByToken") && read("src/lib/trust/trackRecord.ts").includes("validatedVolumeByToken"));
  const autoRep = read("src/lib/trust/autoReputation.ts");
  ok("autoReputation guard row persists canonical USDC address", autoRep.includes('token: "USDC"') && autoRep.includes('tokenAddressFor("USDC")'));
  ok("agent payments reject non-USDC; escrow stays USDC-denominated", read("src/lib/agents/agentPay.ts").includes("agent payments use native USDC") && read("src/app/api/escrow/create/route.ts").includes("currency: 'USDC'"));
  ok("scheduled writes no ledger rows (nothing to mislabel)", !schedRun.includes("recordLedgerEntry"));
  ok("nano settlement persists the pair's resolved token (never a constant)", nanoSettle.includes("tokenAddress: token.address") && !nanoSettle.includes("tokenAddress: USDC_ARC"));

  // ── Legacy safety: detect / settle-cross-chain / webhook ────────────────
  console.log("\n[Legacy safety] detect / settle-cross-chain / webhook stay USDC-only");
  const detect = read("src/app/api/payments/detect/route.ts");
  ok("detect gates EURC before any ledger write and before any mint", detect.indexOf("EURC SAFETY GATE") < detect.indexOf("prisma.paymentLog.create") && detect.indexOf("EURC SAFETY GATE") < detect.indexOf("mintOnArc(message, attestation)"));
  ok("detect restricts currency to USDC via canonical resolver, persists enforced identity", detect.includes("resolveCurrency({ currency: currency ?? 'USDC' })") && detect.includes("if (detectCurrency.symbol !== 'USDC')") && detect.includes("currency: detectCurrency.symbol") && detect.includes("tokenAddress: tokenAddressFor('USDC')"));
  ok("detect USDC behavior + API-key auth preserved, no EURC execution", detect.includes("pollForAttestation(messageHash)") && detect.includes("mintOnArc(message, attestation)") && detect.includes("export const POST = withApiKey(detectHandler);") && !detect.includes(EURC));
  const xc = read("src/app/api/settle-cross-chain/route.ts");
  ok("settle-cross-chain gates before any row write and before any mint", xc.indexOf("EURC SAFETY GATE") < xc.indexOf("POLLING_CIRCLE_TESTNET_IRIS_API") && xc.indexOf("EURC SAFETY GATE") < xc.indexOf("functionName: 'receiveMessage'"));
  ok("settle-cross-chain resolves the DB row's token (no client override)", xc.includes("resolveRowCurrency(paymentRow)") && /const\s*\{\s*reference,\s*messageHash,\s*rawMessage\s*\}\s*=\s*await request\.json\(\)/.test(xc) && !/\{\s*[^}]*\bcurrency\b[^}]*\}\s*=\s*await request\.json\(\)/.test(xc));
  ok("settle-cross-chain auth precedes the gate; USDC behavior preserved", xc.indexOf("isInternalServiceCall") < xc.indexOf("record.active === true") && xc.indexOf("isInternalServiceCall") < xc.indexOf("EURC SAFETY GATE") && xc.includes("functionName: 'receiveMessage'") && xc.includes("REDEEMED_AND_MINTED") && !xc.includes(EURC));
  const wh = read("src/app/api/webhooks/circle/route.ts");
  ok("webhook stays signature-authenticated; ignores non-USDC before write/mint", wh.includes("verifyCircleWebhookSignature(rawBody, signature)") && wh.indexOf("EURC SAFETY GATE") < wh.indexOf("prisma.paymentLog.create") && wh.indexOf("if (messageHash && isUsdc)") < wh.indexOf("autoSettleV2(") && wh.includes("else if (messageHash && !isUsdc)"));
  ok("webhook row write hardcodes USDC + canonical address; defense-in-depth gate in autoSettleV2", wh.includes("currency: 'USDC'") && wh.includes("tokenAddress: tokenAddressFor('USDC')") && wh.indexOf("rowIsUsdc") < wh.indexOf("pollForAttestation(messageHash)") && wh.indexOf("rowIsUsdc") < wh.indexOf("mintOnArc(message, attestation)"));
  ok("webhook USDC behavior preserved, no EURC execution", wh.includes("pollForAttestation(messageHash)") && wh.includes("mintOnArc(message, attestation)") && wh.includes("REDEEMED_AND_MINTED") && !wh.includes(EURC));

  console.log("\n[Scope] genuinely USDC-only engines stay uncoupled (content-based)");
  ok("x402 lib has no token-resolver coupling", !read("src/lib/x402.ts").includes("resolveCurrency") && !read("src/lib/x402.ts").includes("resolveRowCurrency"));
  ok("settlement recovery has no token-resolver coupling", !read("src/lib/jobs/settlementRecovery.ts").includes("resolveCurrency") && !read("src/lib/jobs/settlementRecovery.ts").includes("resolveRowCurrency"));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
