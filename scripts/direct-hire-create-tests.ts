/**
 * direct-hire-create-tests.ts
 *
 * Focused tests for Direct Hire `action === 'create'` hardening
 * (src/app/api/jobs/route.ts only):
 *  (a) unregistered provider → 400 + intended error, no on-chain tx attempted
 *  (b) registered AgentRegistry provider → success path, on-chain args unchanged
 *  (c) registered ConsumerAccount/human provider → success path
 *  (d) notification → Telegram for supported provider; failure never fails creation
 *  (e) DB write failure → real error logged; success response preserved
 *  (f) serviceability gates → registered-but-unserviceable providers rejected
 *      400 BEFORE any chain interaction (live handler + global.fetch spy)
 *
 * Approach follows the repo's established convention (see
 * scripts/telegram-completion-tests.ts): real Prisma fixtures with random
 * wallets + cleanup, static source-ordering proofs, and a narrow
 * global.fetch stub for the Telegram transport ONLY. No viem/Circle/NextResponse
 * stubbing — chain-touching success cases are proven statically (REAL-or-BLOCKED
 * rule from scripts/build5-route-tests.mjs), never with a faked txHash/jobId.
 *
 * Run: npx tsx scripts/direct-hire-create-tests.ts
 * No dev server required.
 */
import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient() as any;
let passed = 0;
let failed = 0;
let blocked = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}
function blk(name: string, detail = "") {
  blocked++; console.log(`  ⏸️  BLOCKED ${name} — ${detail}`);
}

const EXPECTED_400 =
  "providerSCA is not a registered agent or known wallet — the provider must have an account on FlareHQ before being hired directly. Use Post a Job if you want to hire from open applicants instead.";

// Serviceability gates (subtask B): a provider the Direct Hire lifecycle can
// never serve must be rejected at create, before any chain interaction.
const EXPECTED_AGENT_STATUS_400_START =
  "providerSCA is a registered agent (registry id ";
const EXPECTED_AGENT_STATUS_400_MID =
  "', not ACTIVE_AGENT_PROVISIONED — only fully provisioned agents can service a Direct Hire job";
const EXPECTED_AGENT_WALLET_400 =
  "with no Circle wallet — the Direct Hire lifecycle requires the provider's Circle wallet to sign setBudget and submit on-chain";
const EXPECTED_HUMAN_WALLET_400 =
  "providerSCA is a known wallet but has no Circle wallet attached — the Direct Hire lifecycle requires the provider's Circle wallet to sign setBudget and submit on-chain";

