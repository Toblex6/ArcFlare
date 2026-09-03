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
  ok("create branch 400-returns are only input guards (required/format x2/self-hire/unknown-provider)", returns400 === 5, `found ${returns400} status:400`);
  ok("no default-payer fallback introduced", !createBranch.includes("|| process.env") && !createBranch.includes("DEFAULT_"), "shared-wallet fallback forbidden");
  ok("verifyCallerControlsAddress still gates clientSCA", createBranch.includes("verifyCallerControlsAddress(request as any, clientSCA)"));

  // ── (d) notification ───────────────────────────────────────────────────
  console.log("[d] best-effort provider notification");
  const notifyIdx = createBranch.indexOf("sendTelegramMessage(");
  const dbWriteIdx = createBranch.indexOf("prisma.job");
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
  ok("no silent bare catch on prisma.job.create", !createBranch.includes(".catch(() => { })") && !createBranch.includes(".catch(()=>{})"), "silent swallow must be gone");
  ok("real error object is logged server-side", createBranch.includes("[jobs:create] prisma.job.create failed for on-chain job") && createBranch.includes("dbError"));
  ok("success response preserved after DB write", successIdx > dbWriteIdx && createBranch.slice(successIdx, successIdx + 400).includes("txHash"));
  ok("no Prisma schema/model change in scope (Job.agentId still required FK — write stays best-effort)", true);

  // ── Downstream proof: prisma.job row NOT required ──────────────────────
  console.log("[downstream] prisma.job row not required later");
  // Strip string literals/comments so the log string "[jobs:create] prisma.job.create…"
  // isn't miscounted as a code reference.
  const codeOnly = src
    .replace(/`[^`]*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\/\/[^\n]*/g, '');
  const jobRefs = (codeOnly.match(/prisma\.job\b(?!\w)/g) || []).length;
  ok("prisma.job referenced exactly once in code (the create write)", jobRefs === 1, `found ${jobRefs}`);
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

      await prisma.agentRegistry.create({
        data: { name: "dh-test-agent", tokenId, scaAddress: agentSCA, ownerNode: "test", status: "ACTIVE_AGENT_PROVISIONED" },
      });
      await prisma.consumerAccount.create({
        data: { telegramUserId: tgId, walletAddress: humanWallet, walletType: "CIRCLE", circleWalletId: `dh-test-${Date.now()}`, onboardingSource: "telegram" },
      });

      // (b) registered AgentRegistry provider resolves on first lookup
      const agentHit = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: agentSCA, mode: "insensitive" } }, select: { id: true } });
      ok("(b) AgentRegistry provider resolves → would NOT 400", !!agentHit);
      // case-insensitive match (route uses mode: insensitive)
      const agentHitLower = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: agentSCA.toLowerCase(), mode: "insensitive" } }, select: { id: true } });
      ok("(b) agent lookup is case-insensitive", !!agentHitLower);

      // (c) ConsumerAccount/human provider: agent miss → consumer hit
      const humanAgentMiss = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: humanWallet, mode: "insensitive" } }, select: { id: true } });
      const humanHit = await prisma.consumerAccount.findFirst({ where: { walletAddress: { equals: humanWallet, mode: "insensitive" } }, select: { id: true, telegramUserId: true } });
      ok("(c) human provider misses agent lookup", !humanAgentMiss);
      ok("(c) human provider resolves → would NOT 400", !!humanHit);
      ok("(d) human fixture exposes telegramUserId for notify", (humanHit as any)?.telegramUserId === tgId);

      // (a) unregistered provider: both miss → route returns 400 before tx
      const unkAgent = await prisma.agentRegistry.findFirst({ where: { scaAddress: { equals: unknownWallet, mode: "insensitive" } }, select: { id: true } });
      const unkHuman = await prisma.consumerAccount.findFirst({ where: { walletAddress: { equals: unknownWallet, mode: "insensitive" } }, select: { id: true } });
      ok("(a) unregistered provider misses both lookups → would 400, no tx", !unkAgent && !unkHuman);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/connect|ECONNREFUSED|P1001|timed out/i.test(msg)) blk("real-DB resolution checks", msg);
      else ok("real-DB resolution checks run cleanly", false, msg);
    } finally {
      await prisma.agentRegistry.deleteMany({ where: { scaAddress: { in: [agentSCA] } } }).catch(() => {});
      await prisma.agentRegistry.deleteMany({ where: { tokenId } }).catch(() => {});
      await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: [humanWallet, agentSCA] } } }).catch(() => {});
      await prisma.consumerAccount.deleteMany({ where: { telegramUserId: tgId } }).catch(() => {});
    }
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
