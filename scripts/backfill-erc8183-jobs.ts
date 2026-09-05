// scripts/backfill-erc8183-jobs.ts
// ─────────────────────────────────────────────────────────────────────────────
// Standalone, idempotent backfill for PRE-TRACK-3 Direct-Hire jobs that exist
// on-chain but lack a canonical `Erc8183Job` database record.
//
// DISCOVERY: pre-Track-3 Direct-Hire created a legacy `Job` mirror whose
// `id` = `erc8183_<onChainJobId>`. We discover those rows, verify the on-chain
// ERC-8183 job exists, read authoritative on-chain state, cross-check it
// against the legacy DB, and create the missing Erc8183Job ONLY when every
// required field is provable. Ambiguous / mismatched / missing-on-chain
// records are skipped and reported — never guessed.
//
// HARD RULES:
//   * DRY-RUN BY DEFAULT. Pass `--apply` to actually create rows.
//   * Never overwrites an existing Erc8183Job (findUnique first).
//   * Never modifies historical on-chain state.
//   * Never runs destructive cleanup.
//   * Safe to re-run (idempotent; unique jobId prevents duplicates).
//
// USAGE:
//   npx tsx scripts/backfill-erc8183-jobs.ts            # dry-run (report only)
//   npx tsx scripts/backfill-erc8183-jobs.ts --apply    # actually backfill
//   npx tsx scripts/backfill-erc8183-jobs.ts --scan-orphans  # also sweep chain
//   npx tsx scripts/backfill-erc8183-jobs.ts --legacyIds=erc8183_1,erc8183_2 [--apply]
//
// Requires .env.local with DATABASE_URL (+ ARC_TESTNET_RPC optional).
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { createPublicClient, http } from 'viem';
import { prisma } from '@/lib/prisma';
import { AGENTIC_COMMERCE_CONTRACT, agenticCommerceAbi } from '@/lib/contracts/erc8183';
import {
  type OnChainJob,
  type OnChainResult,
  type Erc8183JobCreateData,
  parseLegacyJobId,
  runBackfill,
  formatReport,
} from './erc8183JobBackfill';
import type { Prisma } from '@prisma/client';

const CHAIN = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
} as const;

// Same primary-then-alternates order as src/lib/wallet/chainClient.ts so reads
// survive the known-flaky Arc RPC cluster.
function candidateRpcUrls(): string[] {
  const urls = new Set<string>();
  const primary = process.env.ARC_TESTNET_RPC?.trim();
  if (primary) urls.add(primary);
  const fallbacks = (process.env.ARC_TESTNET_RPC_FALLBACKS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of fallbacks) urls.add(f);
  for (const alt of [
    'https://rpc.drpc.testnet.arc.io',
    'https://rpc.quicknode.testnet.arc.io',
    'https://rpc.testnet.arc.io',
    'https://rpc.blockdaemon.testnet.arc.io',
  ]) {
    urls.add(alt);
  }
  return [...urls];
}

const ZERO_ADDR = '0x' + '0'.repeat(40);
function normalizeAddr(s: string): string {
  return (s || '').trim().toLowerCase();
}

function normalizeOnChainJob(raw: any): OnChainJob | null {
  if (!raw) return null;
  const id = typeof raw.id === 'bigint' ? raw.id : BigInt(raw.id ?? 0);
  const client = String(raw.client || '');
  if (id <= 0n || normalizeAddr(client) === ZERO_ADDR) return null; // zeroed/absent slot
  return {
    id,
    client,
    provider: String(raw.provider || ''),
    evaluator: String(raw.evaluator || ''),
    description: String(raw.description || ''),
    budget: typeof raw.budget === 'bigint' ? raw.budget : BigInt(raw.budget ?? 0),
    expiredAt: typeof raw.expiredAt === 'bigint' ? raw.expiredAt : BigInt(raw.expiredAt ?? 0),
    status: typeof raw.status === 'bigint' ? Number(raw.status) : Number(raw.status ?? -1),
    hook: String(raw.hook || ''),
  };
}