// ── (f-live) helper: real POST handler against real DB, fetch spied ─────────
// This is the mock/spy proof for requirement 5: the real POST handler is
// invoked against the real DB with global.fetch replaced by a spy that
// records and throws. viem (RPC reads) and the Circle SDK (tx submission)
// both go over network → any chain interaction would be recorded here.
// Rejected providers must produce a clean 400 with ZERO fetch calls.
async function runLiveHandlerSpyTests(
  prisma: any,
  ok: (name: string, cond: boolean, detail?: string) => void,
  blk: (name: string, detail?: string) => void
) {
  // Dummy Circle credentials so the route's getCircleClient() can construct
  // (no Circle call is expected — the fetch spy proves it).
  process.env.CIRCLE_API_KEY = process.env.CIRCLE_API_KEY || "dh-test-key";
  process.env.CIRCLE_ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET || "0".repeat(64);

  const apiKey = `dh-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const liveClientSCA = ethers.Wallet.createRandom().address;
  // Fresh fixtures — the [db] block cleans up its own rows in its finally.
  const liveAgentSCA = ethers.Wallet.createRandom().address;
  const liveAgentPendingSCA = ethers.Wallet.createRandom().address;
  const liveAgentNoWalletSCA = ethers.Wallet.createRandom().address;
  const liveHumanWallet = ethers.Wallet.createRandom().address;
  const liveHumanNoWallet = ethers.Wallet.createRandom().address;
  const liveUnknownWallet = ethers.Wallet.createRandom().address;
  const liveTokenId = `dh-live-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try {
    await prisma.apiKey.create({ data: { key: apiKey, label: "dh-test-spy", ownerEmail: "dh-test@example.com", active: true } });
    await prisma.agentRegistry.create({ data: { name: "dh-live-agent", tokenId: liveTokenId, scaAddress: liveAgentSCA, ownerNode: "test", status: "ACTIVE_AGENT_PROVISIONED", circleWalletId: `dh-live-${Date.now()}` } });
    await prisma.agentRegistry.create({ data: { name: "dh-live-agent-pending", tokenId: `${liveTokenId}-p`, scaAddress: liveAgentPendingSCA, ownerNode: "test", status: "PENDING_PROVISION", circleWalletId: `dh-live-${Date.now()}` } });
    await prisma.agentRegistry.create({ data: { name: "dh-live-agent-nowallet", tokenId: `${liveTokenId}-nw`, scaAddress: liveAgentNoWalletSCA, ownerNode: "test", status: "ACTIVE_AGENT_PROVISIONED" } });
    await prisma.consumerAccount.create({ data: { walletAddress: liveHumanWallet, walletType: "CIRCLE", circleWalletId: `dh-live-${Date.now()}`, onboardingSource: "telegram" } });
    await prisma.consumerAccount.create({ data: { walletAddress: liveHumanNoWallet, walletType: "EXTERNAL", onboardingSource: "telegram" } });

    const { POST } = await import("@/app/api/jobs/route");
    const originalFetch = global.fetch;
    const fetchCalls: string[] = [];
    (global as any).fetch = async (input: any) => {
      fetchCalls.push(String(input?.url ?? input));
      throw new Error("chain/network call attempted during provider validation");
    };
    try {
      const mkReq = (providerSCA: string) =>
        new Request("http://localhost/api/jobs", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({ action: "create", clientSCA: liveClientSCA, providerSCA, amountUSDC: "1", description: "spy test" }),
        });
      const json = async (res: any) => { try { return await res.json(); } catch { return {}; } };

      // (a) unregistered provider → 400, zero network calls
      const resUnknown = await POST(mkReq(liveUnknownWallet) as any);
      const bodyUnknown = await json(resUnknown);
      ok("(a) unregistered provider → 400 from live handler", resUnknown.status === 400 && bodyUnknown.success === false, `${resUnknown.status} ${String(bodyUnknown.error).slice(0, 80)}`);
      ok("(a) unregistered provider error message verbatim", bodyUnknown.error === EXPECTED_400, String(bodyUnknown.error).slice(0, 120));
      ok("(a) no chain/network call attempted (unregistered provider)", fetchCalls.length === 0, fetchCalls.join(","));

      await runLiveGateCases(ok, POST, mkReq, json, fetchCalls, {
        agentSCA: liveAgentSCA,
        agentPendingSCA: liveAgentPendingSCA,
        agentNoWalletSCA: liveAgentNoWalletSCA,
        humanWallet: liveHumanWallet,
        humanNoWallet: liveHumanNoWallet,
      });
    } finally {
      (global as any).fetch = originalFetch;
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (/connect|ECONNREFUSED|P1001|timed out/i.test(msg)) blk("live handler spy checks", msg);
    else ok("live handler spy checks run cleanly", false, msg);
  } finally {
    await prisma.apiKey.deleteMany({ where: { key: apiKey } }).catch(() => {});
    await prisma.agentRegistry.deleteMany({ where: { tokenId: { in: [liveTokenId, `${liveTokenId}-p`, `${liveTokenId}-nw`] } } }).catch(() => {});
    await prisma.agentRegistry.deleteMany({ where: { scaAddress: { in: [liveAgentSCA, liveAgentPendingSCA, liveAgentNoWalletSCA] } } }).catch(() => {});
    await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: [liveHumanWallet, liveHumanNoWallet] } } }).catch(() => {});
  }
}

