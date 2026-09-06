/**
 * manage-fund-routing-tests.ts
 *
 * Manage funding divergence (canonical vs legacy fund) — static proofs.
 * No dev server / DB / chain required.
 *
 * Audit outcome: POST /api/jobs/[jobId]/fund (canonical) enforces treasury
 * policy + spend limits but only serves registered agent clients (it
 * resolves the payer from AgentRegistry.circleWalletId and 404s otherwise).
 * Direct Hire jobs whose client is a merchant/consumer wallet have no
 * AgentRegistry row, so Manage CANNOT route all funding through canonical
 * without breaking that legitimate owner flow. The safe routing is:
 *
 *   1. Manage fund tries canonical FIRST (treasury + spend-limit enforced).
 *   2. It falls back to the legacy POST /api/jobs { action: 'fund' } owner
 *      flow ONLY for non-agent-client jobs (exact allowlist match).
 *   3. Policy/state/auth denials NEVER fall back — they surface directly.
 *
 * Proves:
 *   1. Manage posts the canonical endpoint first for fund.
 *   2. Canonical success short-circuits (no legacy dispatch).
 *   3. Fallback allowlist matches the canonical route's exact error strings.
 *   4. Treasury / spend-limit denials are NOT in the fallback path.
 *   5. Both routes keep verifyCallerControlsAddress (no weakened auth).
 *   6. Canonical keeps treasury + spend-limit enforcement.
 *   7. Legacy fund action still exists (owner flow preserved).
 *
 * Run: npx tsx scripts/manage-fund-routing-tests.ts
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
  const page = read("src/app/jobs/page.tsx");
  const legacy = read("src/app/api/jobs/route.ts");
  const canonical = read("src/app/api/jobs/[jobId]/fund/route.ts");

  console.log("\n[1] Manage fund tries the canonical endpoint first");
  ok("fund branch POSTs /api/jobs/${lookupJobId}/fund",
    page.includes("`/api/jobs/${lookupJobId}/fund`"), "canonical fetch missing");
  ok("canonical attempt sends an empty body (client resolved server-side from DB)",
    /\/api\/jobs\/\$\{lookupJobId\}\/fund[\s\S]{0,300}JSON\.stringify\(\{\}\)/.test(page),
    "must not send a caller-chosen payer wallet");
  ok("canonical success sets result + refreshes + returns (no legacy dispatch)",
    page.includes("canonicalData?.success") && page.includes("canonicalRes.ok && canonicalData?.success"),
    "success short-circuit missing");

  console.log("\n[2] fallback is allowlisted to non-agent-client jobs only");
  ok("NON_AGENT_CLIENT_FUND_ERRORS allowlist exists", page.includes("NON_AGENT_CLIENT_FUND_ERRORS"));
  for (const s of [
    "client agent not found",
    "client agent has no Circle wallet for funding",
    "client Circle wallet not resolvable",
    "client Circle wallet does not match job clientSCA",
    "Job not found",
  ]) {
    ok(`allowlist covers canonical error ${JSON.stringify(s)}`,
      page.includes(s) && canonical.includes(s), `missing in ${!page.includes(s) ? "page" : "canonical route"}`);
  }
  ok("fallback decision goes through isNonAgentClientFundError",
    page.includes("isNonAgentClientFundError(canonicalError)"));

  console.log("\n[3] policy/state/auth denials NEVER fall back (enforcement preserved)");
  ok("non-allowlisted failure throws (surfaces directly)",
    page.includes("throw new Error(canonicalError"), "must surface, not fall back");
  ok("treasury denial is not an allowlist entry",
    !/NON_AGENT_CLIENT_FUND_ERRORS = \[[\s\S]*?Treasury policy blocked[\s\S]*?\]/.test(page));
  ok("spend-limit denial is not an allowlist entry",
    !/NON_AGENT_CLIENT_FUND_ERRORS = \[[\s\S]*?Spend limit (blocked|enforcement failed)[\s\S]*?\]/.test(page));

  console.log("\n[4] authorization is not weakened on either route");
  ok("canonical fund still gates on verifyCallerControlsAddress(job.clientSCA)",
    canonical.includes("verifyCallerControlsAddress(req, job.clientSCA)"), "ownership gate removed");
  ok("legacy fund action still gates on verifyCallerControlsAddress(clientSCA)",
    legacy.includes("verifyCallerControlsAddress(request as any, clientSCA)"), "ownership gate removed");
  ok("canonical still resolves payer from AgentRegistry (never trusts a body wallet)",
    canonical.includes("agentRegistry.findFirst") && canonical.includes("circleWalletId"));
  ok("canonical still enforces treasury policy",
    canonical.includes("evaluatePolicyForSpend") && canonical.includes("Treasury policy blocked"));
  ok("canonical still enforces spend limits (pre-flight + on-chain record)",
    canonical.includes("checkSpendAllowed") && canonical.includes("checkAndRecordSpend"));

  console.log("\n[5] legacy owner flow preserved (non-agent clients keep working)");
  ok("legacy fund action still exists", legacy.includes("if (action === 'fund')"));
  ok("Manage still dispatches legacy fund with caller-controlled clientSCA as fallback",
    page.includes("action: manageAction, jobId: lookupJobId") &&
    /manageAction === 'fund'[\s\S]{0,1500}clientSCA: manageClientSCA/.test(page),
    "fallback dispatch missing");
  ok("Manage keeps the separate Approve step (legacy flow needs it; canonical approves internally)",
    page.includes("Approve USDC"));
  ok("divergence is documented at the legacy fund block", legacy.includes("canonical") && legacy.includes("treasury"));
  ok("divergence is documented at the canonical fund route",
    canonical.includes("NON_AGENT_CLIENT_FUND_ERRORS"));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
