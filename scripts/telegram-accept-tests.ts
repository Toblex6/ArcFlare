/**
 * telegram-accept-tests.ts
 *
 * Focused tests for the Jobs/Telegram batch — human-worker hiring loop:
 *  - /help exposes /accept
 *  - /accept gating: no session, invalid job id, invalid amount, no Circle wallet
 *  - /apply on a legacy direct-hire job → steer reply, ZERO JobApplication rows
 *  - /jobs lists procurement postings only (never legacy direct-hire jobs)
 *  - static proofs: accept route resolves human providers via ConsumerAccount;
 *    hire route notifies hired workers (best-effort); jobs/[jobId]/apply refuses
 *    legacy applications with DIRECT_HIRE_NO_APPLICATIONS; webhook dispatches /accept
 *
 * Run: npx tsx scripts/telegram-accept-tests.ts
 * No dev server required (handler-level + DB + static file checks).
 */
import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; failures.push(`${name}: ${detail}`); console.log(`  ❌ ${name} — ${detail}`); }
}

const TG_USER = "910000050"; // /accept gating
const TG_APPLIER = "910000051"; // legacy steer

async function main() {
  console.log("── Telegram /accept + legacy /apply steer tests ──────────────");
  const { handleAccept, handleApply, handleListJobs, handleHelp } = await import("@/lib/telegram/botHandlers");

  // 1. /help exposes /accept
  const help = await handleHelp();
  ok("/help includes /accept", help.text.includes("/accept"), help.text);

  // 2. /accept gating (all short-circuit before any on-chain call)
  // ensure clean state BEFORE the no-session test (a prior run may have left a row)
  await prisma.consumerAccount.deleteMany({ where: { telegramUserId: TG_USER } }).catch(() => {});
  const noSession = await handleAccept(TG_USER, "123");
  ok("/accept without session → start first", noSession.text.includes("/start"), noSession.text);

  // create an account WITH a wallet (session resolves) but no Circle wallet
  const gatingWallet = ethers.Wallet.createRandom().address;
  await prisma.consumerAccount.deleteMany({ where: { walletAddress: gatingWallet } }).catch(() => {});
  await prisma.consumerAccount.create({
    data: { telegramUserId: TG_USER, walletAddress: gatingWallet, walletType: "CIRCLE", onboardingSource: "telegram" },
  });

  const badJob = await handleAccept(TG_USER, "abc");
  ok("/accept invalid job id → usage", badJob.text.includes("Usage: /accept"), badJob.text);

  const badAmount = await handleAccept(TG_USER, "123", "0.0000001");
  ok("/accept invalid amount → usage", badAmount.text.includes("Usage") || badAmount.text.includes("Invalid amount"), badAmount.text);

  const noWallet = await handleAccept(TG_USER, "123");
  ok("/accept with account lacking Circle wallet → clear reply", noWallet.text.includes("no Circle wallet"), noWallet.text);

  // 3. /apply legacy steer — zero rows
  const legacyJobId = BigInt(Date.now() * 1000 + 7);
  const applierWallet = ethers.Wallet.createRandom().address;
  await prisma.consumerAccount.deleteMany({ where: { telegramUserId: TG_APPLIER } }).catch(() => {});
  await prisma.consumerAccount.deleteMany({ where: { walletAddress: applierWallet } }).catch(() => {});
  await prisma.erc8183Job.deleteMany({ where: { jobId: legacyJobId } }).catch(() => {});
  await prisma.consumerAccount.create({
    data: { telegramUserId: TG_APPLIER, walletAddress: applierWallet, walletType: "CIRCLE", circleWalletId: "tg-test-applier", onboardingSource: "telegram" },
  });
  await prisma.erc8183Job.create({
    data: { jobId: legacyJobId, clientSCA: ethers.Wallet.createRandom().address, providerSCA: ethers.Wallet.createRandom().address, evaluatorSCA: ethers.Wallet.createRandom().address, description: "Legacy direct-hire job", budget: 1000000n, status: "OPEN", expiredAt: new Date(Date.now() + 86400000), txHashes: [] },
  });

  const steer = await handleApply(TG_APPLIER, legacyJobId.toString(), "I can do this deliverable");
  ok("/apply on legacy job → steer text", steer.text.includes("direct-hire"), steer.text);
  const rows = await prisma.jobApplication.count({ where: { jobId: legacyJobId } });
  ok("/apply on legacy job → ZERO application rows", rows === 0, `rows ${rows}`);

  const missing = await handleApply(TG_APPLIER, legacyJobId.toString(), "");
  ok("/apply missing pitch → usage reply", missing.text.includes("pitch"), missing.text);

  // 4. /jobs lists procurement postings only, with semantic job<N> ids
  const agentSc = ethers.Wallet.createRandom().address;
  const clientAgent = await prisma.agentRegistry.create({
    data: { name: "tg-accept-listings-agent", tokenId: `tg-accept-${Date.now()}`, scaAddress: agentSc, ownerNode: "harness", status: "ACTIVE_AGENT_PROVISIONED" },
  });
  const posting = await (prisma as any).procurementPosting.create({
    data: { clientAgentId: clientAgent.id, clientSCA: agentSc, description: "Procurement listing for /jobs test", budgetMax: "2000000", status: "OPEN", merchantId: "tg-accept-test" },
  });
  const list = await handleListJobs();
  ok("/jobs includes the procurement posting (by job<N>)", list.text.includes(`job${posting.seq}`), list.text);
  ok("/jobs does NOT list legacy direct-hire job", !list.text.includes(legacyJobId.toString()), list.text);
  ok("/jobs shows semantic job<N> id", list.text.includes(`job${posting.seq}`), `listing ${list.text}`);
  ok("/jobs listing has no '(procurement)' jargon", !list.text.includes("(procurement)"), `listing ${list.text}`);

  // 5. /apply job<N> — semantic id + quoted pitch (quotes stripped)
  const humanId = `job${posting.seq}`;
  const applier2Wallet = ethers.Wallet.createRandom().address;
  await prisma.consumerAccount.deleteMany({ where: { telegramUserId: TG_APPLIER } }).catch(() => {});
  await prisma.consumerAccount.create({
    data: { telegramUserId: TG_APPLIER, walletAddress: applier2Wallet, walletType: "CIRCLE", circleWalletId: "tg-test-applier-2", onboardingSource: "telegram" },
  });
  const quoted = await handleApply(TG_APPLIER, humanId, '"I can deliver this in 2 days"');
  ok("/apply job<N> with quoted pitch → success", quoted.text.includes("Application submitted"), quoted.text);
  ok("/apply reply uses job<N>, not the cuid", quoted.text.includes(`job${posting.seq}`) && !quoted.text.includes(posting.id), `reply ${quoted.text}`);
  const appRow = await (prisma as any).procurementApplication.findFirst({ where: { procurementId: posting.id } });
  ok("applied via job<N> id (row exists)", !!appRow, "no application row");
  ok("quotes stripped from stored pitch", appRow?.pitch === "I can deliver this in 2 days", `pitch ${JSON.stringify(appRow?.pitch)}`);
  const appliedCuid = await handleApply(TG_APPLIER, posting.id, "plain unquoted pitch");
  ok("/apply duplicate via cuid → already applied", appliedCuid.text.includes("already applied"), appliedCuid.text);
  const missingJob = await handleApply(TG_APPLIER, humanId, "");
  ok("/apply job<N> missing pitch → usage reply", missingJob.text.includes("pitch") && missingJob.text.includes("quotes"), missingJob.text);

  // cleanup
  await (prisma as any).procurementApplication.deleteMany({ where: { procurementId: posting.id } }).catch(() => {});
  await (prisma as any).procurementPosting.delete({ where: { id: posting.id } }).catch(() => {});
  await prisma.agentRegistry.delete({ where: { id: clientAgent.id } }).catch(() => {});
  await prisma.erc8183Job.deleteMany({ where: { jobId: legacyJobId } }).catch(() => {});
  await prisma.consumerAccount.deleteMany({ where: { telegramUserId: { in: [TG_USER, TG_APPLIER] } } }).catch(() => {});

  // 5. Static proofs
  const acceptPath = path.join(process.cwd(), "src/app/api/jobs/[jobId]/accept/route.ts");
  const acceptSrc = fs.readFileSync(acceptPath, "utf8");
  ok("accept route resolves human providers via ConsumerAccount", acceptSrc.includes("isHumanProvider") && acceptSrc.includes("consumerAccount.findFirst"), "missing human branch");
  ok("accept route does not hard-404 on missing agent", !acceptSrc.includes('"provider agent not found"'), "still agent-gated");
  ok("accept route skips agent policy for humans", acceptSrc.includes("if (!isHumanProvider)"), "no policy gate");

  const hirePath = path.join(process.cwd(), "src/app/api/procurement/[id]/hire/route.ts");
  const hireSrc = fs.readFileSync(hirePath, "utf8");
  ok("hire route resolves human providers", hireSrc.includes("humanProvider") && hireSrc.includes("consumerAccount.findFirst"), "missing human branch");
  ok("hire route notifies hired worker (best-effort)", hireSrc.includes("sendTelegramMessage") && hireSrc.includes("worker telegram notification failed"), "no notification");
  ok("hire route neutral-50 trust for humans", hireSrc.includes("neutral 50"), "no trust baseline");

  const applyHttpPath = path.join(process.cwd(), "src/app/api/jobs/[jobId]/apply/route.ts");
  const applyHttpSrc = fs.readFileSync(applyHttpPath, "utf8");
  ok("jobs/[jobId]/apply refuses with DIRECT_HIRE_NO_APPLICATIONS", applyHttpSrc.includes("DIRECT_HIRE_NO_APPLICATIONS"), "no refusal code");
  ok("jobs/[jobId]/apply no longer writes applications", !applyHttpSrc.includes("submitApplication({"), "still calls submitApplication");

  const webhookPath = path.join(process.cwd(), "src/app/api/telegram/webhook/route.ts");
  const webhookSrc = fs.readFileSync(webhookPath, "utf8");
  ok("webhook dispatches /accept", webhookSrc.includes("case '/accept'") && webhookSrc.includes("handleAccept"), "no dispatch");
  ok("webhook /apply usage says to input the job id and the pitch", webhookSrc.includes("Input the job id and your pitch"), "usage not updated");
  const botPath = path.join(process.cwd(), "src/lib/telegram/botHandlers.ts");
  const botSrc = fs.readFileSync(botPath, "utf8");
  ok("bot /jobs no longer lists legacy jobs", botSrc.includes("postings only") || botSrc.includes("postings (the only jobs"), "legacy fallback still present");
  ok("bot resolves semantic job<N> posting ids", botSrc.includes("resolvePostingId") && botSrc.includes("/^job(\\d+)$/i"), "no job<N> resolver");
  ok("bot strips surrounding quotes from pitch", botSrc.includes("stripQuotes"), "no quote stripping");
  ok("/help shows quoted-pitch example", (await handleHelp()).text.includes('"<your pitch>"'), "help not updated");

  // 6. Static proofs — admin job moderation
  const adminListPath = path.join(process.cwd(), "src/app/api/admin/jobs/route.ts");
  const adminListSrc = fs.readFileSync(adminListPath, "utf8");
  ok("admin jobs list requires admin session", adminListSrc.includes("resolveAdminSession"), "no admin gate");
  ok("admin jobs list returns postings with humanId", adminListSrc.includes("humanId"), "no humanId");
  const adminRemovePath = path.join(process.cwd(), "src/app/api/admin/jobs/[jobId]/remove/route.ts");
  const adminRemoveSrc = fs.readFileSync(adminRemovePath, "utf8");
  ok("admin job remove requires admin session", adminRemoveSrc.includes("resolveAdminSession"), "no admin gate");
  ok("admin job remove marks removedAt/removedReason", adminRemoveSrc.includes("removedAt") && adminRemoveSrc.includes("removedReason"), "no removal fields");
  ok("admin job remove rejects on-chain only when safe (OPEN)", adminRemoveSrc.includes("status === 0"), "no on-chain guard");
  const adminPostingRemovePath = path.join(process.cwd(), "src/app/api/admin/postings/[id]/remove/route.ts");
  const adminPostingRemoveSrc = fs.readFileSync(adminPostingRemovePath, "utf8");
  ok("admin posting remove accepts job<N>", adminPostingRemoveSrc.includes("/^job(\\d+)$/i"), "no job<N> posting removal");
  const adminJobsPagePath = path.join(process.cwd(), "src/app/admin/jobs/page.tsx");
  const adminJobsPageSrc = fs.readFileSync(adminJobsPagePath, "utf8");
  ok("admin jobs page has remove buttons", adminJobsPageSrc.includes("Remove") && adminJobsPageSrc.includes("/api/admin/jobs"), "no remove UI");

  // 7. Static proofs — treasury credit endpoint (this task)
  const creditPath = path.join(process.cwd(), "src/app/api/agents/[id]/treasury/credit/route.ts");
  const creditSrc = fs.readFileSync(creditPath, "utf8");
  ok("treasury credit requires merchant auth", creditSrc.includes("resolveMerchant"), "no merchant gate");
  ok("treasury credit requires control of the agent", creditSrc.includes("verifyCallerControlsAddress"), "no agent control gate");
  ok("treasury credit derives source wallet server-side (never body)", creditSrc.includes("merchantRecord.circleWalletId") && !/body\.(walletId|walletAddress|destinationAddress)/.test(creditSrc), "body-trusted wallet");
  ok("treasury credit destination must resolve to agent scaAddress", creditSrc.includes("destAddress.toLowerCase() !== agent.scaAddress.toLowerCase()"), "no scaAddress match");
  ok("treasury credit records ADJUSTMENT (not REVENUE)", creditSrc.includes("type: 'ADJUSTMENT'"), "wrong ledger type");
  ok("treasury credit measures received delta", creditSrc.includes("receivedWei = delta"), "no delta measurement");
  ok("treasury credit records ledger deduped by txHash", creditSrc.includes("txHash: arcTxHash"), "no txHash dedupe");
  ok("jobs page has fund-treasury wiring", fs.readFileSync(path.join(process.cwd(), "src/app/jobs/page.tsx"), "utf8").includes("treasury/credit"), "no UI wiring");
  ok("jobs page normalizes budget to 6-dec", fs.readFileSync(path.join(process.cwd(), "src/app/jobs/page.tsx"), "utf8").includes("toUsdcSixDec"), "no units fix");

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().finally(async () => { await prisma.$disconnect(); }).catch((e) => { console.error(e); process.exitCode = 1; });