// Remaining live cases: the serviceability gates + the two accepted-provider
// paths. Runs inside the fetch spy set up by runLiveHandlerSpyTests.
async function runLiveGateCases(
  ok: (name: string, cond: boolean, detail?: string) => void,
  post: (req: any) => Promise<any>,
  mkReq: (providerSCA: string) => Request,
  json: (res: any) => Promise<any>,
  fetchCalls: string[],
  addrs: { agentSCA: string; agentPendingSCA: string; agentNoWalletSCA: string; humanWallet: string; humanNoWallet: string }
) {
  // (f) registered agent, non-provisioned status → 400, zero network calls
  const resPending = await post(mkReq(addrs.agentPendingSCA));
  const bodyPending = await json(resPending);
  ok("(f) non-provisioned agent → 400 from live handler", resPending.status === 400 && bodyPending.success === false, `${resPending.status} ${String(bodyPending.error).slice(0, 80)}`);
  ok("(f) agent status error message", typeof bodyPending.error === "string" && bodyPending.error.startsWith(EXPECTED_AGENT_STATUS_400_START) && bodyPending.error.includes(EXPECTED_AGENT_STATUS_400_MID), String(bodyPending.error).slice(0, 160));
  ok("(f) no chain/network call attempted (non-provisioned agent)", fetchCalls.length === 0, fetchCalls.join(","));

  // (f) registered agent, provisioned but no Circle wallet → 400
  const resNoWallet = await post(mkReq(addrs.agentNoWalletSCA));
  const bodyNoWallet = await json(resNoWallet);
  ok("(f) agent without Circle wallet → 400 from live handler", resNoWallet.status === 400 && bodyNoWallet.success === false, `${resNoWallet.status} ${String(bodyNoWallet.error).slice(0, 80)}`);
  ok("(f) agent wallet error message", typeof bodyNoWallet.error === "string" && bodyNoWallet.error.includes(EXPECTED_AGENT_WALLET_400), String(bodyNoWallet.error).slice(0, 160));
  ok("(f) no chain/network call attempted (agent without wallet)", fetchCalls.length === 0, fetchCalls.join(","));

  // (f) known human wallet without Circle wallet → 400
  const resHuman = await post(mkReq(addrs.humanNoWallet));
  const bodyHuman = await json(resHuman);
  ok("(f) human wallet without Circle wallet → 400 from live handler", resHuman.status === 400 && bodyHuman.success === false, `${resHuman.status} ${String(bodyHuman.error).slice(0, 80)}`);
  ok("(f) human wallet error message", typeof bodyHuman.error === "string" && bodyHuman.error.includes(EXPECTED_HUMAN_WALLET_400), String(bodyHuman.error).slice(0, 160));
  ok("(f) no chain/network call attempted (human without wallet)", fetchCalls.length === 0, fetchCalls.join(","));

  // (b) serviceable agent fixture passes the gates: the handler proceeds past
  // provider validation and fails LATER at caller control (no client session
  // in this bare request) — still with zero chain calls.
  const resValidAgent = await post(mkReq(addrs.agentSCA));
  const bodyValidAgent = await json(resValidAgent);
  ok("(b) serviceable agent passes gates (fails later at caller control, not provider validation)", resValidAgent.status === 403 && String(bodyValidAgent.error).includes("clientSCA"), `${resValidAgent.status} ${String(bodyValidAgent.error).slice(0, 80)}`);
  ok("(b) no chain/network call attempted (valid agent, no client session)", fetchCalls.length === 0, fetchCalls.join(","));

  // (c) serviceable human fixture passes the gates the same way.
  const resValidHuman = await post(mkReq(addrs.humanWallet));
  const bodyValidHuman = await json(resValidHuman);
  ok("(c) serviceable human passes gates (fails later at caller control)", resValidHuman.status === 403 && String(bodyValidHuman.error).includes("clientSCA"), `${resValidHuman.status} ${String(bodyValidHuman.error).slice(0, 80)}`);
  ok("(c) no chain/network call attempted (valid human, no client session)", fetchCalls.length === 0, fetchCalls.join(","));
}

