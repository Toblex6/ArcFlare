/**
 * phase2a-settlement-tests.ts
 *
 * FlareHQ Multicurrency Phase 2A — payment settlement + on-chain verification.
 * Unit + static proofs (no dev server / DB / chain required):
 *   S1  settlement token resolution: USDC invoice -> USDC, EURC -> EURC,
 *       legacy NULL -> USDC, unsupported/mismatch rejected.
 *   S2  settle Path B is token-native (resolver address/decimals, both
 *       transfer branches), no client-controlled token, no SwapPool, no
 *       hardcoded USDC transfer constant, EURC never moves USDC.
 *   S3  settle guards unchanged: payer-control 403, expiry, atomic
 *       PROCESSING_ONCHAIN lock / 409 idempotency.
 *   S4  CCTP stays USDC-only: settle Path A + /cctp-settle reject non-USDC.
 *   V1  verify-onchain resolves the invoice token, matches ONLY logs from the
 *       resolved contract, uses resolved decimals, rejects cross-token.
 *   V2  verify-onchain fee leg is token-native (no USDC-denominated silent
 *       conversion), SUCCESS preserves currency + tokenAddress.
 *   W1  CheckoutWidget transfers the resolved token (USDC fallback only for
 *       legacy rows), Pay enabled for EURC, CCTP tab blocked for EURC.
 *
 * Run: npx tsx scripts/phase2a-settlement-tests.ts
 */

