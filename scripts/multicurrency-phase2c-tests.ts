/**
 * multicurrency-phase2c-tests.ts
 *
 * Track C — Multicurrency Phase 2C (nano + scheduled + payroll token execution).
 * Unit + static proofs (no dev server / DB / chain required, no live
 * transactions fabricated):
 *   C1  resolver isolation: USDC means USDC, EURC means EURC — distinct
 *       canonical addresses, mismatch rejection, legacy NULL -> USDC.
 *   C2  nano isolation + mixed-token batch splitting (unit): pure
 *       groupNanoRowsByToken splits mixed rows per token, never merges.
 *   C3  nano settle (static): token-scoped claim/lock/resume, transfer moves
 *       the row's resolved token, PaymentLog persists currency + tokenAddress,
 *       decimals from the resolver, alien-row wrong-token rejection.
 *   C4  scheduled (static): create persists currency + tokenAddress; the
 *       runner resolves each row's token and transfers it (no hardcoded USDC
 *       for EURC rows); idempotency/status/retries/authorization preserved.
 *   C5  payroll lifecycle (static): run is single-token end to end (storage,
 *       funding transfer, fee-amount math, external payload, settlement
 *       results, messaging, webhook, ledger, batch state); x402 fund path
 *       keeps its USDC-only gate with explicit USDC persistence.
 *   C6  wrong-token rejection (unit): symbol/address mismatches throw; replay
 *       across tokens refused; mixed batches never merge.
 *   C7  decimals (unit + static): resolver decimals drive amount math.
 *   C8  payment-log token persistence (static): nano + payroll logs carry
 *       currency + tokenAddress.
 *   C9  idempotency/retry preserved (static): nano batchRef lock + release,
 *       scheduled atomic claim + stale reclaim, payroll idemRef replay.
 *
 * Run: npx tsx scripts/multicurrency-phase2c-tests.ts
 */

