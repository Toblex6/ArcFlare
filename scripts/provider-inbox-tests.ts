/**
 * provider-inbox-tests.ts
 *
 * Provider-facing Direct Hire job inbox (Track 3 UI slice) — static + unit proofs.
 *
 * Proves (no dev server / DB / chain required):
 *   1. provider sees only jobs where providerSCA is controlled (UI loads
 *      GET /api/jobs/mine?role=provider; backend scopes by providerSCA within
 *      getCallerControlledAddresses — asserted on the route source).
 *   2. unrelated job is not rendered (UI renders exactly the normalized
 *      role=provider payload — no client-side merging of other roles).
 *   3. client-only controls are absent for provider role (no Approve/Fund/
 *      Complete affordances in the provider inbox block; getProviderNextAction
 *      never returns a client-signed manageAction).
 *   4. empty provider state works (explicit empty copy asserted).
 *   5. malformed/empty API response does not crash (normalizeMineResponse total).
 *   6. existing merchant Manage view remains unchanged (all Manage markers intact).
 *
 * Run: npx tsx scripts/provider-inbox-tests.ts
 */

import fs from "fs";
import path from "path";
import {
  budgetIsZero,
  formatBudgetUsdc,
  getProviderNextAction,
  getProviderStatusColor,
  normalizeMineResponse,
  normalizeProviderStatus,
  truncateAddress,
} from "@/lib/jobs/providerInbox";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

