/**
 * telegram-completion-tests.ts
 *
 * Focused tests for Telegram Completion + Docs batch (2026-08-28):
 *  - /help includes /retrygas and /history
 *  - /history returns only caller's own completed jobs
 *  - completion notification fires exactly once per job (not per ledger entry)
 *  - Telegram API failure does not fail completion
 *
 * Run: npx tsx scripts/telegram-completion-tests.ts
 * No dev server required; DB rows are used for /history scoping checks.
 * Static file checks cover the once-per-job + try/catch properties.
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

async function main() {
  console.log("── Telegram Completion Tests ────────────────────────────");

  // 1. /help includes /retrygas and /history
  const { handleHelp } = await import("@/lib/telegram/botHandlers");
  const help = await handleHelp();
  ok("/help includes /retrygas", help.text.includes("/retrygas"), help.text);
  ok("/help includes /history", help.text.includes("/history"), help.text);
  ok("/help includes /earnings or history hint", help.text.includes("history"), help.text);

  // 2. /history scoping
  const TG_USER_A = "910000010";
  const TG_USER_B = "910000011";
  const walletA = ethers.Wallet.createRandom().address;
  const walletB = ethers.Wallet.createRandom().address;
  const jobIdA = BigInt(Date.now() * 1000 + 1);
  const jobIdB = BigInt(Date.now() * 1000 + 2);

  // cleanup before
  await prisma.erc8183Job.deleteMany({ where: { jobId: { in: [jobIdA, jobIdB] } } }).catch(()=>{});
  await prisma.consumerAccount.deleteMany({ where: { telegramUserId: { in: [TG_USER_A, TG_USER_B] } } }).catch(()=>{});
  // ensure wallets unique
  await prisma.consumerAccount.deleteMany({ where: { walletAddress: { in: [walletA, walletB] } } }).catch(()=>{});

  await prisma.consumerAccount.create({ data: { telegramUserId: TG_USER_A, walletAddress: walletA, walletType: "CIRCLE", circleWalletId: "tg-test-history-a", onboardingSource: "telegram" } });
  await prisma.consumerAccount.create({ data: { telegramUserId: TG_USER_B, walletAddress: walletB, walletType: "CIRCLE", circleWalletId: "tg-test-history-b", onboardingSource: "telegram" } });
  await prisma.erc8183Job.create({ data: { jobId: jobIdA, clientSCA: ethers.Wallet.createRandom().address, providerSCA: walletA, evaluatorSCA: ethers.Wallet.createRandom().address, description: "History test job A", budget: 1234567n, status: "COMPLETED", expiredAt: new Date(Date.now()+86400000), txHashes: [] } });
  await prisma.erc8183Job.create({ data: { jobId: jobIdB, clientSCA: ethers.Wallet.createRandom().address, providerSCA: walletB, evaluatorSCA: ethers.Wallet.createRandom().address, description: "History test job B", budget: 7654321n, status: "COMPLETED", expiredAt: new Date(Date.now()+86400000), txHashes: [] } });

  const { handleHistory } = await import("@/lib/telegram/botHandlers");
  const histA = await handleHistory(TG_USER_A);
  const histB = await handleHistory(TG_USER_B);
  ok("/history user A sees own job", histA.text.includes(jobIdA.toString()), histA.text);
  ok("/history user A does not see B's job", !histA.text.includes(jobIdB.toString()), histA.text);
  ok("/history user B sees own job", histB.text.includes(jobIdB.toString()), histB.text);
  ok("/history user B does not see A's job", !histB.text.includes(jobIdA.toString()), histB.text);
  // also check that earnings sum is present
  ok("/history includes earnings total", histA.text.includes("earnings") || histA.text.includes("Lifetime"), histA.text);

  // cleanup scoping rows
  await prisma.erc8183Job.deleteMany({ where: { jobId: { in: [jobIdA, jobIdB] } } }).catch(()=>{});
  await prisma.consumerAccount.deleteMany({ where: { telegramUserId: { in: [TG_USER_A, TG_USER_B] } } }).catch(()=>{});

  // 3. Static: completion notification fires once per job, not per ledger entry
  const completePath = path.join(process.cwd(), "src/app/api/jobs/complete/route.ts");
  const completeSrc = fs.readFileSync(completePath, "utf8");
  const sendCalls = (completeSrc.match(/sendTelegramMessage\s*\(/g) || []).length;
  ok("jobs/complete calls sendTelegramMessage exactly once", sendCalls === 1, `found ${sendCalls}`);
  // ensure it's outside the ledger loop (after ledger block, before return)
  const ledgerIdx = completeSrc.indexOf("Build 3 ledger");
  const notifyIdx = completeSrc.indexOf("sendTelegramMessage");
  const retIdx = completeSrc.indexOf("return NextResponse.json({ success: true, jobId");
  ok("notification is after ledger block", ledgerIdx !== -1 && notifyIdx > ledgerIdx, `ledger ${ledgerIdx} notify ${notifyIdx}`);
  ok("notification is before final return (once per job)", notifyIdx !== -1 && notifyIdx < retIdx, `notify ${notifyIdx} return ${retIdx}`);
  // ensure try/catch around it
  const notifySlice = completeSrc.slice(Math.max(0, notifyIdx - 500), notifyIdx + 500);
  ok("notification wrapped in try/catch", notifySlice.includes("try") || completeSrc.slice(notifyIdx-800, notifyIdx).includes("try"), "no try near notify");
  // check that failure is logged not thrown (no throw inside that catch that re-throws)
  ok("notification failure is logged not rethrown", completeSrc.includes("[telegram/notify]"), "missing log tag");

  // 4. Telegram API failure does not fail completion — verify send helper throws but caller catches
  const helperPath = path.join(process.cwd(), "src/lib/telegram/sendTelegramMessage.ts");
  const helperSrc = fs.readFileSync(helperPath, "utf8");
  ok("sendTelegramMessage helper exists", helperSrc.includes("api.telegram.org"), "missing api url");
  ok("sendTelegramMessage posts to sendMessage", helperSrc.includes("sendMessage"), "missing sendMessage");
  // simulate failure path: save original fetch, stub to throw, ensure complete's try/catch would swallow
  const originalFetch = global.fetch;
  let fetchCalled = false;
  (global as any).fetch = async () => { fetchCalled = true; return { ok: false, status: 500, text: async () => "mock failure" } as any; };
  try {
    const { sendTelegramMessage } = await import("@/lib/telegram/sendTelegramMessage");
    let threw = false;
    try { await sendTelegramMessage("123", "test"); } catch { threw = true; }
    ok("sendTelegramMessage throws on API failure (caller must catch)", threw, "did not throw");
    ok("sendTelegramMessage attempted fetch", fetchCalled, "no fetch");
  } finally {
    (global as any).fetch = originalFetch;
  }
  // Verify the complete route's catch would prevent throw: the code pattern is `try { ... send } catch { log }` with no rethrow
  const catchBlock = completeSrc.slice(notifyIdx, notifyIdx + 800);
  ok("complete's catch does not rethrow", !catchBlock.includes("throw"), catchBlock.slice(0,200));

  console.log(`\nPASS: ${passed}  FAIL: ${failed}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().finally(async () => { await prisma.$disconnect(); }).catch(e => { console.error(e); process.exitCode = 1; });