import fs from "fs";
import path from "path";
import {
  resolveCurrency,
  resolveRowCurrency,
} from "@/lib/tokens/resolveCurrency";
import { SUPPORTED_TOKENS } from "@/lib/tokens/supportedTokens";
import {
  groupNanoRowsByToken,
  resolveNanoToken,
} from "@/lib/nanopayment";

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
const AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERCHANT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function main() {
  console.log("\n[C1] resolver isolation — USDC means USDC, EURC means EURC");
  ok("USDC and EURC have distinct canonical addresses", USDC !== EURC, `${USDC} vs ${EURC}`);
  ok("USDC resolves to its own address", resolveCurrency({ currency: "USDC" }).address === USDC);
  ok("EURC resolves to its own address", resolveCurrency({ currency: "EURC" }).address === EURC);
  ok("explicit EURC address resolves EURC (not USDC)", resolveCurrency({ tokenAddress: EURC }).symbol === "EURC");
  ok("USDC symbol + EURC address throws (never mixed)", throws(() => resolveCurrency({ currency: "USDC", tokenAddress: EURC })));
  ok("EURC symbol + USDC address throws (never mixed)", throws(() => resolveCurrency({ currency: "EURC", tokenAddress: USDC })));
  ok("historical NULL currency + NULL address -> USDC", resolveCurrency({ currency: null, tokenAddress: null }).symbol === "USDC");
  ok("legacy nano row (currency USDC, NULL address) -> USDC", resolveNanoToken({ currency: "USDC", tokenAddress: null }).address === USDC);
  ok("legacy nano row (NULL/NULL) -> USDC", resolveNanoToken({}).address === USDC);
  ok("EURC nano row resolves EURC identity", resolveNanoToken({ currency: "EURC", tokenAddress: null }).symbol === "EURC");

  console.log("\n[C2] nano mixed-token batch splitting (unit)");
  const mixed = [
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.4, currency: "USDC", tokenAddress: USDC },
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.7, currency: "EURC", tokenAddress: EURC },
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.5, currency: "USDC", tokenAddress: USDC },
    // Legacy row: NULL tokenAddress must join the USDC group, never EURC.
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.1, currency: "USDC", tokenAddress: null },
  ];
  const groups = groupNanoRowsByToken(mixed as any);
  ok("mixed USDC+EURC rows split into exactly 2 groups", groups.length === 2, `got ${groups.length}`);
  const usdcGroup = groups.find((g) => g.currency === "USDC");
  const eurcGroup = groups.find((g) => g.currency === "EURC");
  ok("USDC group carries the canonical USDC address", usdcGroup?.tokenAddress === USDC);
  ok("EURC group carries the canonical EURC address", eurcGroup?.tokenAddress === EURC);
  ok("USDC rows combine (0.4+0.5+legacy 0.1 = 1.0)", usdcGroup?.total === 1.0, `got ${usdcGroup?.total}`);
  ok("EURC group holds only its 0.7 row", eurcGroup?.total === 0.7 && eurcGroup?.rows.length === 1);
  ok("legacy NULL-address row joined USDC (3 rows), never EURC", usdcGroup?.rows.length === 3);
  const sameToken = [
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.2, currency: "EURC", tokenAddress: EURC },
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.3, currency: "EURC", tokenAddress: EURC },
  ];
  ok("same-token rows stay one group", groupNanoRowsByToken(sameToken as any).length === 1);
  const otherMerchant = [
    { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 0.2, currency: "USDC", tokenAddress: USDC },
    { agentSCA: AGENT, merchantSCA: "0xcccccccccccccccccccccccccccccccccccccccc", amount: 0.2, currency: "USDC", tokenAddress: USDC },
  ];
  ok("same token, different merchant = separate groups (agent+merchant+token key)", groupNanoRowsByToken(otherMerchant as any).length === 2);

  console.log("\n[C3] nano settle — token-scoped execution (static)");
  const nanoLib = read("src/lib/nanopayment.ts");
  const nanoCreate = read("src/app/api/payments/nano/route.ts");
  const nanoSettle = read("src/app/api/payments/nano/settle/route.ts");
  ok("lib resolves every row through the canonical resolver", nanoLib.includes("resolveRowCurrency"));
  ok("lib groups by agent + merchant + token", nanoLib.includes("token.address.toLowerCase()"));
  ok("getUnsettledPairs returns per-token triples", nanoLib.includes("Promise<NanoBatchKey[]>"));
  ok("record keeps currency + tokenAddress", nanoLib.includes("currency: token.symbol") && nanoLib.includes("tokenAddress: token.address"));
  ok("create route resolves currency/tokenAddress via resolver", nanoCreate.includes("resolveCurrency({ currency, tokenAddress })"));
  ok("create route rejects bad token pairs with 400", nanoCreate.includes("status: 400"));
  ok("create route scopes balance/threshold per token", nanoCreate.includes("getUnsettledBalance(agentSCA, merchantSCA, {"));
  ok("settle reads token identity without touching validation.ts", nanoSettle.includes("rawBody") && nanoSettle.includes("resolveCurrency({ currency: rawBody.currency"));
  ok("settle locks only rows resolving to the settlement token", nanoSettle.includes("candidates.filter((n) => logMatchesToken(n as any, token))"));
  ok("settle rejects alien (wrong-token) rows before any transfer", nanoSettle.includes("are not ${token.symbol}"));
  ok("settle transfers the resolved token address (never hardcoded USDC)", nanoSettle.includes("tokenAddress: token.address") && nanoSettle.includes("contractAddress: token.address"));
  ok("settle PaymentLog persists currency + tokenAddress", nanoSettle.includes("currency: token.symbol,") && nanoSettle.includes("tokenAddress: token.address,"));
  ok("no hardcoded USDC_ARC constant remains in nano settle", !nanoSettle.includes("USDC_ARC"));
  ok("stale-lock recovery + resume are token-scoped", nanoSettle.includes("recoverStaleLocks(agentSCA, merchantSCA, token)") && nanoSettle.includes("resumeExistingTransaction(agentSCA, merchantSCA, token)"));
  ok("mixed pair settles one transfer per token (never merged)", nanoSettle.includes("mixedTokens: true") && nanoSettle.includes("Settled ${settlements"));
  ok("autoSettle iterates per-token pairs", nanoSettle.includes("p.tokenAddress.toLowerCase()"));
  ok("ownership + no-default-payer guards preserved", nanoSettle.includes("verifyCallerControlsAddress") && nanoSettle.includes("DEFAULT_PAYER_WALLET_ID"));

  console.log("\n[C4] scheduled — per-row token execution (static)");
  const schedCreate = read("src/app/api/payments/scheduled/route.ts");
  const schedRun = read("src/app/api/payments/scheduled/run/route.ts");
  ok("create resolves currency/tokenAddress via resolver", schedCreate.includes("resolveCurrency({ currency, tokenAddress })"));
  ok("create persists currency + tokenAddress", schedCreate.includes("currency: token.symbol,") && schedCreate.includes("tokenAddress: token.address,"));
  ok("create rejects bad token pairs with 400", schedCreate.includes("status: 400"));
  ok("runner resolves EACH row's token (no batch-level assumption)", schedRun.includes("resolveRowCurrency(scheduled)"));
  ok("runner transfers the row's token (native path)", schedRun.includes("tokenAddress: token.address,"));
  ok("runner transfers the row's token (ERC-20 fallback path)", schedRun.includes("contractAddress: token.address,"));
  ok("no hardcoded USDC_ARC transfer remains in the runner", !schedRun.includes("USDC_ARC"));
  ok("unresolvable-token rows fail closed (never paid in wrong asset)", schedRun.includes("has an unresolvable token"));
  ok("results + webhook carry currency/tokenAddress", schedRun.includes("currency: execution.currency,") && schedRun.includes("tokenAddress: execution.tokenAddress,"));
  ok("idempotency preserved (atomic ACTIVE->PROCESSING claim)", schedRun.includes("status: 'PROCESSING', lastRunAt: now") && schedRun.includes("claim.count === 0"));
  ok("stale-claim reclaim preserved", schedRun.includes("STALE_CLAIM_MS"));
  ok("failure releases the claim (retry, no double-success)", schedRun.includes("data: { status: 'ACTIVE' }"));
  ok("fail-closed null payerWalletId preserved", schedRun.includes("has no resolved payer wallet"));
  ok("execution status transitions preserved (COMPLETED/ACTIVE)", schedRun.includes("isComplete ? 'COMPLETED' : 'ACTIVE'"));

  console.log("\n[C5] payroll lifecycle — single-token end to end (static)");
  const payrollRun = read("src/app/api/payroll/run/route.ts");
  const payrollFund = read("src/lib/payroll/payrollExecution.ts");
  ok("run resolves the batch token via the canonical resolver", payrollRun.includes("resolveCurrency({ currency, tokenAddress })"));
  ok("run rejects bad token pairs with 400", payrollRun.includes("error: tokenError.message"));
  ok("run persists currency + tokenAddress on the batch", payrollRun.includes("currency: token.symbol,") && payrollRun.includes("tokenAddress: token.address,"));
  ok("run transfers via transferToken (not hardcoded USDC)", payrollRun.includes("walletProvider.transferToken(") && payrollRun.includes("token.address,") && payrollRun.includes("token.decimals,"));
  ok("external-wallet payload targets the batch token contract", payrollRun.includes("to: token.address,"));
  ok("external amount math uses resolver decimals", payrollRun.includes("parseUnits(amountStr, token.decimals)"));
  ok("ledger entries carry token symbol + address", payrollRun.includes("token: token.symbol,") && payrollRun.includes("tokenAddress: token.address,"));
  const ledger = read("src/lib/ledger/ledgerService.ts");
  ok("ledger persists tokenAddress (additive, NULL-safe)", ledger.includes("tokenAddress: params.tokenAddress ?? null"));
  ok("provider interface exposes transferToken", read("src/lib/wallet/provider.ts").includes("transferToken(to: string, amount: string, tokenAddress: string, decimals: number"));
  ok("circle provider validates the token + uses canonical address", read("src/lib/wallet/circleProvider.ts").includes("getTokenByAddress(tokenAddress)"));
  ok("results + webhook + response carry currency/tokenAddress", payrollRun.includes("currency: token.symbol") && payrollRun.includes("tokenAddress: token.address"));
  ok("messaging uses the batch symbol (no hardcoded USDC totals)", !payrollRun.includes("${totalAmount} USDC") && payrollRun.includes("${totalAmount} ${token.symbol}"));
  ok("idempotency replay refuses cross-token retries", payrollRun.includes("refusing to replay across tokens"));
  ok("fund path keeps its USDC-only EURC gate (gateway genuinely USDC-only)", payrollFund.includes("resolvedToken?.symbol === 'EURC'"));
  ok("fund path persists explicit USDC currency + tokenAddress", payrollFund.includes('currency: "USDC",') && payrollFund.includes("tokenAddress: usdcAddress,"));

  console.log("\n[C6] wrong-token rejection (unit)");
  ok("USDT symbol throws", throws(() => resolveCurrency({ currency: "USDT" })));
  ok("arbitrary ERC-20 address throws", throws(() => resolveCurrency({ tokenAddress: "0x1111111111111111111111111111111111111111" })));
  ok("USDC/EURC cross-pairs throw both ways", throws(() => resolveCurrency({ currency: "USDC", tokenAddress: EURC })) && throws(() => resolveCurrency({ currency: "EURC", tokenAddress: USDC })));
  const hostile = { agentSCA: AGENT, merchantSCA: MERCHANT, amount: 1.0, currency: "USDC", tokenAddress: EURC } as any;
  // A row claiming USDC but addressed EURC is unresolvable by design: the
  // resolver throws on symbol/address mismatch, so the row can never be
  // grouped, locked, or transferred as either token (fail closed).
  ok("row claiming USDC but addressed EURC throws (never trusted as either token)", throws(() => resolveNanoToken(hostile)));
  ok("mixed batch containing a hostile row throws instead of merging", throws(() => groupNanoRowsByToken([hostile])));

  console.log("\n[C7] decimals (unit + static)");
  ok("USDC decimals resolve to 6", resolveCurrency({ currency: "USDC" }).decimals === 6);
  ok("EURC decimals resolve to 6", resolveCurrency({ currency: "EURC" }).decimals === 6);
  ok("legacy NULL row decimals resolve to 6", resolveCurrency({}).decimals === 6);
  ok("nano settle scales by token.decimals (never assumed 6)", nanoSettle.includes("10 ** token.decimals") && nanoSettle.includes("total.toFixed(token.decimals)"));
  ok("scheduled runner formats/parses by token.decimals", schedRun.includes("toFixed(token.decimals)") && schedRun.includes("parseUnits(amountStr, token.decimals)"));

  console.log("\n[C8] payment-log token persistence (static)");
  ok("nano PaymentLog create carries currency + tokenAddress", nanoSettle.includes("currency: token.symbol,") && nanoSettle.includes("tokenAddress: token.address,"));
  ok("payroll fund PaymentLog carries explicit USDC tokenAddress", payrollFund.includes("tokenAddress: usdcAddress,"));
  ok("schema adds tokenAddress to NanoPayment", read("prisma/schema.prisma").includes("model NanoPayment") && /model NanoPayment[\s\S]*?tokenAddress\s+String\?/.test(read("prisma/schema.prisma")));
  ok("schema adds tokenAddress to ScheduledPayment", /model ScheduledPayment[\s\S]*?tokenAddress\s+String\?/.test(read("prisma/schema.prisma")));
  ok("schema adds tokenAddress to PayrollBatch", /model PayrollBatch[\s\S]*?tokenAddress\s+String\?/.test(read("prisma/schema.prisma")));
  const mig = read("prisma/migrations/20260906000000_multicurrency_phase2c_token_address/migration.sql");
  ok("migration adds all three columns", mig.includes('ALTER TABLE "NanoPayment" ADD COLUMN "tokenAddress" TEXT;') && mig.includes('ALTER TABLE "ScheduledPayment" ADD COLUMN "tokenAddress" TEXT;') && mig.includes('ALTER TABLE "PayrollBatch" ADD COLUMN "tokenAddress" TEXT;'));
  ok("migration is additive-only (no DROP/DELETE/UPDATE/TRUNCATE)", !/DROP|DELETE|UPDATE|TRUNCATE/i.test(mig));

  console.log("\n[C9] idempotency / retry preserved (static)");
  ok("nano: batchRef lock is atomic + released on failure", nanoSettle.includes("data: { batchRef }") && nanoSettle.includes("data: { batchRef: null }"));
  ok("nano: SUBMITTED resume path preserved per token", nanoSettle.includes("status: 'SUBMITTED'") && nanoSettle.includes("resumed: true"));
  ok("scheduled: concurrent runners skip claimed rows", schedRun.includes("already claimed by another runner"));
  ok("payroll: idemRef replay + P2002 race replay preserved", payrollRun.includes("replayed: true") && payrollRun.includes("P2002"));
  ok("payroll: batch state machine untouched (PROCESSING/AWAITING/COMPLETED/FAILED/PARTIAL)", payrollRun.includes("'AWAITING_SIGNATURES'") && payrollRun.includes("'PARTIAL_FAILURE'"));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
