/**
 * phase2b-ux-tests.ts
 *
 * FlareHQ Multicurrency Phase 2B — user-facing payment experience for native
 * USDC + EURC. Unit + static proofs (no dev server / DB / chain required):
 *   R1  canonical resolver still authoritative (USDC/EURC/mismatch/legacy).
 *   C   client-safe token metadata layer (no duplicated registry, CCTP rule,
 *       formatting always carries the symbol).
 *   W1  USDC checkout: amount+symbol display, USDC transfer token, USDC
 *       balance, USDC insufficient messaging, CCTP available.
 *   W2  EURC checkout: amount+symbol display, EURC transfer token, EURC
 *       balance, EURC insufficient messaging, CCTP UNAVAILABLE.
 *   W3  wrong token can never be silently substituted (no conversion, no
 *       SwapPool, server re-enforces).
 *   P   payment creation: merchant payment-link accepts USDC|EURC, persists
 *       canonical identity through the resolver, dashboard exposes Currency.
 *   U   consumer send/request: currency selection posted to the canonical
 *       backend field, confirmation + correct-token balance displayed;
 *       bridge stays USDC-only, save (scheduled) untouched.
 *   B   balance route serves the requested supported token, rejects others.
 *   H   history / activity / invoice records show amount + currency + token.
 *   S   scope guard: out-of-scope engines are not coupled to Phase 2B
 *       (content-based — robust to unrelated parallel work in the tree).
 *
 * Run: npx tsx scripts/phase2b-ux-tests.ts
 */

