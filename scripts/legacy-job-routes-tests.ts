/**
 * legacy-job-routes-tests.ts
 *
 * Legacy job route audit — static proofs for the inventory documented in
 * src/app/api/jobs/route.ts ("LEGACY JOB ROUTE INVENTORY"). No dev server /
 * DB / chain required. No routes are deleted by this task; this suite locks
 * the audit's factual claims so future cleanups can act on them:
 *
 *   1. Still-used routes have at least one in-repo caller (or internal import).
 *   2. Unused-candidate routes have no in-repo UI caller.
 *   3. Material auth/enforcement differences hold (flat fund lacks
 *      treasury/spend-limit; [jobId] GET read is unwrapped; mine fails closed).
 *   4. No route resolves a payer wallet with a shared-default fallback.
 *
 * Run: npx tsx scripts/legacy-job-routes-tests.ts
 */

import fs from "fs";
import path from "path";

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
  const jobsPage = read("src/app/jobs/page.tsx");
  const jobsRoute = read("src/app/api/jobs/route.ts");
  const flatFund = read("src/app/api/jobs/fund/route.ts");
  const flatSubmit = read("src/app/api/jobs/submit/route.ts");
  const flatComplete = read("src/app/api/jobs/complete/route.ts");
  const flatCreate = read("src/app/api/jobs/create/route.ts");
  const flatSetBudget = read("src/app/api/jobs/set-budget/route.ts");
  const list = read("src/app/api/jobs/list/route.ts");
  const jobIdGet = read("src/app/api/jobs/[jobId]/route.ts");
  const accept = read("src/app/api/jobs/[jobId]/accept/route.ts");
  const canonicalFund = read("src/app/api/jobs/[jobId]/fund/route.ts");
  const mine = read("src/app/api/jobs/mine/route.ts");
  const bot = read("src/lib/telegram/botHandlers.ts");
  const brain = read("src/app/api/agent/brain/route.ts");
  const hire = read("src/app/api/agents/[id]/hire/route.ts");

  console.log("\n[1] still-used legacy routes have in-repo callers");
  ok("POST /api/jobs action switch used by Manage + wizard",
    jobsPage.includes("fetch('/api/jobs'") && jobsPage.includes("action: manageAction"));
  ok("GET /api/jobs?jobId= used by Manage lookup",
    jobsPage.includes("/api/jobs?jobId=${lookupJobId}"));
  ok("GET /api/jobs/mine used by My Jobs inboxes",
    jobsPage.includes("/api/jobs/mine?role=${role}"));
  ok("canonical accept used by Manage + Telegram + brain",
    jobsPage.includes("`/api/jobs/${lookupJobId}/accept`") &&
    bot.includes("@/app/api/jobs/[jobId]/accept/route") &&
    brain.includes("/api/jobs/${input.jobId}/accept"));
  ok("canonical fund used by brain + procurement nextSteps + Manage",
    brain.includes("/api/jobs/${input.jobId}/fund") &&
    jobsPage.includes("`/api/jobs/${lookupJobId}/fund`"));
  ok("flat submit used by Telegram /deliver (internal import)",
    bot.includes("@/app/api/jobs/submit/route"));

  console.log("\n[2] referenced-but-no-UI-caller routes stay advertised, not deleted");
  ok("flat fund advertised by agents hire nextSteps", hire.includes('"/api/jobs/fund"'));
  ok("flat set-budget advertised by agents hire nextSteps", hire.includes('"/api/jobs/set-budget"'));
  ok("both flat routes still exist", flatFund.includes("fundJobHandler") && flatSetBudget.includes("setBudgetJobHandler"));

  console.log("\n[3] no-in-repo-caller candidates are kept, not deleted");
  for (const [label, src] of [
    ["flat create", flatCreate],
    ["flat complete", flatComplete],
    ["list", list],
    ["[jobId] GET", jobIdGet],
  ] as const) {
    ok(`${label} route file still present`, src.length > 100, label);
  }
  ok("flat complete has no in-repo fetch caller (inventory claim)",
    !jobsPage.includes("/api/jobs/complete") && !brain.includes("/api/jobs/complete") && !bot.includes("jobs/complete"));
  ok("GET /api/jobs/list has no in-repo fetch caller (inventory claim)",
    !jobsPage.includes("/api/jobs/list") && !brain.includes("/api/jobs/list"));
  ok("no in-repo GET caller of the bare [jobId] read route — UI uses GET ?jobId=",
    !/fetch\(`\/api\/jobs\/\$\{(lookupJobId|input\.jobId)\}`/.test(jobsPage + brain));

  console.log("\n[4] material enforcement differences hold");
  ok("flat fund LACKS treasury/spend-limit enforcement (divergence is real)",
    !flatFund.includes("evaluatePolicyForSpend") && !flatFund.includes("checkSpendAllowed"));
  ok("canonical fund HAS treasury/spend-limit enforcement",
    canonicalFund.includes("evaluatePolicyForSpend") && canonicalFund.includes("checkAndRecordSpend"));
  ok("flat fund still gates caller control (no weakened auth)",
    flatFund.includes("verifyCallerControlsAddress(req, clientAddress)"));
  ok("flat submit/complete/set-budget still gate caller control",
    flatSubmit.includes("verifyCallerControlsAddress(req, providerAddress)") &&
    flatComplete.includes("verifyCallerControlsAddress(req, evaluatorAddress)") &&
    flatSetBudget.includes("verifyCallerControlsAddress(req, providerAddress)"));
  ok("[jobId] GET read is unwrapped (public) while ?jobId= is session-gated",
    !jobIdGet.includes("withApiKeyOrAnySession") && !jobIdGet.includes("withMerchantAuth") &&
    jobsRoute.includes("withApiKeyOrAnySession(getJobHandler"));
  ok("mine fails closed on empty control set (401, never unscoped)",
    mine.includes("controlled.size === 0") && mine.includes("401"));
  ok("inventory comment exists at the legacy entry point",
    jobsRoute.includes("LEGACY JOB ROUTE INVENTORY"));

  console.log("\n[5] no shared-default payer fallback in any fund path");
  for (const [label, src] of [
    ["legacy action fund", jobsRoute],
    ["flat fund", flatFund],
    ["canonical fund", canonicalFund],
  ] as const) {
    ok(`${label}: no shared-default payer identifier`,
      !/DEFAULT_PAYER|PLATFORM_WALLET|SHARED_WALLET|FALLBACK_WALLET/.test(src), label);
  }
  ok("canonical fund never trusts a caller-supplied wallet id",
    !canonicalFund.includes("clientWalletId"));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