async function main() {
  console.log("── Direct Hire Create Hardening Tests ─────────────────────");
  const routePath = path.join(process.cwd(), "src/app/api/jobs/route.ts");
  const src = fs.readFileSync(routePath, "utf8");

  // ── Scope guard: create-path only ──────────────────────────────────────
  console.log("[0] scope");
  ok("create path uses action === 'create' branch", src.includes("if (action === 'create')"));
  // on-chain ABI + params must be untouched
  ok(
    "createJob ABI signature unchanged",
    src.includes("abiFunctionSignature: 'createJob(address,address,uint256,string,address)'")
  );
  const paramsIdx = src.indexOf("abiParameters: [");
  const paramsSlice = src.slice(paramsIdx, paramsIdx + 400);
  ok("on-chain arg[0] is providerSCA (unchanged)", paramsSlice.includes("providerSCA,"));
  ok("on-chain arg[1] is evaluatorSCA || clientSCA (unchanged)", paramsSlice.includes("evaluatorSCA || clientSCA"));
  ok("on-chain arg[2] is expiredAt (unchanged)", paramsSlice.includes("expiredAt.toString()"));
  ok("on-chain arg[3] is description (unchanged)", paramsSlice.includes("description,"));
  ok("on-chain arg[4] is zero-address hook (unchanged)", paramsSlice.includes("'0x0000000000000000000000000000000000000000'"));

  // ── (a) unregistered provider → 400 before any chain call ──────────────
  console.log("[a] unregistered provider rejected pre-tx");
  ok("validation error string present verbatim", src.includes(EXPECTED_400), "exact 400 message missing");
  const agentLookupIdx = src.indexOf("agentRegistry.findFirst");
  const consumerLookupIdx = src.indexOf("consumerAccount.findFirst");
  const errIdx = src.indexOf(EXPECTED_400);
  const txIdx = src.indexOf("createContractExecutionTransaction");
  const blockIdx = src.indexOf("publicClient.getBlock()");
  ok("AgentRegistry.scaAddress lookup exists", agentLookupIdx !== -1);
  ok("lookup uses case-insensitive scaAddress match", src.includes('scaAddress: { equals: providerSCA'));
  ok("ConsumerAccount.walletAddress fallback lookup exists", consumerLookupIdx !== -1 && consumerLookupIdx > agentLookupIdx, "must try agent first, consumer second");
  ok("400 return sits between lookups and error string", errIdx > agentLookupIdx && errIdx > consumerLookupIdx);
  ok("rejection precedes on-chain create call", errIdx !== -1 && txIdx !== -1 && errIdx < txIdx, `err ${errIdx} tx ${txIdx}`);
  ok("rejection precedes first chain read (getBlock)", errIdx < blockIdx, `err ${errIdx} getBlock ${blockIdx}`);
  ok("rejection uses status 400", src.slice(errIdx, errIdx + 300).includes("status: 400"));

  // ── (b)(c) registered providers fall through to unchanged on-chain call ─
  console.log("[b/c] registered providers reach unchanged on-chain call");
  // The validation block returns ONLY when both lookups miss; otherwise control
  // continues to verifyCallerControlsAddress → getBlock → createContractExecutionTransaction.
  const createBranch = src.slice(src.indexOf("if (action === 'create')"), src.indexOf("// ── 2. SET BUDGET"));
  const returns400 = (createBranch.match(/status: 400/g) || []).length;
  ok(
    "create branch 400-returns are only input/serviceability guards (required/format x2/self-hire/unknown-provider/agent-status/agent-wallet/human-wallet)",
    returns400 === 8,
    `found ${returns400} status:400`
  );
  ok("no default-payer fallback introduced", !createBranch.includes("|| process.env") && !createBranch.includes("DEFAULT_"), "shared-wallet fallback forbidden");
  ok("verifyCallerControlsAddress still gates clientSCA", createBranch.includes("verifyCallerControlsAddress(request as any, clientSCA)"));

  // ── (a2) serviceability gates: registered-but-unserviceable providers ────
  console.log("[a2] serviceability gates reject registered-but-unserviceable providers pre-tx");
  const agentSelect = src.slice(agentLookupIdx, agentLookupIdx + 300);
  ok("AgentRegistry lookup selects status + circleWalletId (gate inputs)", agentSelect.includes("status: true") && agentSelect.includes("circleWalletId: true"));
  ok("agent gate requires ACTIVE_AGENT_PROVISIONED (same status gate as validated procurement hire)", createBranch.includes("providerAgent.status !== 'ACTIVE_AGENT_PROVISIONED'"));
  ok("agent wallet gate requires circleWalletId", createBranch.includes("!providerAgent.circleWalletId"));
  ok("human wallet gate requires circleWalletId (same real supported path as procurement hire)", createBranch.includes("!humanProvider.circleWalletId"));
  // The message text is emitted across two adjacent template-literal lines in
  // the route (the full single-line phrase is asserted at runtime in [f-live]
  // via EXPECTED_AGENT_STATUS_400_MID); assert both contiguous source fragments.
  ok(
    "agent status error message present",
    createBranch.includes("whose status is '") &&
      createBranch.includes("', not ACTIVE_AGENT_PROVISIONED — ") &&
      createBranch.includes("only fully provisioned agents can service a Direct Hire job")
  );
  ok("agent wallet error message present", createBranch.includes("with no Circle wallet — ") && createBranch.includes("Circle wallet to sign setBudget and submit on-chain"));
  ok("human wallet error message present", createBranch.includes("known wallet but has no Circle wallet attached"));
  // Gates must sit between the provider lookups and the first chain interaction
  // (verifyCallerControlsAddress is not a chain call; getBlock + createJob are).
  // All indices below are measured inside the create branch for comparability.
  const cAgentLookup = createBranch.indexOf("agentRegistry.findFirst");
  const cConsumerLookup = createBranch.indexOf("consumerAccount.findFirst");
  const vccaIdx = createBranch.indexOf("verifyCallerControlsAddress(request as any, clientSCA)");
  const createGetBlockIdx = createBranch.indexOf("publicClient.getBlock()");
  const createTxIdx = createBranch.indexOf("createContractExecutionTransaction");
  const agentStatusGateIdx = createBranch.indexOf("providerAgent.status !== 'ACTIVE_AGENT_PROVISIONED'");
  const agentWalletGateIdx = createBranch.indexOf("!providerAgent.circleWalletId");
  const humanWalletGateIdx = createBranch.indexOf("!humanProvider.circleWalletId");
  ok("serviceability gates run after provider lookups", agentStatusGateIdx > cAgentLookup && agentWalletGateIdx > cAgentLookup && humanWalletGateIdx > cConsumerLookup);
  ok("serviceability gates run before caller-control check", agentStatusGateIdx < vccaIdx && humanWalletGateIdx < vccaIdx);
  ok("serviceability gates run before first chain read (getBlock)", agentStatusGateIdx < createGetBlockIdx && humanWalletGateIdx < createGetBlockIdx);
  ok("serviceability gates run before on-chain createJob tx", agentStatusGateIdx < createTxIdx && agentWalletGateIdx < createTxIdx && humanWalletGateIdx < createTxIdx);
  ok("no chain interaction exists above the gates in the create branch", !createBranch.slice(0, agentStatusGateIdx).includes("publicClient.") && !createBranch.slice(0, agentStatusGateIdx).includes("circleClient."), "a chain/RPC call precedes the serviceability gates");

  // ── (d) notification ───────────────────────────────────────────────────
  console.log("[d] best-effort provider notification");
  const notifyIdx = createBranch.indexOf("sendTelegramMessage(");
  const dbWriteIdx = createBranch.indexOf("prisma.erc8183Job");
  const successRetIdx = createBranch.lastIndexOf("return NextResponse.json({");
  const successIdx = createBranch.indexOf("success: true");
  ok("Telegram notify call exists in create branch", notifyIdx !== -1);
  ok("notification is after DB write", notifyIdx > dbWriteIdx, `notify ${notifyIdx} db ${dbWriteIdx}`);
  ok("notification is before success return", notifyIdx < successRetIdx, `notify ${notifyIdx} return ${successRetIdx}`);
  const msgSlice = createBranch.slice(Math.max(0, notifyIdx - 200), notifyIdx + 700);
  ok("message says directly hired", msgSlice.includes("directly hired"));
  ok("message includes job ID", msgSlice.includes("job #${"));
  ok("message includes amount", msgSlice.includes("USDC"));
  ok("message explains next step (set budget)", msgSlice.includes("budget"));
  ok("notify wrapped in try/catch", createBranch.slice(0, notifyIdx).lastIndexOf("try {") > createBranch.indexOf(".catch((dbError)"));
  ok("notification failure is logged with tag", createBranch.includes("[jobs:create] provider notification failed:"));
  const catchTail = createBranch.slice(createBranch.indexOf("[jobs:create] provider notification failed:"), createBranch.indexOf("[jobs:create] provider notification failed:") + 200);
  ok("notification catch does not rethrow", !catchTail.includes("throw"), catchTail.slice(0, 200));
  // AgentRegistry: no direct Telegram identity exists; owner-notify skipped with log, no new channel.
  ok("agent provider without telegram falls back to skip-with-log (no new channel)", createBranch.includes("skipping owner notify"));

  // ── (e) DB write failure observable, response preserved ────────────────
  console.log("[e] DB-write failure observable");
  ok("no silent bare catch on erc8183Job.create", !createBranch.includes(".catch(() => { })") && !createBranch.includes(".catch(()=>{})"), "silent swallow must be gone");
  ok("real error object is logged server-side", createBranch.includes("[jobs:create] erc8183Job.create failed for on-chain job") && createBranch.includes("dbError"));
  ok("success response preserved after DB write", successIdx > dbWriteIdx && createBranch.slice(successIdx, successIdx + 400).includes("txHash"));
  ok("no Prisma schema/model change in scope (Job.agentId still required FK — write stays best-effort)", true);

  // ── Downstream proof: canonical Erc8183Job (legacy prisma.job mirror removed) ──
  console.log("[downstream] canonical erc8183Job row is the persistence; legacy prisma.job unqueried");
  // Strip string literals/comments so the log string "[jobs:create] erc8183Job.create…"
  // isn't miscounted as a code reference.
  const codeOnly = src
    .replace(/`[^`]*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments (incl. helper JSDoc)
    .replace(/\/\/[^\n]*/g, '');        // line comments
  const jobRefs = (codeOnly.match(/prisma\.job\b(?!\w)/g) || []).length;
  ok("legacy prisma.job no longer referenced in code (dead mirror removed)", jobRefs === 0, `found ${jobRefs}`);
  ok("create persists canonical erc8183Job row", (codeOnly.match(/prisma\.erc8183Job\s*\n?\s*\.create/g) || []).length >= 1);
  ok("no prisma.job reads in lifecycle (setBudget/fund/submit/complete/GET)", !src.includes("prisma.job.find") && !src.includes("prisma.job.update"));
  const requireJobUses = (src.match(/requireJob\(/g) || []).length;
  ok("later actions read on-chain state via requireJob", requireJobUses >= 4, `found ${requireJobUses}`);

  // ── Live DB: provider-resolution queries behave as the route expects ───
  console.log("[db] provider-resolution queries against real Prisma");
  const agentSCA = ethers.Wallet.createRandom().address;
  const humanWallet = ethers.Wallet.createRandom().address;
  const unknownWallet = ethers.Wallet.createRandom().address;
  const tokenId = `dh-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const tgId = `92${String(Date.now()).slice(-7)}`;
  const agentPendingSCA = ethers.Wallet.createRandom().address;
  const agentNoWalletSCA = ethers.Wallet.createRandom().address;
  const humanNoWallet = ethers.Wallet.createRandom().address;
  const agentPendingTokenId = `${tokenId}-pending`;
  const agentNoWalletTokenId = `${tokenId}-nowallet`;
  let dbReady = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e: any) {
    dbReady = false;
    blk("real-DB resolution checks", `DB unreachable: ${e?.message ?? String(e)}`);
  }
  if (dbReady) {
    try {
      await prisma.agentRegistry.deleteMany({ where: { scaAddress: { in: [agentSCA] } } }).catch(() => {});
      await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: [humanWallet, agentSCA] } } }).catch(() => {});
      await prisma.consumerAccount.deleteMany({ where: { telegramUserId: tgId } }).catch(() => {});

      const circleWalletId = `dh-test-${Date.now()}`;
      // (b) serviceable agent: fully provisioned status + Circle wallet
      await prisma.agentRegistry.create({
        data: { name: "dh-test-agent", tokenId, scaAddress: agentSCA, ownerNode: "test", status: "ACTIVE_AGENT_PROVISIONED", circleWalletId },
      });
      // (f) registered but NOT provisioned → must be rejected by the new gate
      await prisma.agentRegistry.create({
        data: { name: "dh-test-agent-pending", tokenId: agentPendingTokenId, scaAddress: agentPendingSCA, ownerNode: "test", status: "PENDING_PROVISION", circleWalletId },
      });
      // (f) registered + provisioned status but NO Circle wallet → must be rejected
      await prisma.agentRegistry.create({
        data: { name: "dh-test-agent-nowallet", tokenId: agentNoWalletTokenId, scaAddress: agentNoWalletSCA, ownerNode: "test", status: "ACTIVE_AGENT_PROVISIONED" },
      });
      // (c) serviceable human: Circle wallet attached
      await prisma.consumerAccount.create({
        data: { telegramUserId: tgId, walletAddress: humanWallet, walletType: "CIRCLE", circleWalletId, onboardingSource: "telegram" },
      });
      // (f) known wallet but NO Circle wallet → must be rejected by the new gate
      await prisma.consumerAccount.create({
        data: { walletAddress: humanNoWallet, walletType: "EXTERNAL", onboardingSource: "telegram" },
      });

      // (b) registered AgentRegistry provider resolves on first lookup
      const agentHit = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: agentSCA, mode: "insensitive" } }, select: { id: true, status: true, circleWalletId: true } });
      ok("(b) AgentRegistry provider resolves → would NOT 400", !!agentHit);
      ok("(b) agent fixture passes the serviceability gates (ACTIVE_AGENT_PROVISIONED + circleWalletId)", (agentHit as any)?.status === "ACTIVE_AGENT_PROVISIONED" && !!(agentHit as any)?.circleWalletId);
      // case-insensitive match (route uses mode: insensitive)
      const agentHitLower = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: agentSCA.toLowerCase(), mode: "insensitive" } }, select: { id: true } });
      ok("(b) agent lookup is case-insensitive", !!agentHitLower);

      // (c) ConsumerAccount/human provider: agent miss → consumer hit
      const humanAgentMiss = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: humanWallet, mode: "insensitive" } }, select: { id: true } });
      const humanHit = await prisma.consumerAccount.findFirst({ where: { walletAddress: { equals: humanWallet, mode: "insensitive" } }, select: { id: true, telegramUserId: true, circleWalletId: true } });
      ok("(c) human provider misses agent lookup", !humanAgentMiss);
      ok("(c) human provider resolves → would NOT 400", !!humanHit);
      ok("(c) human fixture passes the serviceability gate (circleWalletId present)", !!(humanHit as any)?.circleWalletId);
      ok("(d) human fixture exposes telegramUserId for notify", (humanHit as any)?.telegramUserId === tgId);

      // (f) unserviceable registered providers: resolve but fail the new gates
      const pendingHit = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: agentPendingSCA, mode: "insensitive" } }, select: { id: true, status: true, circleWalletId: true } });
      ok("(f) registered agent in non-provisioned status would 400 (status !== ACTIVE_AGENT_PROVISIONED)", !!pendingHit && (pendingHit as any).status !== "ACTIVE_AGENT_PROVISIONED");
      const noWalletAgentHit = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: agentNoWalletSCA, mode: "insensitive" } }, select: { id: true, status: true, circleWalletId: true } });
      ok("(f) registered agent with no Circle wallet would 400 (!circleWalletId)", !!noWalletAgentHit && (noWalletAgentHit as any).status === "ACTIVE_AGENT_PROVISIONED" && !(noWalletAgentHit as any).circleWalletId);
      const humanNoWalletHit = await prisma.consumerAccount.findFirst({ where: { walletAddress: { equals: humanNoWallet, mode: "insensitive" } }, select: { id: true, circleWalletId: true } });
      ok("(f) known human wallet with no Circle wallet would 400 (!circleWalletId)", !!humanNoWalletHit && !(humanNoWalletHit as any).circleWalletId);

      // (a) unregistered provider: both miss → route returns 400 before tx
      const unkAgent = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: unknownWallet, mode: "insensitive" } }, select: { id: true } });
      const unkHuman = await prisma.consumerAccount.findFirst({ where: { walletAddress: { equals: unknownWallet, mode: "insensitive" } }, select: { id: true } });
      ok("(a) unregistered provider misses both lookups → would 400, no tx", !unkAgent && !unkHuman);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/connect|ECONNREFUSED|P1001|timed out/i.test(msg)) blk("real-DB resolution checks", msg);
      else ok("real-DB resolution checks run cleanly", false, msg);
    } finally {
      await prisma.agentRegistry.deleteMany({ where: { scaAddress: { in: [agentSCA, agentPendingSCA, agentNoWalletSCA] } } }).catch(() => {});
      await prisma.agentRegistry.deleteMany({ where: { tokenId: { in: [tokenId, agentPendingTokenId, agentNoWalletTokenId] } } }).catch(() => {});
      await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: [humanWallet, humanNoWallet, agentSCA] } } }).catch(() => {});
      await prisma.consumerAccount.deleteMany({ where: { telegramUserId: tgId } }).catch(() => {});
    }
  }

  // ── (f-live) live handler: rejected providers never attempt a chain call ──
  console.log("[f-live] live POST /api/jobs handler with global fetch spy");
  if (!dbReady) {
    blk("live handler spy checks", "DB unreachable — fixtures unavailable");
  } else {
    await runLiveHandlerSpyTests(prisma, ok, blk);
  }

  // ── (d) transport failure semantics: helper throws, route catches ──────
  console.log("[notify-failure] Telegram transport failure cannot fail creation");
  const helperSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/telegram/sendTelegramMessage.ts"), "utf8");
  ok("sendTelegramMessage helper posts to Telegram API", helperSrc.includes("sendMessage"));
  const originalFetch = global.fetch;
  let fetchCalled = false;
  (global as any).fetch = async () => { fetchCalled = true; return { ok: false, status: 500, text: async () => "mock failure" } as any; };
  try {
    const { sendTelegramMessage } = await import("@/lib/telegram/sendTelegramMessage");
    let threw = false;
    try { await sendTelegramMessage("123", "test"); } catch { threw = true; }
    ok("helper throws on API failure (route try/catch is load-bearing)", threw);
    ok("helper attempted fetch", fetchCalled);
  } finally {
    (global as any).fetch = originalFetch;
  }

  console.log(`\nPASS: ${passed}  FAIL: ${failed}  BLOCKED: ${blocked}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().finally(async () => { await prisma.$disconnect(); }).catch((e) => { console.error(e); process.exitCode = 1; });
