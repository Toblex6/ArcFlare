// scripts/recover-bridge-intent.ts
//
// Operator recovery for a stuck EXTERNAL bridge intent (e.g. client vanished
// after submitting the source burn, so verify/complete were never POSTed).
// Replays EXACTLY the endpoint logic with the same verifiers and the same
// conditional claims — read-only by default, writes only with --execute:
//
//   npx tsx scripts/recover-bridge-intent.ts --reference <intentId> \
//     --burn 0x... --mint 0x... [--execute]
//
// Dry-run runs both on-chain verifications and prints the transitions it
// WOULD apply. --execute applies them (BURN_PENDING/BURN_CONFIRMED/
// MINT_PENDING/MINT_CONFIRMED/VERIFIED stage rows + conditional status
// claims). Idempotent: re-running after COMPLETED with the same hashes is a
// no-op. Expiry does not block recovery: a burn that proves on-chain
// advances as lateRecovery (same rule as the verify route).
//
// Env: DATABASE_URL (production). Never prints secrets.

import fs from 'node:fs';
import { prisma } from '@/src/lib/prisma';
import { getBridgeSourceChain } from '@/lib/bridge/sourceChains';
import { verifyExternalBurn, verifyArcMint } from '@/lib/bridge/externalVerify';
import { logBridgeStage } from '@/lib/bridge/stageLogger';

function loadEnvLocal() {
  try {
    const raw = fs.readFileSync('.env.local', 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, k, v] = m;
      if (process.env[k] === undefined) process.env[k] = v.replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env.local — fine */
  }
}
loadEnvLocal();

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const reference = arg('--reference');
const burnTxHash = arg('--burn');
const mintTxHash = arg('--mint');
const execute = process.argv.includes('--execute');
const HEX64 = /^0x[0-9a-fA-F]{64}$/;

if (!reference || !burnTxHash || !HEX64.test(burnTxHash) || !mintTxHash || !HEX64.test(mintTxHash)) {
  console.log('Usage: npx tsx scripts/recover-bridge-intent.ts --reference <intentId> --burn 0x... --mint 0x... [--execute]');
  process.exit(1);
}

async function main() {
  const intent = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: reference } });
  if (!intent) {
    console.log('No intent found for reference.');
    return;
  }
  const source = getBridgeSourceChain(intent.sourceChain);
  console.log(`intent : ${intent.id}`);
  console.log(`status : ${intent.status}  expired=${new Date(intent.expiresAt).getTime() < Date.now()}`);
  console.log(`source : ${intent.sourceChain} from ${intent.sourceWallet}`);
  console.log(`dest   : ${intent.destination}`);
  console.log(`amount : ${intent.amount}`);
  console.log(`burnTx : ${intent.burnTxHash ?? '—'}  mintTx : ${intent.mintTxHash ?? '—'}`);
  console.log(`mode   : ${execute ? 'EXECUTE (will write)' : 'DRY-RUN (read-only)'}`);

  if (intent.status === 'COMPLETED') {
    const sameBurn = (intent.burnTxHash ?? '').toLowerCase() === burnTxHash!.toLowerCase();
    const sameMint = (intent.mintTxHash ?? '').toLowerCase() === mintTxHash!.toLowerCase();
    console.log(sameBurn && sameMint ? 'Already COMPLETED with these hashes — no-op.' : 'Already COMPLETED with DIFFERENT hashes — refusing to touch.');
    return;
  }
  if (intent.status === 'FAILED') {
    console.log(`Refusing: intent is FAILED (${intent.error ?? 'no detail'}). Clear it manually if recovery is truly warranted.`);
    return;
  }

  // ── Step 1: prove the burn (same call the verify route makes) ──
  const burn = await verifyExternalBurn({
    sourceId: intent.sourceChain,
    sourceAddress: intent.sourceWallet,
    amountBaseUnits: BigInt(intent.amount),
    destination: intent.destination,
    burnTxHash: burnTxHash!,
  });
  console.log('burn verify:', burn.ok ? `OK destinationBound=${burn.destinationBound}` : `FAIL ${burn.reason} — ${burn.detail ?? ''}`);
  if (!burn.ok) return;

  if (intent.status === 'PENDING') {
    if (!execute) {
      console.log(`WOULD claim PENDING → BURN_CONFIRMED (burnTxHash=${burnTxHash}) + log BURN_PENDING/BURN_CONFIRMED.`);
    } else {
      await logBridgeStage(intent.id, {
        stage: 'BURN_PENDING',
        txHash: burnTxHash!,
        chainId: source?.chainId,
        metadata: { sourceChain: intent.sourceChain, sourceAddress: intent.sourceWallet, recovery: true },
      });
      const claim = await (prisma as any).flowBridgeIntent.updateMany({
        where: { id: intent.id, status: 'PENDING' },
        data: { status: 'BURN_CONFIRMED', burnTxHash, destinationBound: burn.destinationBound },
      });
      if (claim.count === 0) {
        console.log('PENDING claim lost a race (state changed) — re-run to reassess.');
        return;
      }
      await logBridgeStage(intent.id, {
        stage: 'BURN_CONFIRMED',
        txHash: burnTxHash!,
        chainId: source?.chainId,
        metadata: { destinationBound: burn.destinationBound, recovery: true, lateRecovery: new Date(intent.expiresAt).getTime() < Date.now() },
      });
      console.log('Claimed PENDING → BURN_CONFIRMED.');
    }
  } else {
    console.log(`Status is ${intent.status} — burn already bound, skipping to mint.`);
  }

  // ── Step 2: prove the mint (same call the complete route makes) ──
  const mint = await verifyArcMint({ destination: intent.destination, mintTxHash: mintTxHash! });
  console.log('mint verify:', mint.ok ? `OK actualAmount=${mint.actualAmount.toString()}` : `FAIL ${mint.reason} — ${mint.detail ?? ''}`);
  if (!mint.ok) return;

  if (!execute) {
    console.log(`WOULD claim BURN_CONFIRMED → COMPLETED (mintTxHash=${mintTxHash}, actualAmount=${mint.actualAmount.toString()}) + log MINT_PENDING/MINT_CONFIRMED/VERIFIED.`);
    return;
  }
  const { getNetworkConfig } = await import('@/lib/config/network');
  await logBridgeStage(intent.id, {
    stage: 'MINT_PENDING',
    txHash: mintTxHash!,
    chainId: getNetworkConfig().chainId,
    metadata: { destination: intent.destination, recovery: true },
  });
  const claim2 = await (prisma as any).flowBridgeIntent.updateMany({
    where: { id: intent.id, status: 'BURN_CONFIRMED' },
    data: { status: 'COMPLETED', mintTxHash, actualAmount: mint.actualAmount.toString() },
  });
  if (claim2.count === 0) {
    const reread = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: intent.id } });
    console.log(`COMPLETED claim applied to 0 rows (current status: ${reread?.status}) — reassess before retrying.`);
    return;
  }
  await logBridgeStage(intent.id, {
    stage: 'MINT_CONFIRMED',
    txHash: mintTxHash!,
    chainId: getNetworkConfig().chainId,
    metadata: { actualAmount: mint.actualAmount.toString(), recovery: true },
  });
  await logBridgeStage(intent.id, { stage: 'VERIFIED', txHash: mintTxHash!, chainId: getNetworkConfig().chainId });
  console.log(`Claimed BURN_CONFIRMED → COMPLETED (actual ${mint.actualAmount.toString()} base units).`);
}

try {
  await main();
} catch (e: any) {
  console.error('recover failed:', e?.message ?? e);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
