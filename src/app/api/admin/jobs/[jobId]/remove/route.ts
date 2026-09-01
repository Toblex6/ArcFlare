// src/app/api/admin/jobs/[jobId]/remove/route.ts
// Admin-only moderation: remove a malicious/bad ERC-8183 job.
//
// What this does:
//  - DB: marks the job removed (removedAt/removedReason), sets status to
//    REJECTED so our routes (accept/fund/[jobId]-fund) refuse further
//    transitions, and cancels any linked OPEN procurement posting so no new
//    applications/hires can happen.
//  - On-chain: best-effort `reject` signed with the job's EVALUATOR Circle
//    wallet ONLY when the on-chain job is still OPEN (nothing escrowed yet —
//    safe, no funds at stake). For FUNDED/SUBMITTED jobs the contract is
//    left alone (funds are one-way by design; no admin clawback exists).
//
// The platform controls all developer-controlled Circle wallets (same trust
// model as settlement), so it can sign the reject as the evaluator. Any
// on-chain failure is surfaced but never fails the admin op (DB removal is
// authoritative for moderation).

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveAdminSession } from '@/src/lib/middleware/withAdminAuth';
import { getCircleClient, createContractTransaction } from '@/lib/circle/client';
import { AGENTIC_COMMERCE_CONTRACT, agenticCommerceAbi } from '@/lib/contracts/erc8183';
import { createPublicClient, http, keccak256, toHex } from 'viem';
import { arcTestnet } from 'viem/chains';

const RPC_URL = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';

async function readOnChainJob(jobId: bigint): Promise<{ status: number; budget: bigint } | null> {
  try {
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });
    const job = (await publicClient.readContract({
      address: AGENTIC_COMMERCE_CONTRACT as `0x${string}`,
      abi: agenticCommerceAbi as any,
      functionName: 'getJob',
      args: [jobId],
    })) as any;
    return { status: Number(job?.status ?? 0), budget: BigInt(job?.budget ?? 0) };
  } catch {
    return null;
  }
}

async function resolveEvaluatorWalletId(evaluatorSCA: string): Promise<string | null> {
  const agent = await (prisma as any).agentRegistry.findFirst({
    where: { scaAddress: { equals: evaluatorSCA, mode: 'insensitive' } },
    select: { circleWalletId: true },
  });
  if (agent?.circleWalletId) return agent.circleWalletId;
  const consumer = await (prisma as any).consumerAccount.findFirst({
    where: { walletAddress: { equals: evaluatorSCA, mode: 'insensitive' } },
    select: { circleWalletId: true },
  });
  return consumer?.circleWalletId ?? null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const isAdmin = await resolveAdminSession(req);
  if (!isAdmin) {
    return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
  }

  const { jobId } = await params;
  let jobIdBig: bigint;
  try {
    jobIdBig = BigInt(jobId);
  } catch {
    return NextResponse.json({ success: false, error: `invalid jobId ${jobId}` }, { status: 400 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const reason = String(body.reason || '').trim() || 'removed by admin';

    const job = await (prisma as any).erc8183Job.findUnique({ where: { jobId: jobIdBig } });
    if (!job) {
      return NextResponse.json({ success: false, error: `job ${jobId} not found` }, { status: 404 });
    }

    const now = new Date();

    // Cancel any linked OPEN procurement posting (no new applies/hires).
    const linkedPosting = await (prisma as any).procurementPosting.findFirst({
      where: { resultingJobId: jobIdBig },
    });
    if (linkedPosting && linkedPosting.status === 'OPEN') {
      await (prisma as any).procurementPosting.update({
        where: { id: linkedPosting.id },
        data: { status: 'CANCELLED' },
      });
    }

    // DB removal (authoritative for moderation).
    await (prisma as any).erc8183Job.update({
      where: { jobId: jobIdBig },
      data: { status: 'REJECTED', removedAt: now, removedReason: reason },
    });

    // Best-effort on-chain reject — only when the on-chain job is still OPEN
    // (nothing escrowed; safe). Signed with the evaluator's Circle wallet.
    let onChain: { attempted: boolean; txHash?: string; note?: string } = { attempted: false };
    try {
      const onChainJob = await readOnChainJob(jobIdBig);
      if (onChainJob && onChainJob.status === 0) {
        const evaluatorWalletId = await resolveEvaluatorWalletId(job.evaluatorSCA || job.clientSCA);
        if (evaluatorWalletId) {
          const circleClient = getCircleClient();
          const w = await circleClient.getWallet({ id: evaluatorWalletId });
          const evaluatorAddress = w.data?.wallet?.address as string;
          const reasonHash = keccak256(toHex(reason)) as `0x${string}`;
          const txHash = await createContractTransaction(
            evaluatorAddress,
            AGENTIC_COMMERCE_CONTRACT,
            'reject(uint256,bytes32,bytes)',
            [jobId, reasonHash, '0x'],
            'admin reject job'
          );
          onChain = { attempted: true, txHash };
        } else {
          onChain = { attempted: true, note: 'evaluator wallet not resolvable — DB removal only' };
        }
      } else if (onChainJob && onChainJob.status !== 0) {
        onChain = {
          attempted: true,
          note: `on-chain status ${onChainJob.status} — funds are escrow-locked (one-way); left untouched`,
        };
      } else {
        onChain = { attempted: true, note: 'on-chain job read failed — DB removal only' };
      }
    } catch (e: any) {
      onChain = { attempted: true, note: `on-chain reject failed (DB removal still applied): ${e?.message ?? e}` };
    }

    return NextResponse.json({
      success: true,
      jobId,
      removed: true,
      status: 'REJECTED',
      removedReason: reason,
      linkedPosting: linkedPosting ? { id: linkedPosting.id, status: 'CANCELLED' } : null,
      onChain,
    });
  } catch (error: any) {
    console.error('Admin job remove error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