function main() {
  const page = read("src/app/jobs/page.tsx");
  const mine = read("src/app/api/jobs/mine/route.ts");

  console.log("\n[1] helpers — privacy-safe client identity");
  const addr = "0x1234567890abcdef1234567890abcdef12345678";
  const trunc = truncateAddress(addr);
  ok("truncateAddress shortens (first6…last4)", trunc === "0x1234…5678", trunc);
  ok("truncateAddress never returns the full address", !trunc.includes(addr.slice(10, 30)));
  ok("truncateAddress empty/short/garbage → em-dash", truncateAddress("") === "—" && truncateAddress(null) === "—" && truncateAddress("0x123") === "—" && truncateAddress("not-an-address") === "—");
  ok("truncateAddress never throws on garbage", (() => { try { truncateAddress({}); truncateAddress(42); return true; } catch { return false; } })());

  console.log("\n[2] helpers — budget/status formatting");
  ok("formatBudgetUsdc 1_000_000 → 1.00 USDC", formatBudgetUsdc("1000000") === "1.00 USDC", formatBudgetUsdc("1000000"));
  ok("formatBudgetUsdc zero → 0.00 USDC", formatBudgetUsdc("0") === "0.00 USDC");
  ok("formatBudgetUsdc garbage → em-dash, no throw", formatBudgetUsdc("abc") === "—" && formatBudgetUsdc(null) === "—" && formatBudgetUsdc(undefined) === "—");
  ok("budgetIsZero true for 0/empty", budgetIsZero("0") && budgetIsZero("") && budgetIsZero(null));
  ok("budgetIsZero false for set budget", !budgetIsZero("1000000"));

  console.log("\n[3] helpers — provider next action per status");
  const accept = getProviderNextAction({ status: "Open", budget: "0" });
  ok("Open + zero budget → accept/set-budget step", accept.kind === "accept", accept.kind);
  ok("accept step explains existing route (no invented endpoint)", accept.detail.includes("/api/jobs/[jobId]/accept"));
  ok("accept step manageAction is null (deep-link to canonical lifecycle, no dup)", accept.manageAction === null);
  const waitFund = getProviderNextAction({ status: "Open", budget: "1000000" });
  ok("Open + budget → wait-funding (no provider action)", waitFund.kind === "wait-funding" && waitFund.manageAction === null);
  const submit = getProviderNextAction({ status: "Funded", budget: "1000000" });
  ok("Funded → submit via existing Manage action", submit.kind === "submit" && submit.manageAction === "submit");
  const waitReview = getProviderNextAction({ status: "Submitted", budget: "1000000" });
  ok("Submitted → wait-review explicit (submitted state visible)", waitReview.kind === "wait-review" && /submit/i.test(waitReview.title));
  const done = getProviderNextAction({ status: "Completed", budget: "1000000" });
  ok("Completed → done explicit (completed state visible)", done.kind === "done" && /complet/i.test(done.title));
  const expired = getProviderNextAction({ status: "Expired", budget: "0" });
  ok("Expired/Rejected → terminal", expired.kind === "terminal" && getProviderNextAction({ status: "Rejected", budget: "0" }).kind === "terminal");
  const unknown = getProviderNextAction({ status: "Weird", budget: "0" });
  ok("unknown status → unknown, never throws", unknown.kind === "unknown");
  ok("no next action ever routes to client-signed approve/fund/complete",
    [accept, waitFund, submit, waitReview, done, expired, unknown].every(
      (a) => a.manageAction === null || a.manageAction === "submit"
    ));

  console.log("\n[3b] REGRESSION — real UPPERCASE DB values (production data)");
  const dbAccept = getProviderNextAction({ status: "OPEN", budget: "0" });
  ok("OPEN + zero budget → accept/set-budget guidance", dbAccept.kind === "accept" && dbAccept.manageAction === null, dbAccept.kind);
  ok("OPEN accept detail cites existing route", dbAccept.detail.includes("/api/jobs/[jobId]/accept"));
  const dbWaitFund = getProviderNextAction({ status: "OPEN", budget: "1000000" });
  ok("OPEN + budget → wait-funding (no provider action)", dbWaitFund.kind === "wait-funding" && dbWaitFund.manageAction === null, dbWaitFund.kind);
  const dbSubmit = getProviderNextAction({ status: "FUNDED", budget: "1000000" });
  ok("FUNDED → submit via existing Manage action", dbSubmit.kind === "submit" && dbSubmit.manageAction === "submit", dbSubmit.kind);
  const dbWaitReview = getProviderNextAction({ status: "SUBMITTED", budget: "1000000" });
  ok("SUBMITTED → wait-review (submitted state)", dbWaitReview.kind === "wait-review" && /submit/i.test(dbWaitReview.title), dbWaitReview.kind);
  const dbDone = getProviderNextAction({ status: "COMPLETED", budget: "1000000" });
  ok("COMPLETED → done (completed state)", dbDone.kind === "done" && /complet/i.test(dbDone.title), dbDone.kind);
  ok("REJECTED/EXPIRED (uppercase) → terminal",
    getProviderNextAction({ status: "REJECTED", budget: "0" }).kind === "terminal" &&
    getProviderNextAction({ status: "EXPIRED", budget: "0" }).kind === "terminal");
  ok("uppercase matches Title Case behavior (no semantics change)",
    getProviderNextAction({ status: "OPEN", budget: "0" }).kind === getProviderNextAction({ status: "Open", budget: "0" }).kind &&
    getProviderNextAction({ status: "FUNDED", budget: "1000000" }).kind === getProviderNextAction({ status: "Funded", budget: "1000000" }).kind &&
    getProviderNextAction({ status: "SUBMITTED", budget: "1000000" }).kind === getProviderNextAction({ status: "Submitted", budget: "1000000" }).kind &&
    getProviderNextAction({ status: "COMPLETED", budget: "1000000" }).kind === getProviderNextAction({ status: "Completed", budget: "1000000" }).kind);
  ok("mixed-case + whitespace tolerated", getProviderNextAction({ status: "  funded ", budget: "1000000" }).kind === "submit");
  const dbUnknown = getProviderNextAction({ status: "BOGUS", budget: "0" });
  ok("unknown status → unknown, never throws", dbUnknown.kind === "unknown");
  ok("malformed status (null/number/empty) → unknown, never throws",
    getProviderNextAction({ status: null, budget: "0" }).kind === "unknown" &&
    getProviderNextAction({ status: 42 as any, budget: "0" }).kind === "unknown" &&
    getProviderNextAction({ status: "", budget: "0" }).kind === "unknown");
  ok("normalizeProviderStatus canonicalizes to UPPERCASE DB form",
    normalizeProviderStatus("Open") === "OPEN" &&
    normalizeProviderStatus("FUNDED") === "FUNDED" &&
    normalizeProviderStatus("  submitted ") === "SUBMITTED" &&
    normalizeProviderStatus(null) === "" && normalizeProviderStatus(7) === "");
  ok("status colors resolve for real DB values",
    getProviderStatusColor("OPEN") === "var(--warning)" &&
    getProviderStatusColor("FUNDED") === "#06b6d4" &&
    getProviderStatusColor("SUBMITTED") === "var(--primary)" &&
    getProviderStatusColor("COMPLETED") === "var(--success)" &&
    getProviderStatusColor("REJECTED") === "var(--danger)" &&
    getProviderStatusColor("EXPIRED") === "var(--text-secondary)");
  ok("status colors match Title Case inputs (badge parity)",
    getProviderStatusColor("Open") === getProviderStatusColor("OPEN") &&
    getProviderStatusColor("Funded") === getProviderStatusColor("FUNDED") &&
    getProviderStatusColor("Submitted") === getProviderStatusColor("SUBMITTED") &&
    getProviderStatusColor("Completed") === getProviderStatusColor("COMPLETED"));
  ok("unknown/garbage status → safe fallback color, never throws",
    getProviderStatusColor("BOGUS") === "var(--text-secondary)" &&
    getProviderStatusColor(null) === "var(--text-secondary)" &&
    getProviderStatusColor(undefined) === "var(--text-secondary)");

  console.log("\n[4] helpers — malformed/empty API response never crashes");
  ok("normalize null → []", JSON.stringify(normalizeMineResponse(null)) === "[]");
  ok("normalize undefined → []", normalizeMineResponse(undefined).length === 0);
  ok("normalize {} / {jobs:null} / garbage → []",
    normalizeMineResponse({}).length === 0 &&
    normalizeMineResponse({ jobs: null }).length === 0 &&
    normalizeMineResponse({ jobs: "x" }).length === 0 &&
    normalizeMineResponse({ success: false }).length === 0);
  ok("normalize filters rows missing jobId, keeps valid",
    (() => {
      const out = normalizeMineResponse({ success: true, jobs: [{ jobId: "1" }, null, {}, { noid: 1 }] });
      return out.length === 1 && String(out[0].jobId) === "1";
    })());

  console.log("\n[5] backend scoping — provider sees only controlled providerSCA jobs");
  ok("mine route gates on getCallerControlledAddresses", mine.includes("getCallerControlledAddresses"));
  ok("mine provider role scopes by providerSCA only", mine.includes("providerSCA = { in: controlledArr"));
  ok("mine rejects empty control set (401)", mine.includes("401"));

  console.log("\n[6] UI loads role=provider for the provider inbox");
  ok("page fetches GET /api/jobs/mine?role=<role> (templated per sub-tab)", page.includes("/api/jobs/mine?role=${role}"));
  ok("provider sub-tab defaults to 'provider'", page.includes(`useState<'provider' | 'client'>('provider')`));
  ok("provider inbox header is clearly labeled", page.includes("Jobs for Me") && page.includes("Provider Inbox"));
  ok("provider inbox cites the role=provider endpoint", page.includes("GET /api/jobs/mine?role=provider"));

  console.log("\n[7] provider cards show id/description/client/budget/status/next-action + states");
  ok("provider card shows job ID", page.includes("Job #{j.jobId}"));
  ok("provider card shows client privacy-safe (truncateAddress)", page.includes("truncateAddress(j.clientSCA)"));
  ok("provider card shows budget via formatBudgetUsdc", page.includes("formatBudgetUsdc(j.budget)"));
  ok("provider card shows status + next action", page.includes("getProviderStatusColor(j.status)") && page.includes("getProviderNextAction(j)"));
  ok("provider/client inbox badges use the normalized color helper (UPPERCASE-safe)",
    page.includes("getProviderStatusColor,") && !page.includes("STATUS_COLORS[j.status]"));
  ok("provider card surfaces submitted deliverable state", page.includes("Deliverable submitted"));
  ok("provider loading state", page.includes("Loading your provider jobs..."));
  ok("provider error state", page.includes("providerError"));
  ok("provider empty state (no crash, actionable copy)", page.includes("No provider jobs yet."));

  console.log("\n[8] unrelated job is not rendered (no cross-role merge client-side)");
  ok("provider list renders exactly the role=provider payload", page.includes("providerJobs.map("));
  ok("provider fetch normalizes (malformed-safe) before render", page.includes("normalizeMineResponse(data)"));
  ok("client list is a separate role=client fetch (never merged into provider view)",
    page.includes("role=client") && page.includes("clientJobs.map("));

  console.log("\n[9] client-only controls are absent for provider role");
  const providerBlockStart = page.indexOf("Jobs for Me — Provider Inbox");
  const clientBlockStart = page.indexOf("Jobs I Posted — Client View");
  const providerBlock = page.slice(providerBlockStart, clientBlockStart);
  ok("provider inbox block located", providerBlockStart !== -1 && clientBlockStart > providerBlockStart);
  ok("no Approve USDC button in provider inbox", !providerBlock.includes(">Approve USDC<"), "found client control");
  ok("no Fund Escrow button in provider inbox", !providerBlock.includes(">Fund Escrow<"), "found client control");
  ok("no Complete & Pay button in provider inbox", !providerBlock.includes(">Complete & Pay<"), "found client control");
  ok("provider inbox deep-links into canonical Manage lifecycle (no duplicate endpoints)",
    providerBlock.includes("setActiveTab('manage')") && providerBlock.includes("setLookupJobId(String(j.jobId))"));
  ok("provider inbox issues no lifecycle POST of its own", !/fetch\(`\/api\/jobs/.test(providerBlock), "provider block must not POST lifecycle routes");

  console.log("\n[10] existing merchant Manage view remains unchanged");
  const manageStart = page.indexOf("── MANAGE TAB ──");
  const manageBlock = manageStart === -1 ? "" : page.slice(manageStart);
  ok("Manage tab still present (Look Up Job)", manageBlock.includes("Look Up Job"));
  ok("Manage keeps Approve USDC", manageBlock.includes("Approve USDC"));
  ok("Manage keeps Fund Escrow", manageBlock.includes("Fund Escrow"));
  ok("Manage keeps Submit Deliverable", manageBlock.includes("Submit Deliverable"));
  ok("Manage keeps Complete & Pay", manageBlock.includes("Complete & Pay"));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