// Read authoritative on-chain getJob for an id, distinguishing a definite
// "job does not exist" (revert/zeroed slot) from "all RPCs transiently failed".
async function readOnChainJob(jobId: bigint): Promise<OnChainResult> {
  let sawRevert = false;
  for (const url of candidateRpcUrls()) {
    const client = createPublicClient({ chain: CHAIN, transport: http(url, { timeout: 10_000 }) });
    try {
      const res: any = await client.readContract({
        address: AGENTIC_COMMERCE_CONTRACT as `0x${string}`,
        abi: agenticCommerceAbi as any,
        functionName: 'getJob',
        args: [jobId],
      });
      const job = normalizeOnChainJob(res);
      if (job) return { kind: 'exists', job };
      sawRevert = true; // matched a zeroed/absent slot on a node that answered
    } catch (e: any) {
      const msg = String(e?.shortMessage || e?.message || e || '');
      if (/revert|execution/i.test(msg)) {
        sawRevert = true; // node confirmed the job does not exist
      }
      // transient RPC error → try the next candidate; do not assume missing
    }
  }
  if (sawRevert) return { kind: 'missing' };
  return { kind: 'error', error: 'getJob failed on all candidate Arc testnet RPCs' };
}
async function readJobCounter(): Promise<bigint> {
  for (const url of candidateRpcUrls()) {
    const client = createPublicClient({ chain: CHAIN, transport: http(url, { timeout: 10_000 }) });
    try {
      return (await client.readContract({
        address: AGENTIC_COMMERCE_CONTRACT as `0x${string}`,
        abi: agenticCommerceAbi as any,
        functionName: 'jobCounter',
        args: [],
      })) as bigint;
    } catch {
      // try next RPC
    }
  }
  throw new Error('jobCounter() failed on all candidate Arc testnet RPCs');
}

function parseArgs(argv: string[]): { apply: boolean; scanOrphans: boolean; legacyIds: bigint[] | null } {
  const apply = argv.includes('--apply');
  const scanOrphans = argv.includes('--scan-orphans');
  let legacyIds: bigint[] | null = null;
  const idsArg = argv.find((a) => a.startsWith('--legacyIds='));
  if (idsArg) {
    legacyIds = idsArg
      .slice('--legacyIds='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseLegacyJobId(s))
      .filter((v): v is bigint => v !== null);
  }
  return { apply, scanOrphans, legacyIds };
}

async function main() {
  const { apply, scanOrphans, legacyIds } = parseArgs(process.argv.slice(2));
  const dryRun = !apply;

  // 1-2. Discover candidate historical Direct-Hire jobs (legacy `erc8183_*` mirrors).
  const legacyRows = (await prisma.job.findMany({ orderBy: { createdAt: 'asc' } })) as any[];
  const candidates = legacyRows
    .filter((r) => /^erc8183_\d+$/.test(String(r.id || '')))
    .filter((r) => !legacyIds || legacyIds.includes(parseLegacyJobId(String(r.id))!))
    .map((r) => ({
      id: String(r.id),
      description: String(r.description ?? ''),
      amount: Number(r.amount ?? 0),
      status: String(r.status ?? ''),
      agentId: String(r.agentId ?? ''),
      merchantId: r.merchantId ? String(r.merchantId) : null,
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(),
    }));

  const persist = apply
    ? async (payload: Erc8183JobCreateData) => {
        await (prisma as any).erc8183Job.create({ data: payload as Prisma.Erc8183JobCreateInput });
      }
    : undefined;

  const report = await runBackfill({
    candidates,
    existing: async (jobId) => {
      const found = await (prisma as any).erc8183Job.findUnique({ where: { jobId }, select: { jobId: true } });
      return Boolean(found);
    },
    chainRead: readOnChainJob,
    persist,
    dryRun,
  });

  console.log(formatReport(report, dryRun));

  // Optional supplementary sweep: any on-chain jobId with no Erc8183Job and no
  // legacy mirror is an orphan. Reported for awareness; NOT backfilled unless a
  // legacy linkage exists (prevents guessing provenance). Never auto-created.
  if (scanOrphans) {
    const existingIds = new Set<string>(
      (await (prisma as any).erc8183Job.findMany({ select: { jobId: true } })).map((x: any) => x.jobId.toString())
    );
    const legacyIdsSet = new Set(candidates.map((c) => parseLegacyJobId(c.id)!.toString()));
    const counter = await readJobCounter();
    let orphanCount = 0;
    for (let i = 1n; i <= counter; i++) {
      if (existingIds.has(i.toString()) || legacyIdsSet.has(i.toString())) continue;
      const res = await readOnChainJob(i);
      if (res.kind === 'exists') {
        orphanCount++;
        console.log(`  [orphan-on-chain] jobId=${i} (no Erc8183Job, no legacy mirror) — manual review`);
      }
    }
    console.log(`  orphan-on-chain jobs without any DB record: ${orphanCount} (reported only, not backfilled)`);
  }

  // Exit non-zero when anomalies exist (outside dry-run) so operators notice
  // mismatches / missing jobs that need review. Dry-run always exits 0.
  const anomalies = report.mismatch.length + report.skipped.filter((s) => s.reason !== 'already-backfilled').length;
  process.exit(anomalies > 0 && !dryRun ? 1 : 0);
}

main().catch((e) => {
  console.error('backfill aborted:', e?.message ?? e);
  process.exit(2);
});