import fs from "fs";
import path from "path";
import {
  resolveCurrency,
  resolveRowCurrency,
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
  console.log("\n[R1] canonical resolver still authoritative");
  ok("USDC resolves canonically", resolveCurrency({ currency: "USDC" }).address === USDC);
  ok("EURC resolves canonically", resolveCurrency({ currency: "EURC" }).address === EURC);
  ok("legacy NULL/NULL -> USDC", resolveCurrency({ currency: null, tokenAddress: null }).symbol === "USDC");
  ok("legacy EURC-currency row reads EURC", resolveRowCurrency({ currency: "EURC", tokenAddress: null }).symbol === "EURC");
  ok("USDT rejected", throws(() => resolveCurrency({ currency: "USDT" })));
  ok("arbitrary ERC-20 rejected", throws(() => resolveCurrency({ tokenAddress: "0x1111111111111111111111111111111111111111" })));
  ok("USDC symbol + EURC address mismatch rejected", throws(() => resolveCurrency({ currency: "USDC", tokenAddress: EURC })));
  ok("EURC symbol + USDC address mismatch rejected", throws(() => resolveCurrency({ currency: "EURC", tokenAddress: USDC })));

  console.log("\n[C] client-safe token metadata layer");
  const clientTokens = read("src/lib/tokens/clientTokens.ts");
  ok("imports the canonical registry (no second token table)", clientTokens.includes("from './supportedTokens'"));
  ok("hardcodes no token addresses", !clientTokens.includes("0x3600") && !clientTokens.includes("0x89B508"));
  ok("hardcodes no decimals", !/decimals\s*[:=]\s*6/.test(clientTokens));
  ok("exposes exactly USDC + EURC", [...SUPPORTED_CURRENCIES].sort().join(",") === "EURC,USDC");
  ok("legacy aliases derive from the registry", USDC_CONTRACT === USDC && USDC_DECIMALS === 6);
  ok("CCTP supported for USDC", isCctpSupported("USDC"));
  ok("CCTP unavailable for EURC", !isCctpSupported("EURC"));
  ok("CCTP unavailable for unknown input", !isCctpSupported("USDT") && !isCctpSupported(null));
  ok("normalize never guesses (USDT -> null)", normalizeClientSymbol("USDT") === null && normalizeClientSymbol("") === null);
  ok("getClientToken throws on unsupported", throws(() => getClientToken("USDT")));
  ok("resolveClientToken falls back to USDC for legacy rows", resolveClientToken({}).symbol === "USDC");
  ok("resolveClientToken honors server token identity", resolveClientToken({ currency: "EURC", token: { symbol: "EURC", address: EURC, decimals: 6 } }).address === EURC);
  ok("amount formatting always carries the symbol", formatTokenAmount(1.5, "EURC") === "1.5 EURC" && formatTokenAmount(1.5, "USDC") === "1.5 USDC");
  ok("short address helper keeps identity visible", shortTokenAddress(EURC).includes("…") && shortTokenAddress(EURC).length < EURC.length);

  console.log("\n[W1] USDC checkout");
  const widget = read("src/components/CheckoutWidget.tsx");
  ok("token metadata comes from the client-safe layer", widget.includes("src/lib/tokens/clientTokens"));
  ok("USDC fallback sourced from the client layer, not the contracts file", !/from\s*['"]@\/src\/lib\/wallet\/erc20['"]/.test(widget) || !widget.includes("USDC_CONTRACT, USDC_DECIMALS, erc20TransferAbi"));
  ok("no duplicated token table in widget", !widget.includes("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"));
  ok("Pay button names the invoice token", widget.includes("`Pay ${payment.amount} ${invoiceSymbol}`"));
  ok("Amount Due row carries the invoice symbol", widget.includes("{invoiceSymbol}</span>}"));
  ok("token identity row shown (symbol + contract)", widget.includes("shortTokenAddress(invoiceToken.address)"));
  ok("banner names the signed token for every invoice", widget.includes("Paying in {invoiceSymbol}"));
  ok("transfer signs the resolved invoice token (USDC fallback for legacy)", widget.includes("payment.token?.address || USDC_CONTRACT") && widget.includes("payment.token?.decimals ?? USDC_DECIMALS"));
  ok("payer balance read from the transfer contract", widget.includes("balanceOf") && widget.includes("useReadContract"));
  ok("balance display names the invoice token", widget.includes("Your {invoiceSymbol} balance"));
  ok("insufficient-balance warning names the token + forbids cross-token pay", widget.includes("Insufficient ${invoiceSymbol} balance") && widget.includes("cannot pay this invoice"));
  ok("tx-rejection mapping names the invoice token", widget.includes("Insufficient ${invoiceSymbol} for this transaction"));
  ok("confirmation names the settled token", widget.includes("settled on Arc Testnet in {invoiceSymbol}"));
  ok("CCTP tab rendered for USDC (available path exists)", widget.includes("cctpAvailable"));

  console.log("\n[W2] EURC checkout + CCTP unavailable");
  ok("CCTP tab disabled for EURC (USDC-only label)", widget.includes("(USDC-only)") && widget.includes("Cross-chain (CCTP) is USDC-only"));
  ok("widget auto-switches EURC off the CCTP tab", widget.includes("!cctpAvailable && method === 'cctp'"));
  ok("CCTP panel gated on availability", widget.includes("method === 'cctp' && cctpAvailable"));
  ok("EURC fallback notice when CCTP selected", widget.includes("Cross-chain unavailable for {invoiceSymbol}"));
  ok("defensive CCTP reject names the invoice token", widget.includes("cannot settle this ${invoiceSymbol} invoice"));
  ok("CCTP verify button still blocked for EURC", widget.includes("isEurc || !cctpTxHash.trim()"));

  console.log("\n[W3] wrong token can never be silently substituted");
  ok("no SwapPool in checkout (never converted)", !/swapPool/i.test(widget));
  ok("server re-enforces the invoice token (verify-onchain)", read("src/app/api/payments/verify-onchain/route.ts").includes("log.address.toLowerCase() !== token.address.toLowerCase()"));
  ok("settle uses no client-controlled token", !read("src/app/api/payments/settle/route.ts").includes("data.tokenAddress"));

  console.log("\n[P] payment creation (merchant payment-link)");
  const link = read("src/app/api/merchant/payment-link/route.ts");
  ok("resolves through the canonical resolver", link.includes("resolveCurrency({ currency })"));
  ok("persists canonical symbol + tokenAddress", link.includes("currency: token.symbol") && link.includes("tokenAddress: token.address"));
  ok("rejects unsupported currencies (never converted)", link.includes("Unsupported currency"));
  ok("response returns token identity", link.includes("address: token.address"));
  ok("list view exposes per-row token identity", link.includes("resolveRowCurrency("));
  ok("no second payment creation API introduced", !fs.existsSync(path.join(root, "src/app/api/merchant/payment-link-v2/route.ts")));
  const dash = read("src/app/merchant/dashboard/page.tsx");
  ok("dashboard exposes Currency: USDC | EURC", dash.includes("setCurrency") && dash.includes('<option value="USDC">USDC</option>') && dash.includes('<option value="EURC">EURC</option>'));
  ok("dashboard sends the selected currency", dash.includes("currency,") && !dash.includes("currency: 'USDC'"));
  ok("dashboard confirmation shows the selected token", dash.includes("{newLink.amount} {newLink.currency"));

  console.log("\n[U] consumer send/request token choice");
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

  console.log("\n[B] consumer balance route serves the requested token");
  const bal = read("src/app/api/consumer/balance/route.ts");
  ok("accepts ?currency via the canonical path", bal.includes('searchParams.get("currency")') && bal.includes("getTokenBalance"));
  ok("rejects unsupported currencies", bal.includes("Unsupported currency") && bal.includes("status: 400"));
  ok("returns token identity", bal.includes("token: {"));
  ok("defaults to USDC for legacy callers", bal.includes('?? "USDC"'));
  const tokenBal = read("src/lib/wallet/tokenBalance.ts");
  ok("generic balance resolves via canonical resolver", tokenBal.includes("resolveCurrency({ currency"));
  ok("generic balance hardcodes no addresses", !tokenBal.includes("0x3600") && !tokenBal.includes("0x89B508"));

  console.log("\n[H] history / activity / invoice labels");
  const activity = read("src/app/api/consumer/activity/route.ts");
  ok("activity exposes currency + token", activity.includes("currency: log.currency") && activity.includes("token,"));
  ok("consumer activity UI shows amount + currency", consumer.includes('{a.amount.toFixed(2)} {a.currency || a.token?.symbol || "USDC"}'));
  ok("merchant table shows per-row currency", dash.includes("{payment.currency}"));
  const invoice = read("src/components/Invoice.tsx");
  ok("invoice receipt names the settlement token", invoice.includes("Token:") && invoice.includes("payment.token"));
  ok("invoice tx block names the transfer token", invoice.includes("transfer)"));
  const checkoutPage = read("src/app/checkout/[reference]/page.tsx");
  ok("checkout order summary carries amount + currency", checkoutPage.includes("{payment.currency}</span>"));
  ok("checkout passes token identity to the invoice", checkoutPage.includes("token: payment.token"));

  console.log("\n[S] scope guard — out-of-scope engines not coupled to Phase 2B");
  // Content-based (not git-diff-based): parallel batches share this tree, so
  // the guard proves THIS batch did not wire its modules into engines it must
  // not touch. None of these files may import the Phase 2B client layer or
  // the generic balance helper.
  const protectedFiles = [
    "src/app/api/payments/nano/route.ts",
    "src/app/api/payments/nano/settle/route.ts",
    "src/app/api/payments/scheduled/route.ts",
    "src/app/api/payments/scheduled/run/route.ts",
    "src/lib/payroll/payrollExecution.ts",
    "src/app/api/x402/route.ts",
    "src/lib/validation.ts",
  ];
  for (const p of protectedFiles) {
    if (!fs.existsSync(path.join(root, p))) {
      console.log(`  ⚠️  missing (parallel work?): ${p} — skipped`);
      continue;
    }
    const src = read(p);
    ok(`uncoupled: ${p}`, !src.includes("clientTokens") && !src.includes("tokenBalance"));
  }
  const validation = read("src/lib/validation.ts");
  ok("InitializeSchema still USDC|EURC via canonical backend (no change needed)", validation.includes("z.enum(['USDC', 'EURC'])"));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