import fs from "fs";
import path from "path";
import { parseUnits } from "viem";
import {
  resolveCurrency,
  resolveRowCurrency,
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
const EURC_LITERAL = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

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
  const OTHER = "0x1111111111111111111111111111111111111111";

  console.log("\n[S1] settlement token resolution (canonical resolver)");
  ok("USDC invoice -> USDC address", resolveRowCurrency({ currency: "USDC", tokenAddress: null }).address === USDC);
  ok("EURC invoice -> EURC address", resolveRowCurrency({ currency: "EURC", tokenAddress: null }).address === EURC);
  ok("explicit USDC tokenAddress -> USDC", resolveCurrency({ currency: "USDC", tokenAddress: USDC }).symbol === "USDC");
  ok("explicit EURC tokenAddress -> EURC", resolveCurrency({ currency: "EURC", tokenAddress: EURC }).symbol === "EURC");
  ok("legacy NULL/NULL -> USDC", resolveCurrency({ currency: null, tokenAddress: null }).symbol === "USDC");
  ok("unsupported symbol rejected", throws(() => resolveCurrency({ currency: "USDT" })));
  ok("arbitrary ERC-20 address rejected", throws(() => resolveCurrency({ tokenAddress: OTHER })));
  ok("USDC symbol + EURC address mismatch rejected", throws(() => resolveCurrency({ currency: "USDC", tokenAddress: EURC })));
  ok("EURC symbol + USDC address mismatch rejected", throws(() => resolveCurrency({ currency: "EURC", tokenAddress: USDC })));

  console.log("\n[S2] settle Path B is token-native");
  const settle = read("src/app/api/payments/settle/route.ts");
  ok("settle resolves via canonical resolver", settle.includes("resolveRowCurrency("));
  ok("settle imports from canonical module (no second token table)", settle.includes("src/lib/tokens/resolveCurrency"));
  ok("native Circle transfer uses resolved address", settle.includes("tokenAddress: token.address"));
  ok("fallback ERC-20 uses resolved contract address", settle.includes("contractAddress: token.address"));
  ok("amounts use resolved decimals (native)", settle.includes("toFixed(token.decimals)"));
  ok("amounts use resolved decimals (fallback parseUnits)", settle.includes("parseUnits(payment.amount.toFixed(token.decimals), token.decimals)"));
  ok("no hardcoded USDC transfer token left in Path B", !settle.includes("tokenAddress: USDC_ARC") && !settle.includes("contractAddress: USDC_ARC"));
  ok("no EURC literal in settle (resolver owns the table)", !settle.includes(EURC_LITERAL));
  ok("no SwapPool in settle (never converted)", !/from\s+['"][^'"]*[Ss]wap[Pp]ool[^'"]*['"]/.test(settle) && !/swapPool\s*\(/i.test(settle));
  ok("no client-controlled token (no body/data tokenAddress)", !settle.includes("body.tokenAddress") && !settle.includes("data.tokenAddress"));
  ok("SUCCESS preserves canonical currency + tokenAddress", settle.includes("currency: token.symbol") && settle.includes("tokenAddress: token.address"));

  console.log("\n[S3] settle guards unchanged (auth / expiry / idempotency)");
  ok("payer-control guard present (403, no drain)", settle.includes("payerAuthorized") && settle.includes("You are not a party to this payment") && settle.includes("status: 403"));
  ok("no default-payer fallback reintroduced", !settle.includes("payerWalletId = payerWalletId ||") && settle.includes("refusing to debit a shared default wallet"));
  ok("expiry behavior unchanged", settle.includes("has expired") && settle.includes("status: 'EXPIRED'"));
  ok("atomic PROCESSING_ONCHAIN lock unchanged", settle.includes("PROCESSING_ONCHAIN") && settle.includes("lock.count === 0"));
  ok("idempotency 409 unchanged", settle.includes("Payment already processing or settled") && settle.includes("status: 409"));

  console.log("\n[S4] CCTP stays explicitly USDC-only");
  ok("settle Path A rejects non-USDC before bridging", settle.includes("token.symbol !== 'USDC'") && settle.includes("CCTP settlement is USDC-only"));
  const cctp = read("src/app/api/payments/cctp-settle/route.ts");
  ok("cctp-settle resolves via canonical resolver", cctp.includes("resolveRowCurrency("));
  ok("cctp-settle rejects non-USDC invoices", cctp.includes("cctpToken.symbol !== 'USDC'") && cctp.includes("CCTP settlement is USDC-only"));
  ok("cctp-settle rejects unsupported token identity", cctp.includes("Unsupported settlement token"));
  ok("cctp amount check stays USDC-denominated with documented reason", cctp.includes("USDC_DECIMALS") && /gate above/.test(cctp));
  ok("no EURC literal in cctp-settle (no fake EURC CCTP path)", !cctp.includes(EURC_LITERAL));

  console.log("\n[V1] verify-onchain matches ONLY the invoice token");
  const verify = read("src/app/api/payments/verify-onchain/route.ts");
  ok("verify resolves via canonical resolver", verify.includes("resolveRowCurrency("));
  ok("verify rejects unsupported token identity (400)", verify.includes("Unsupported settlement token"));
  ok("Transfer log filtered by resolved contract address", verify.includes("log.address.toLowerCase() !== token.address.toLowerCase()"));
  ok("no hardcoded USDC contract in matching", !verify.includes("USDC_CONTRACT") && !verify.includes("0x3600000000000000000000000000000000000000"));
  ok("expected amount uses resolved decimals", verify.includes("parseUnits(payment.amount.toString(), token.decimals)"));
  ok("mismatch error names the invoice token", verify.includes("No matching ${token.symbol} transfer"));
  ok("wrong-token logs are skipped, never matched", verify.includes("continue; // not a Transfer log, skip") || verify.includes("continue;"));

  console.log("\n[V1] cross-token matrix (simulated matching rule)");
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
  ok("decimal handling uses resolver (parseUnits 6 for both today)", parseUnits("0.01", resolveRowCurrency({ currency: "EURC" }).decimals) === parseUnits("0.01", 6));

  console.log("\n[V2] fee leg + PaymentLog identity");
  ok("fee math is token-unit based (no 1 EURC == 1 USDC assumption)", verify.includes("unitsPerToken") && /never treated as 1 USDC/.test(verify));
  ok("fee balance reads use resolved token contract", verify.includes("readTokenBalance(") && verify.includes("address: token.address"));
  ok("fee debit passes resolved token to Circle transfer", verify.includes("tokenAddress: token.address") && verify.includes("decimals: token.decimals"));
  ok("no hardcoded USDC address left in verify", !verify.includes("USDC_ARC") && !verify.includes("0x3600000000000000000000000000000000000000"));
  ok("SUCCESS preserves canonical currency + tokenAddress", verify.includes("currency: token.symbol") && verify.includes("tokenAddress: token.address"));
  const transfers = read("src/lib/circle/transfers.ts");
  ok("Circle helper backward-compatible (USDC default)", transfers.includes("tokenAddress = USDC_ARC") && transfers.includes("decimals = 6"));

  console.log("\n[W1] CheckoutWidget minimal token-native change");
  const widget = read("src/components/CheckoutWidget.tsx");
  ok("transfer uses resolved token address (USDC fallback for legacy rows)", widget.includes("payment.token?.address || USDC_CONTRACT"));
  ok("transfer uses resolved decimals (USDC fallback)", widget.includes("payment.token?.decimals ?? USDC_DECIMALS"));
  ok("Pay button no longer blocked for EURC", !widget.includes("disabled={isEurc ||") && !widget.includes("EURC not yet supported"));
  ok("CCTP tab blocked for EURC (USDC-only) with documented reason", widget.includes("isEurc || !cctpTxHash.trim()") && /CCTP is intentionally USDC-only/.test(widget));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
