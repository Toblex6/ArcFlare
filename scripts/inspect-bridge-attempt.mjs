// scripts/inspect-bridge-attempt.mjs
//
// One-off production diagnostic for EXTERNAL bridge attempts. Connects to
// DATABASE_URL and prints, per FlowBridgeIntent:
//   - intent id, status, createdAt (+ sourceWallet/destination/amount/burn/mint)
//   - every bridge_attempt_stages row for that intent, in order, with
//     stage, txHash, chainId, errorDetail, createdAt
//
// Usage:
//   node scripts/inspect-bridge-attempt.mjs --wallet 0xece8...7a10 [--limit 10]
//   node scripts/inspect-bridge-attempt.mjs --latest 5
//   node scripts/inspect-bridge-attempt.mjs --reference <intentId>
//
// Env: DATABASE_URL must point at the DB to inspect (production). The script
// reads .env.local then .env via dotenv, same precedence as Next.js local dev.
// Never prints the connection string.

import 'dotenv/config';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

// Next.js loads .env.local over .env; plain dotenv only loads .env, so fill
// gaps from .env.local explicitly (values already set win).
function loadEnvLocal() {
  try {
    const raw = fs.readFileSync('.env.local', 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, k, v] = m;
      if (process.env[k] === undefined) {
        process.env[k] = v.replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env.local — fine */ }
}
loadEnvLocal();

function usage() {
  console.log('Usage:');
  console.log('  node scripts/inspect-bridge-attempt.mjs --wallet 0x... [--limit 10]');
  console.log('  node scripts/inspect-bridge-attempt.mjs --latest 5');
  console.log('  node scripts/inspect-bridge-attempt.mjs --reference <intentId>');
}

function parseArgs(argv) {
  const out = { wallet: null, latest: null, reference: null, limit: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wallet') out.wallet = argv[++i] ?? null;
    else if (a === '--latest') out.latest = Number(argv[++i] ?? '5');
    else if (a === '--reference') out.reference = argv[++i] ?? null;
    else if (a === '--limit') out.limit = Number(argv[++i] ?? '10');
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.wallet && args.latest == null && !args.reference) {
  usage();
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Point it at production before running.');
  process.exit(1);
}
// Guardrail: confirm we are on the production host, not a local/dev DB.
const dbUrl = process.env.DATABASE_URL;
try {
  const host = new URL(dbUrl.replace(/^prisma\+postgres:\/\//, 'https://')).host;
  console.log(`DB host: ${host}`);
} catch {
  console.log('DB host: (unparseable, continuing)');
}

const prisma = new PrismaClient();

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

async function stageTableExists() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public.bridge_attempt_stages') AS tbl`
  );
  return rows?.[0]?.tbl !== null;
}

async function printIntent(intent) {
  console.log('─'.repeat(72));
  console.log(`intent     : ${intent.id}`);
  console.log(`status     : ${intent.status}`);
  console.log(`createdAt  : ${fmt(intent.createdAt)}`);
  console.log(`updatedAt  : ${fmt(intent.updatedAt)}`);
  console.log(`source     : ${intent.sourceChain} from ${intent.sourceWallet}`);
  console.log(`destination: ${intent.destination}`);
  console.log(`amount     : ${intent.amount} (6-dec base units)`);
  console.log(`burnTx     : ${fmt(intent.burnTxHash)}`);
  console.log(`mintTx     : ${fmt(intent.mintTxHash)}`);
  console.log(`actual     : ${fmt(intent.actualAmount)}  bound=${intent.destinationBound}`);
  if (intent.error) console.log(`error      : ${intent.error}`);
  console.log(`expiresAt  : ${fmt(intent.expiresAt)}`);
}

async function printStages(intentId, hasStageTable) {
  if (!hasStageTable) {
    console.log('  stages: (bridge_attempt_stages table missing — migration not deployed yet)');
    return;
  }
  const stages = await prisma.$queryRawUnsafe(
    `SELECT stage, "txHash", "chainId", "errorDetail", metadata, "createdAt"
       FROM public.bridge_attempt_stages WHERE "intentId" = $1 ORDER BY "createdAt" ASC`,
    intentId
  );
  if (!stages.length) {
    console.log('  stages: (none — no BridgeAttemptStage rows; code predates stage logging or intent is older)');
    return;
  }
  console.log(`  stages (${stages.length}):`);
  for (const s of stages) {
    const meta = s.metadata ? ` meta=${String(s.metadata).slice(0, 200)}` : '';
    console.log(
      `    [${fmt(s.createdAt)}] ${s.stage}` +
      (s.txHash ? ` tx=${s.txHash}` : '') +
      (s.chainId != null ? ` chain=${s.chainId}` : '') +
      (s.errorDetail ? ` error=${String(s.errorDetail).slice(0, 300)}` : '') +
      meta
    );
  }
}

async function main() {
  const hasStageTable = await stageTableExists().catch(() => false);
  if (!hasStageTable) {
    console.log('NOTE: bridge_attempt_stages table not present on this DB — stage rows unavailable (migration not deployed). Intent rows below still print.');
  }

  let intents = [];
  if (args.reference) {
    intents = await prisma.$queryRawUnsafe(
      `SELECT * FROM public.flow_bridge_intents WHERE id = $1`, args.reference
    );
  } else if (args.wallet) {
    const w = args.wallet.toLowerCase();
    intents = await prisma.$queryRawUnsafe(
      `SELECT * FROM public.flow_bridge_intents
        WHERE lower("sourceWallet") = $1 OR lower(destination) = $1
        ORDER BY "createdAt" DESC LIMIT $2`,
      w, Number.isFinite(args.limit) ? args.limit : 10
    );
  } else {
    const n = Number.isFinite(args.latest) ? args.latest : 5;
    intents = await prisma.$queryRawUnsafe(
      `SELECT * FROM public.flow_bridge_intents ORDER BY "createdAt" DESC LIMIT $1`, n
    );
  }

  if (!intents.length) {
    console.log('No matching bridge intents found.');
    return;
  }
  for (const intent of intents) {
    await printIntent(intent);
    await printStages(intent.id, hasStageTable);
  }
  console.log('─'.repeat(72));
  console.log(`done: ${intents.length} intent(s)`);
}

try {
  await main();
} catch (e) {
  console.error('inspect failed:', e?.message ?? e);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
