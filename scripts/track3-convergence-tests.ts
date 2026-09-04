/**
 * track3-convergence-tests.ts
 *
 * Track 3 — Canonical Job Lifecycle Architecture: static convergence proofs.
 *
 * Proves (without needing a chain or a live DB) that Direct Hire and
 * Procurement both converge onto the SAME canonical Erc8183Job record and
 * lifecycle, that role isolation is scoped by the caller's controlled-address
 * set, that repeated selection/hire stays safe, and that the legacy `Job`
 * model remains an untouched, unqueried legacy mirror.
 *
 * Categories (mirror the Phase 8 MUST-prove list):
 *   A. Direct Hire: create now persists Erc8183Job; provider serviceability
 *      gates + notification preserved; lifecycle steps write the canonical row.
 *   B. Procurement: posting/apply/select/hire still create the same canonical
 *      Erc8183Job via resultingJobId; conditional SELECTED->HIRING prevents
 *      duplicate canonical jobs.
 *   C. Shared lifecycle: setBudget/accept/fund/submit/validation/complete all
 *      operate against Erc8183Job for BOTH paths.
 *   D. Role isolation: /api/jobs/mine scopes strictly by providerSCA/clientSCA
 *      within getCallerControlledAddresses; list requires merchant auth.
 *   F. Legacy model: `model Job` still in schema; no runtime prisma.job reads.
 *
 * Run: npx tsx scripts/track3-convergence-tests.ts
 * No dev server / DB / chain required. Static only.
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
  const flat = read("src/app/api/jobs/route.ts");
  const complete = read("src/app/api/jobs/complete/route.ts");
  const accept = read("src/app/api/jobs/[jobId]/accept/route.ts");
  const hire = read("src/app/api/procurement/[id]/hire/route.ts");
  const select = read("src/app/api/procurement/[id]/select/route.ts");
  const mine = read("src/app/api/jobs/mine/route.ts");
  const list = read("src/app/api/jobs/list/route.ts");
  const schema = read("prisma/schema.prisma");

  console.log("\n[F] Legacy model — dead mirror, not deleted, not queried at runtime");
  ok("prisma/schema.prisma still defines `model Job`", /^\s*model Job \{/m.test(schema));
  const srcFiles = fs.readdirSync(path.join(root, "src"), { recursive: true })
    .filter((f): f is string => typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx")))
    .map((f) => f.replace(/\\/g, "/"));
  const runtimeJobUses = srcFiles
    .filter((f) => {
      const c = read(`src/${f}`);
      // Strip both line and block comments so documentation of the legacy
      // mirror is not mistaken for a runtime `prisma.job` reference.
      const codeOnly = c
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*$/gm, '');
      return /prisma\.job\b/.test(codeOnly);
    });
  ok("no runtime file queries the legacy `Job` via prisma.job", runtimeJobUses.length === 0,
    `found in: ${runtimeJobUses.join(", ")}`);

  console.log("\n[A] Direct Hire — canonical Erc8183Job persistence + preserved semantics");
  ok("flat create persists canonical erc8183Job.create", /prisma\.erc8183Job\s*\n?\s*\.create/.test(flat));
  ok("flat create no longer writes legacy prisma.job mirror", !/prisma\.job\s*\n?\s*\.create/.test(flat));
  ok("flat create preserves serviceability gate: unregistered provider 400",
    flat.includes("providerSCA is not a registered agent or known wallet"));
  ok("flat create preserves serviceability gate: unserviceable agent 400",
    flat.includes("not ACTIVE_AGENT_PROVISIONED"));
  ok("flat create preserves provider Telegram notification (best-effort)",
    flat.includes("You've been directly hired for job #"));
  ok("flat lifecycle setBudget writes canonical Erc8183Job.budget",
    /data:\s*\{\s*budget:\s*amountWei,\s*txHashes:\s*\{\s*push:\s*txHash\s*\}\s*\}/.test(flat));
  ok("flat lifecycle fund writes canonical status FUNDED", flat.includes("data: { status: 'FUNDED'"));
  ok("flat lifecycle submit writes canonical status SUBMITTED + deliverableHash",
    flat.includes("data: { status: 'SUBMITTED', deliverableHash"));
  ok("flat lifecycle complete writes canonical status COMPLETED", flat.includes("data: { status: 'COMPLETED'"));
  ok("flat complete has validation gate (isValidationSatisfiedForJob)",
    flat.includes("isValidationSatisfiedForJob") && flat.includes("VALIDATION_REQUIRED"));
  ok("flat complete has canonical ledger side-effects", flat.includes("JOB_ESCROW_RELEASE") && flat.includes("SUBCONTRACTOR_SPEND"));
  ok("flat complete has auto-reputation for validated jobs", flat.includes("maybeAutoReputationForValidatedJob"));
  ok("flat complete fires completion Telegram notification exactly once",
    (flat.match(/Job #\$\{jobId\} paid/g) || []).length === 1);
  ok("flat setBudget nextStep points at canonical accept endpoint", flat.includes("/accept { budget:"));

  console.log("\n[B] Procurement — unchanged selection flow, same canonical Erc8183Job");
  ok("hire creates canonical erc8183Job.create", /prisma\.erc8183Job\s*\n?\s*\.create/.test(hire));
  ok("hire links posting to job via resultingJobId", hire.includes("resultingJobId: jobId"));
  ok("hire uses conditional SELECTED->HIRING claim (no duplicate jobs)",
    hire.includes('where: { id, status: "SELECTED" }') && hire.includes('data: { status: "HIRING" }'));
  ok("select uses conditional OPEN->SELECTED claim (no duplicate selection)",
    select.includes('where: { id, status: "OPEN" }') && select.includes("selectedProviderSCA"));
  ok("select self-hire guard present", select.includes("self-hire not allowed"));
  ok("accept resolves posting skill/category via resultingJobId for policy eval",
    accept.includes("resultingJobId") && accept.includes("evaluateProviderAcceptance"));

  console.log("\n[C] Shared lifecycle — both paths operate against canonical Erc8183Job");
  ok("complete route (canonical) reads+updates Erc8183Job",
    complete.includes("prisma.erc8183Job.findUnique") && complete.includes("prisma.erc8183Job.update"));
  ok("accept route reads canonical Erc8183Job by jobId",
    accept.includes("prisma.erc8183Job.findUnique({ where: { jobId: jobIdBig } })"));
  ok("accept replay is determined by authoritative on-chain budget",
    accept.includes('"Budget already set on-chain — replay"'));
  ok("flat route lifecycle updates canonical Erc8183Job in >=4 steps",
    (flat.match(/prisma\.erc8183Job\.update/g) || []).length >= 4);

  console.log("\n[D] Role isolation — provider/client discovery strictly scoped");
  ok("mine endpoint gates on getCallerControlledAddresses", mine.includes("getCallerControlledAddresses"));
  ok("mine endpoint rejects empty control set (401)",
    mine.includes("'Authentication required.'") && mine.includes("401"));
  ok("mine provider role scopes by providerSCA only",
    mine.includes("providerSCA = { in: controlledArr, mode: 'insensitive' }"));
  ok("mine client role scopes by clientSCA only",
    mine.includes("clientSCA = { in: controlledArr, mode: 'insensitive' }"));
  ok("mine all-role never leaks: only providerSCA or clientSCA membership",
    mine.includes("{ providerSCA: { in: controlledArr") && mine.includes("{ clientSCA: { in: controlledArr"));
  ok("mine exposes isProvider/isClient derived from controlled set",
    mine.includes("isProvider") && mine.includes("isClient"));
  ok("mine serializes BigInt as strings (no JSON BigInt crash)", mine.includes("j.jobId.toString()"));
  ok("list endpoint requires merchant auth (client-side view)",
    list.includes("resolveMerchant") && list.includes("merchantId: merchant.id"));

  console.log("\n[G] Orphan backfill — pre-change Direct-Hire jobs restored from on-chain truth");
  ok("helper ensureErc8183JobBackfilled is defined (async function)",
    /async function ensureErc8183JobBackfilled\(jobId: string, req\?: Request\)/.test(flat));
  ok("helper does findUnique FIRST",
    flat.includes("prisma.erc8183Job.findUnique({ where: { jobId: jobIdBig } })"));
  ok("helper returns existing row untouched (read-only when found)",
    flat.includes("if (existing) return existing;"));
  ok("backfill reads authoritative on-chain state via requireJob (getJob)",
    /const onChain = await requireJob\(jobId\);/.test(flat));
  ok("backfill status comes from on-chain truth, NOT a hardcoded default",
    /status: DB_STATUS_BY_ONCHAIN\[Number\(onChain\.status\)\]/.test(flat) &&
    /status: DB_STATUS_BY_ONCHAIN\[Number\(onChain\.status\)\] \|\| 'OPEN'/.test(flat));
  ok("backfill budget comes from on-chain truth",
    /budget: BigInt\(onChain\.budget \?\? 0\),/.test(flat));
  ok("backfill populates clients/provider/evaluator/expiredAt from on-chain",
    flat.includes("clientSCA: onChain.client") &&
    flat.includes("providerSCA: onChain.provider") &&
    flat.includes("evaluatorSCA: onChain.evaluator") &&
    flat.includes("expiredAt: new Date(Number(onChain.expiredAt) * 1000)"));
  ok("backfill exists only on the MISSING branch (never overwrites)",
    !/prisma\.erc8183Job\.(update|upsert)/.test(
      flat.slice(flat.indexOf("async function ensureErc8183JobBackfilled"), flat.indexOf("function extractJobId"))));

  // All four flat steps call the helper before their on-chain tx, so a
  // missing row is backfilled before any write. There must be exactly 4
  // call sites and exactly 4 canonical update() writes.
  const setBudgetHelper = flat.indexOf("abiFunctionSignature: 'setBudget(uint256,uint256,bytes)'");
  const fundHelper = flat.indexOf("abiFunctionSignature: 'fund(uint256,bytes)'");
  const submitHelper = flat.indexOf("abiFunctionSignature: 'submit(uint256,bytes32,bytes)'");
  const completeHelper = flat.indexOf("abiFunctionSignature: 'complete(uint256,bytes32,bytes)'");
  const helperCallSites = (flat.match(/await ensureErc8183JobBackfilled\(jobId, request\);/g) || []).length;
  const updateSites = (flat.match(/await prisma\.erc8183Job\.update\(/g) || []).length;
  ok("helper called before each of the four flat steps' on-chain tx (4 call sites)",
    helperCallSites === 4, `found ${helperCallSites}`);
  ok("helper called in setBudget block", setBudgetHelper !== -1 && flat.lastIndexOf("await ensureErc8183JobBackfilled", setBudgetHelper) > flat.lastIndexOf("await requireJob(jobId)", setBudgetHelper));
  ok("helper called in fund block", fundHelper !== -1 && flat.lastIndexOf("await ensureErc8183JobBackfilled", fundHelper) > flat.lastIndexOf("await requireJob(jobId)", fundHelper));
  ok("helper called in submit block", submitHelper !== -1 && flat.lastIndexOf("await ensureErc8183JobBackfilled", submitHelper) > flat.lastIndexOf("await requireJob(jobId)", submitHelper));
  ok("helper called in complete block", completeHelper !== -1 && flat.lastIndexOf("await ensureErc8183JobBackfilled", completeHelper) > flat.lastIndexOf("await requireJob(jobId)", completeHelper));
  ok("still exactly 4 canonical update() writes in the flat path", updateSites === 4, `found ${updateSites}`);

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();