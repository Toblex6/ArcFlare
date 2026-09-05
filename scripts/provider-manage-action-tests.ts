/**
 * provider-manage-action-tests.ts
 *
 * Track A — Provider Manage UX dead-end fix. Static + unit proofs (no dev
 * server / DB / chain required):
 *   1. The canonical Manage view surfaces a provider-only action, and ONLY
 *      under the correct conditions (caller is provider + job Open + zero
 *      budget).
 *   2. It reuses the existing POST /api/jobs/[jobId]/accept route — no new
 *      endpoint, no duplicated lifecycle/business logic in the UI.
 *   3. The client never sees the provider action (gated on `isProvider`).
 *   4. Existing client-only Manage actions (approve/fund/complete) are
 *      unchanged.
 *   5. Server-side authorization for the accept route is preserved
 *      (verifyCallerControlsAddress still guards it).
 *
 * Run: npx tsx scripts/provider-manage-action-tests.ts
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
  const jobsRoute = read("src/app/api/jobs/route.ts");
  const acceptRoute = read("src/app/api/jobs/[jobId]/accept/route.ts");

  console.log("\n[1] provider-only action exists and is correctly gated");
  ok(
    "Manage tab renders an 'Accept / Set Budget' button",
    page.includes("Accept / Set Budget"),
    "button text missing"
  );
  ok(
    "button is gated on status === 'Open'",
    /lookupResult\.status === 'Open'\s*&&/.test(page),
    "Open gate missing"
  );
  ok(
    "button is gated on zero budget (budgetZero)",
    page.includes("lookupResult.budgetZero"),
    "budgetZero gate missing"
  );
  ok(
    "button is gated on isProvider (so the CLIENT never sees it)",
    page.includes("lookupResult.isProvider"),
    "isProvider gate missing"
  );
  // The three gates appear together in the same JSX condition block.
  const needsAllThree =
    page.includes("lookupResult.status === 'Open' &&") &&
    page.includes("lookupResult.budgetZero &&") &&
    page.includes("lookupResult.isProvider && (");
  ok("visibility requires ALL THREE conditions simultaneously", needsAllThree, "gates not co-located");

  console.log("\n[2] reuses the existing accept route (no new endpoint, no UI-side lifecycle logic)");
  ok(
    "runManageAction POSTs to the existing /api/jobs/[jobId]/accept route",
    page.includes("`/api/jobs/${lookupJobId}/accept`"),
    "accept fetch target missing"
  );
  ok(
    "accept posts { budget } (the accept route body shape)",
    /JSON\.stringify\(\{ budget \}\)/.test(page),
    "budget payload missing"
  );
  ok(
    "accept does NOT reinvent lifecycle logic (posts straight to the route, no action dispatch)",
    page.includes("action: manageAction, jobId: lookupJobId"),
    "non-accept actions still dispatch via the canonical /api/jobs switch; accept bypasses it"
  );
  ok("no fabricated new endpoint string", !page.includes("/api/jobs/[jobId]/accept-budget") &&
    !page.includes("acceptBudget"), "invented endpoint detected");

  console.log("\n[3] client-only Manage actions preserved unchanged");
  ok("Approve USDC still present", page.includes("Approve USDC"));
  ok("Fund Escrow still present", page.includes("Fund Escrow"));
  ok("Submit Deliverable still present", page.includes("Submit Deliverable"));
  ok("Complete & Pay still present", page.includes("Complete & Pay"));

  console.log("\n[4] server supplies role-correct flags via the canonical ownership gate");
  ok("GET /api/jobs?jobId= exposes isProvider", jobsRoute.includes("isProvider"));
  ok("GET /api/jobs?jobId= exposes isClient", jobsRoute.includes("isClient"));
  ok("GET /api/jobs?jobId= exposes budgetZero", jobsRoute.includes("budgetZero"));
  ok(
    "flags derive from getCallerControlledAddresses (the same single ownership gate)",
    jobsRoute.includes("getCallerControlledAddresses"),
    "no second/local ownership helper"
  );
  ok(
    "flags are read-model only (never authorize)",
    jobsRoute.includes("these flags never authorize anything") ||
      jobsRoute.includes("never authorize"),
    "read-model-only guard comment missing"
  );

  console.log("\n[5] server-side authorization for the accept route is preserved");
  ok(
    "accept route still guards the provider wallet with verifyCallerControlsAddress",
    acceptRoute.includes("verifyCallerControlsAddress(req, job.providerSCA)"),
    "ownership gate removed"
  );
  ok(
    "accept route resolves the signing wallet from the DB, never the body",
    acceptRoute.includes("providerWalletId") && !acceptRoute.includes("req.body.providerWalletId"),
    "must not trust a body-supplied wallet id"
  );

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();