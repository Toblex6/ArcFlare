/**
 * phase2d-ledger-tests.ts
 *
 * Multicurrency Phase 2D — Ledger and Accounting (narrow implementation track).
 * Goal: the accounting layer preserves token identity for USDC and EURC.
 *
 *   D1  canonical identity: resolver + ledger helpers (USDC / EURC /
 *       legacy NULL -> USDC, mismatch + unsupported throw, never inferred
 *       from amount, never 1 EURC = 1 USDC).
 *   D2  ledger writes (live DB): USDC entry, EURC entry, legacy-default entry,
 *       tokenAddress persistence, amount units preserved verbatim, mismatch /
 *       unsupported rejections, dedupe replay + unchanged key shape.
 *   D3  writers audit (static): every recordLedgerEntry call site carries
 *       explicit token identity; genuinely USDC-only systems stay USDC-only;
 *       scheduled/nano/settle write no ledger rows with a guessed token.
 *   D4  readers (static + live DB): treasury byToken splits USDC / EURC /
 *       legacy, hasMixedTokens flag, top-level totals preserved;
 *       economics display shows per-entry token + legacy marker + by-token
 *       panel; trust/track-record expose per-token volume.
 *   D5  dedupe + schema discipline: buildDedupeKey carries no token qualifier;
 *       no migration touches the dedupeKey unique constraint.
 *
 * Run: npx tsx scripts/phase2d-ledger-tests.ts
 */

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import {
  resolveCurrency,
  resolveRowCurrency,
  tokenAddressFor,
} from "@/lib/tokens/resolveCurrency";
import { SUPPORTED_TOKENS } from "@/lib/tokens/supportedTokens";
import {
  buildDedupeKey,
  recordLedgerEntry,
  resolveLedgerToken,
  usdcLedgerIdentity,
} from "@/lib/ledger/ledgerService";
import { prisma } from "@/lib/prisma";

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
function throwsAsync(fn: () => Promise<unknown>): Promise<boolean> {
  return fn().then(() => false).catch(() => true);
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const USDC_ADDR = SUPPORTED_TOKENS.USDC.address;
const EURC_ADDR = SUPPORTED_TOKENS.EURC.address;
const rndTx = () => `0x${randomBytes(32).toString("hex")}`;

async function main() {
  console.log("\n[D1] canonical token identity (never inferred from amount)");
  ok("USDC symbol resolves to canonical address + 6 decimals",
    resolveCurrency({ currency: "USDC" }).address === USDC_ADDR &&
    resolveCurrency({ currency: "USDC" }).decimals === 6);
  ok("EURC symbol resolves to canonical address + 6 decimals",
    resolveCurrency({ currency: "EURC" }).address === EURC_ADDR &&
    resolveCurrency({ currency: "EURC" }).decimals === 6);
  ok("legacy NULL/NULL -> USDC", resolveCurrency({ currency: null, tokenAddress: null }).symbol === "USDC");
  ok("legacy row USDC + NULL address -> USDC",
    resolveRowCurrency({ currency: "USDC", tokenAddress: null }).address === USDC_ADDR);
  ok("read-model row EURC + NULL address resolves EURC identity",
    resolveRowCurrency({ currency: "EURC", tokenAddress: null }).symbol === "EURC");
  ok("USDC symbol + EURC address throws (no silent cross-token)",
    throws(() => resolveCurrency({ currency: "USDC", tokenAddress: EURC_ADDR })));
  ok("EURC symbol + USDC address throws",
    throws(() => resolveCurrency({ currency: "EURC", tokenAddress: USDC_ADDR })));
  ok("arbitrary ERC-20 address throws",
    throws(() => resolveCurrency({ tokenAddress: "0x1111111111111111111111111111111111111111" })));
  ok("usdcLedgerIdentity carries canonical USDC symbol + address",
    usdcLedgerIdentity().token === "USDC" && usdcLedgerIdentity().tokenAddress === USDC_ADDR);
  const usdcRow = resolveLedgerToken({ token: "USDC", tokenAddress: USDC_ADDR });
  ok("resolveLedgerToken: USDC row -> USDC, not legacy",
    usdcRow.symbol === "USDC" && usdcRow.address === USDC_ADDR && usdcRow.legacy === false);
  const eurcRow = resolveLedgerToken({ token: "EURC", tokenAddress: EURC_ADDR });
  ok("resolveLedgerToken: EURC row -> EURC, not legacy",
    eurcRow.symbol === "EURC" && eurcRow.address === EURC_ADDR && eurcRow.legacy === false);
  const legacyRow = resolveLedgerToken({ token: "USDC", tokenAddress: null });
  ok("resolveLedgerToken: legacy NULL -> USDC + legacy flag",
    legacyRow.symbol === "USDC" && legacyRow.address === USDC_ADDR && legacyRow.legacy === true);

  // ── D2 live DB writes ──────────────────────────────────────────────────
  console.log("\n[D2] ledger writes preserve token identity (live DB)");
  const tag = `phase2d_${Date.now().toString(36)}`;
  const agent = await (prisma as any).agentRegistry.create({
    data: {
      name: `${tag} ledger probe`,
      tokenId: `${tag}_${randomBytes(4).toString("hex")}`,
      scaAddress: `0x${randomBytes(20).toString("hex")}`,
      ownerNode: "phase2d-test",
      status: "ACTIVE",
    },
  });
  const agentId: number = agent.id;
  try {
    // USDC entry — explicit identity from the (USDC-only) originating event.
    const usdcTx = rndTx();
    const usdcAmt = 1_500_000n; // 1.5 token units at 6 decimals
    const w1 = await recordLedgerEntry({
      ...usdcLedgerIdentity(),
      agentRegistryId: agentId,
      type: "REVENUE",
      amount: usdcAmt,
      direction: "CREDIT",
      txHash: usdcTx,
      description: `${tag} usdc revenue`,
    });
    ok("USDC write accepted", !!w1.id && w1.replayed === false);
    const usdcDb = await (prisma as any).agentLedgerEntry.findUnique({ where: { dedupeKey: buildDedupeKey({ agentRegistryId: agentId, type: "REVENUE", amount: usdcAmt, direction: "CREDIT", txHash: usdcTx }) } });
    ok("USDC entry persists symbol + canonical tokenAddress",
      !!usdcDb && usdcDb.token === "USDC" && usdcDb.tokenAddress === USDC_ADDR,
      JSON.stringify({ token: usdcDb?.token, tokenAddress: usdcDb?.tokenAddress }));
    ok("USDC amount units preserved verbatim (no conversion)",
      !!usdcDb && usdcDb.amount === usdcAmt.toString(), String(usdcDb?.amount));

    // EURC entry — identity comes from the originating multi-token event,
    // never inferred from the amount.
    const eurcTx = rndTx();
    const eurcAmt = 2_250_000n; // deliberately != USDC amount: identity is not amount-derived
    const w2 = await recordLedgerEntry({
      token: "EURC",
      tokenAddress: tokenAddressFor("EURC"),
      agentRegistryId: agentId,
      type: "REVENUE",
      amount: eurcAmt,
      direction: "CREDIT",
      txHash: eurcTx,
      description: `${tag} eurc revenue`,
    });
    ok("EURC write accepted (multi-token event identity)", !!w2.id && w2.replayed === false);
    const eurcDb = await (prisma as any).agentLedgerEntry.findUnique({ where: { dedupeKey: buildDedupeKey({ agentRegistryId: agentId, type: "REVENUE", amount: eurcAmt, direction: "CREDIT", txHash: eurcTx }) } });
    ok("EURC entry persists symbol + canonical tokenAddress (not USDC)",
      !!eurcDb && eurcDb.token === "EURC" && eurcDb.tokenAddress === EURC_ADDR,
      JSON.stringify({ token: eurcDb?.token, tokenAddress: eurcDb?.tokenAddress }));
    ok("EURC amount units preserved verbatim (no FX, no 1:1 assumption)",
      !!eurcDb && eurcDb.amount === eurcAmt.toString(), String(eurcDb?.amount));

    // Legacy-default write (no token fields — pre-2D caller shape).
    const legacyTx = rndTx();
    const w3 = await recordLedgerEntry({
      agentRegistryId: agentId,
      type: "ADJUSTMENT",
      amount: 500_000n,
      direction: "CREDIT",
      txHash: legacyTx,
      description: `${tag} legacy-shape write`,
    });
    ok("legacy-shape write accepted", !!w3.id);
    const legacyDb = await (prisma as any).agentLedgerEntry.findUnique({ where: { dedupeKey: buildDedupeKey({ agentRegistryId: agentId, type: "ADJUSTMENT", amount: 500_000n, direction: "CREDIT", txHash: legacyTx }) } });
    ok("legacy-shape write backfills canonical USDC (never NULL)",
      !!legacyDb && legacyDb.token === "USDC" && legacyDb.tokenAddress === USDC_ADDR,
      JSON.stringify({ token: legacyDb?.token, tokenAddress: legacyDb?.tokenAddress }));

    // A genuine legacy row (NULL tokenAddress, written before 2D).
    const legacyNullTx = rndTx();
    await (prisma as any).agentLedgerEntry.create({
      data: {
        agentRegistryId: agentId,
        type: "GAS",
        amount: "1000",
        token: "USDC",
        tokenAddress: null,
        direction: "DEBIT",
        txHash: legacyNullTx.toLowerCase(),
        dedupeKey: `${legacyNullTx.toLowerCase()}:${agentId}:GAS`,
        description: `${tag} simulated pre-2D row`,
      },
    });
    const legacyNullDb = await (prisma as any).agentLedgerEntry.findUnique({ where: { dedupeKey: `${legacyNullTx.toLowerCase()}:${agentId}:GAS` } });
    ok("simulated pre-2D NULL row resolves to USDC via reader",
      !!legacyNullDb && resolveLedgerToken(legacyNullDb).symbol === "USDC" && resolveLedgerToken(legacyNullDb).legacy === true);

    // No silent cross-token accounting: mismatched / unsupported writes throw.
    ok("USDC symbol + EURC address write throws",
      await throwsAsync(() => recordLedgerEntry({
        token: "USDC", tokenAddress: EURC_ADDR, agentRegistryId: agentId,
        type: "REVENUE", amount: 1n, direction: "CREDIT", txHash: rndTx(),
      })));
    ok("unsupported token address write throws",
      await throwsAsync(() => recordLedgerEntry({
        token: "USDC", tokenAddress: "0x1111111111111111111111111111111111111111",
        agentRegistryId: agentId, type: "REVENUE", amount: 1n, direction: "CREDIT", txHash: rndTx(),
      })));

    // Dedupe unchanged: same tx+agent+type replays; key shape has no token.
    const replay = await recordLedgerEntry({
      ...usdcLedgerIdentity(),
      agentRegistryId: agentId,
      type: "REVENUE",
      amount: usdcAmt,
      direction: "CREDIT",
      txHash: usdcTx,
      description: `${tag} duplicate`,
    });
    ok("duplicate write replays (no double-credit)", replay.replayed === true && replay.id === w1.id);
    ok("dedupe key shape unchanged (txHash:agentId:TYPE, no token qualifier)",
      buildDedupeKey({ agentRegistryId: agentId, type: "REVENUE", amount: 1n, direction: "CREDIT", txHash: usdcTx }) === `${usdcTx.toLowerCase()}:${agentId}:REVENUE`);
    // One tx CAN carry distinct types (lock + spend) — including across tokens.
    const crossType = await recordLedgerEntry({
      token: "EURC", tokenAddress: EURC_ADDR,
      agentRegistryId: agentId, type: "AGENT_PAYMENT", amount: 7n, direction: "DEBIT", txHash: eurcTx,
    });
    ok("same tx + different type coexists (per-type dedupe, incl. cross-token)",
      crossType.replayed === false);

    // Readers: treasury splits by token; top-level shape preserved.
    const { computeTreasuryView, getRecentEntries } = await import("@/lib/ledger/treasuryService");
    const view = await computeTreasuryView(agentId);
    ok("treasury exposes byToken map", !!view.byToken && typeof view.byToken === "object");
    // USDC revenue = the USDC REVENUE entry + the legacy-shape ADJUSTMENT
    // credit (ADJUSTMENT CREDIT counts as revenue — same rule as top level).
    ok("USDC slice holds exactly the USDC revenue (REVENUE + ADJUSTMENT, nothing else)",
      view.byToken?.USDC?.revenue === (usdcAmt + 500_000n).toString(), JSON.stringify(view.byToken?.USDC));
    ok("EURC slice holds exactly the EURC revenue (not merged into USDC)",
      view.byToken?.EURC?.revenue === eurcAmt.toString(), JSON.stringify(view.byToken?.EURC));
    ok("USDC slice carries canonical address + decimals",
      view.byToken?.USDC?.tokenAddress === USDC_ADDR && view.byToken?.USDC?.decimals === 6);
    ok("EURC slice carries canonical address + decimals",
      view.byToken?.EURC?.tokenAddress === EURC_ADDR && view.byToken?.EURC?.decimals === 6);
    ok("mixed tokens flagged (top-level must not be read as one currency)",
      view.hasMixedTokens === true && view.tokens.includes("USDC") && view.tokens.includes("EURC"));
    ok("legacy NULL rows counted, resolved as USDC",
      view.legacyEntryCount >= 1 && (view.byToken?.USDC?.legacyEntries ?? 0) >= 1,
      JSON.stringify({ legacyEntryCount: view.legacyEntryCount, usdcLegacy: view.byToken?.USDC?.legacyEntries }));
    ok("top-level totals preserved (backward compatible)",
      ["revenue", "costs", "treasuryBalance", "availableBalance", "profit", "received", "sent", "entryCount", "raw"].every((k) => (view as any)[k] !== undefined));
    const recent = await getRecentEntries(agentId, 20);
    ok("history entries expose token identity",
      recent.length > 0 && recent.every((e: any) => typeof e.token === "string" && "tokenAddress" in e),
      JSON.stringify(recent.slice(0, 2).map((e: any) => ({ token: e.token, tokenAddress: e.tokenAddress }))));
    ok("history distinguishes USDC / EURC / legacy NULL->USDC",
      recent.some((e: any) => e.token === "USDC" && e.tokenAddress === USDC_ADDR) &&
      recent.some((e: any) => e.token === "EURC" && e.tokenAddress === EURC_ADDR) &&
      recent.some((e: any) => e.tokenAddress === null && resolveLedgerToken(e).symbol === "USDC"));
  } finally {
    await (prisma as any).agentLedgerEntry.deleteMany({ where: { agentRegistryId: agentId } }).catch(() => {});
    await (prisma as any).agentRegistry.delete({ where: { id: agentId } }).catch(() => {});
  }

  // ── D3 writers audit (static) ──────────────────────────────────────────
  console.log("\n[D3] every monetary writer carries explicit token identity");
  const writerFiles = [
    "src/lib/agents/agentPay.ts",
    "src/lib/wallet/transactionResume.ts",
    "src/app/api/jobs/route.ts",
    "src/app/api/jobs/fund/route.ts",
    "src/app/api/jobs/[jobId]/fund/route.ts",
    "src/app/api/jobs/complete/route.ts",
    "src/app/api/jobs/nanopay/release/route.ts",
    "src/app/api/escrow/create/route.ts",
    "src/app/api/escrow/release/route.ts",
    "src/app/api/escrow/refund/route.ts",
    "src/app/api/escrow/[reference]/beneficiary-confirm/route.ts",
    "src/app/api/payroll/run/route.ts",
    "src/app/api/agents/[id]/treasury/credit/route.ts",
  ];
  for (const f of writerFiles) {
    const src = read(f);
    const calls = [...src.matchAll(/recordLedgerEntry\(\{/g)].length;
    // Explicit identity = canonical USDC spread (USDC-only events) or the
    // originating event's own resolved token (multi-token events: batch token).
    const usdcSpreads = [...src.matchAll(/usdcLedgerIdentity\(\)/g)].length;
    const eventTokens = [...src.matchAll(/tokenAddress:\s*(token|batchToken)\.address/g)].length;
    const identities = usdcSpreads + eventTokens;
    ok(`${f}: ${calls} write(s) all carry explicit token identity`, calls > 0 && identities >= calls, `${calls} calls / ${identities} identities`);
  }
  const autoRep = read("src/lib/trust/autoReputation.ts");
  ok("autoReputation guard row persists canonical USDC address",
    autoRep.includes('token: "USDC"') && autoRep.includes('tokenAddressFor("USDC")'));
  // Multi-token events carry their own resolved token (never the USDC helper).
  const resumeSrc = read("src/lib/wallet/transactionResume.ts");
  ok("payroll resume resolves the batch token (single-token batch, incl. EURC)",
    resumeSrc.includes("resolveRowCurrency({ currency: batch.currency") && resumeSrc.includes("token: batchToken.symbol"));
  ok("payroll resume scales amounts with the token's own decimals",
    resumeSrc.includes("10 ** batchToken.decimals"));
  // No writer infers token from amount: no recordLedgerEntry call derives its
  // token field from an amount variable.
  let inferred = 0;
  for (const f of writerFiles) {
    const src = read(f);
    for (const m of src.matchAll(/recordLedgerEntry\(\{([\s\S]{0,600}?)\}\)/g)) {
      if (/token:\s*[^"'\s][^,]*amount/i.test(m[1]) || /tokenAddress:\s*[^t\s][^,]*amount/i.test(m[1])) inferred++;
    }
  }
  ok("no writer infers token from amount", inferred === 0, `${inferred} suspect call(s)`);
  // Genuinely USDC-only systems stay explicitly USDC-only.
  ok("agent payments reject non-USDC tokens", read("src/lib/agents/agentPay.ts").includes("agent payments use native USDC"));
  ok("escrow stays USDC-denominated", read("src/app/api/escrow/create/route.ts").includes("currency: 'USDC'"));
  const nanoSettle = read("src/app/api/payments/nano/settle/route.ts");
  ok("nano settlement carries canonical token identity (never a hardcoded single token)",
    nanoSettle.includes("tokenAddress: token.address") && !nanoSettle.includes("tokenAddress: USDC_ARC"),
    "must persist the pair's resolved token, not a constant");
  ok("payroll batches stay USDC-denominated", read("prisma/schema.prisma").includes('currency       String    @default("USDC")'));
  ok("streams open USDC-only", read("src/app/api/jobs/nanopay/open/route.ts").includes("token: USDC_CONTRACT"));
  ok("scheduled writes no ledger rows (nothing to mislabel)", !read("src/app/api/payments/scheduled/run/route.ts").includes("recordLedgerEntry"));
  // Ledger core never converts, never assumes parity.
  const ledgerSrc = read("src/lib/ledger/ledgerService.ts");
  ok("ledger persists amounts verbatim (no FX)", ledgerSrc.includes("amount: params.amount.toString()"));
  ok("ledger resolves identity through the canonical resolver", ledgerSrc.includes("resolveCurrency({ currency: params.token"));
  ok("ledger never converts between tokens (no FX identifiers)",
    !/exchangeRate|fxRate|convertTo|_toUsdc|toUSDC\(|EURC_TO_USDC|USDC_TO_EURC/i.test(ledgerSrc));

  // ── D4 readers (static) ────────────────────────────────────────────────
  console.log("\n[D4] economics/history views distinguish tokens");
  const treasurySrc = read("src/lib/ledger/treasuryService.ts");
  ok("treasury exposes byToken + tokens + hasMixedTokens + legacyEntryCount",
    treasurySrc.includes("byToken") && treasurySrc.includes("hasMixedTokens") && treasurySrc.includes("legacyEntryCount"));
  ok("treasury resolves rows via canonical reader (legacy NULL -> USDC)",
    treasurySrc.includes("resolveRowCurrency"));
  const agentsPage = read("src/app/agents/page.tsx");
  ok("economics recent-entries show token symbol + legacy marker",
    agentsPage.includes("{e.token || 'USDC'}") && agentsPage.includes("(legacy)"));
  ok("economics shows a by-token panel (mixed-token warning)",
    agentsPage.includes("Balances by token"));
  const trustSrc = read("src/lib/trust/trustScore.ts");
  const trackSrc = read("src/lib/trust/trackRecord.ts");
  ok("trust exposes per-token volume", trustSrc.includes("validatedVolumeByToken"));
  ok("track-record exposes per-token volume", trackSrc.includes("validatedVolumeByToken"));

  // ── D5 dedupe + schema discipline ──────────────────────────────────────
  console.log("\n[D5] dedupe keys unchanged, no speculative schema change");
  const ledgerFlat = ledgerSrc.replace(/\r\n/g, "\n");
  const dedupeStart = ledgerFlat.indexOf("export function buildDedupeKey");
  const dedupeEnd = ledgerFlat.indexOf("\n}\n", dedupeStart);
  const dedupeFn = ledgerFlat.slice(dedupeStart, dedupeEnd);
  ok("buildDedupeKey carries no token qualifier", !/token/i.test(dedupeFn), dedupeFn.slice(0, 200));
  const schema = read("prisma/schema.prisma");
  const ledgerModel = schema.slice(schema.indexOf("model AgentLedgerEntry"), schema.indexOf("model AgentLedgerEntry") + 2500);
  ok("AgentLedgerEntry.token untouched (USDC default)", /token\s+String\s+@default\("USDC"\)/.test(ledgerModel));
  ok("AgentLedgerEntry.tokenAddress additive nullable", /tokenAddress\s+String\?/.test(ledgerModel));
  ok("dedupeKey stays the single unique constraint", /dedupeKey\s+String\s+@unique/.test(ledgerModel));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error("phase2d-ledger-tests crashed:", e); process.exitCode = 1; });
