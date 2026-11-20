// Fund a selected FlareHQ Job into FlareHQEscrow. This is NOT ERC-8183.
// Circle wallets execute approve + createEscrow. External wallets receive
// exact unsigned calls and then submit the mined createEscrow hash for the
// same receipt/state verifier used by public escrow links.

import { NextRequest, NextResponse } from "next/server";
import { parseUnits } from "viem";
import { prisma } from "@/lib/prisma";
import { escrowAddressOr503 } from "@/lib/escrow/escrowGuard";
import { checkEscrowAmount } from "@/lib/escrow/escrowAmount";
import { requireFlareHQJobActor } from "@/lib/jobs/flarehqJobAuth";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { flareHQJobEscrowId, flareHQJobEscrowReference, formatJobUnits, serializeFlareHQJob } from "@/lib/jobs/flarehqJob";
import { executeCircleJobEscrowCall, externalJobTransaction, resolveExactJobWallet } from "@/lib/jobs/flarehqEscrowActions";
import { getNetworkConfig } from "@/lib/config/network";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;
  const contractAddress = guard.address;
  const { id } = await params;
  const job = await (prisma as any).flareHQJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ success: false, error: "FlareHQ Job not found." }, { status: 404 });
  const auth = await requireFlareHQJobActor(req, job.clientAddress);
  if (!auth) return NextResponse.json({ success: false, error: "Only the job client can fund it." }, { status: 403 });
  const stepUp = await requireConsumerStepUpForActor(req, auth.actor, "consumer.job-fund");
  if (stepUp) return stepUp;
  if (job.status === "FUNDED" || job.status === "SUBMITTED") return NextResponse.json({ success: true, replayed: true, job: serializeFlareHQJob(job) });
  if (job.status !== "SELECTED" || !job.providerAddress) {
    return NextResponse.json({ success: false, error: "Select an application before funding." }, { status: 409 });
  }

  const wallet = await resolveExactJobWallet(job.clientAddress);
  if (!wallet) return NextResponse.json({ success: false, error: "The job client wallet cannot be resolved." }, { status: 409 });
  const body = await req.json().catch(() => ({}));
  const reference = flareHQJobEscrowReference(job.id);
  const escrowId = flareHQJobEscrowId(job.id);
  const amount = BigInt(job.budget);
  const checked = checkEscrowAmount(amount);
  if ("error" in checked) return NextResponse.json({ success: false, error: checked.error }, { status: checked.status });
  const deadlineHours = Number(body.deadlineHours ?? 24 * 7);
  if (!Number.isFinite(deadlineHours) || deadlineHours <= 0 || deadlineHours > 24 * 3650) {
    return NextResponse.json({ success: false, error: "deadlineHours must be between 0 and 87,600." }, { status: 400 });
  }
  const deadline = Math.floor(Date.now() / 1000 + deadlineHours * 3600);
  const condition = `FlareHQ Job ${job.seq}: ${job.description}`.slice(0, 2000);

  if (wallet.mode === "EXTERNAL") {
    // The browser must submit approve first, then createEscrow. The server
    // derives every field and never claims funds moved before receipt proof.
    return NextResponse.json({
      success: true,
      pendingWallet: true,
      product: "FlareHQ Jobs",
      protocol: "FlareHQEscrow",
      escrowReference: reference,
      escrowId,
      deadline,
      transactions: [
        externalJobTransaction({
          description: `Approve ${formatJobUnits(amount)} USDC for FlareHQ Job ${job.seq}`,
          from: job.clientAddress,
          to: getNetworkConfig().usdcAddress,
          signature: "approve(address,uint256)",
          args: [contractAddress, amount.toString()],
        }),
        externalJobTransaction({
          description: `Fund FlareHQ Job ${job.seq}`,
          from: job.clientAddress,
          to: contractAddress,
          signature: "createEscrow(bytes32,address,uint256,uint256,string)",
          args: [escrowId, job.providerAddress, amount.toString(), String(deadline), condition],
        }),
      ],
      confirm: { endpoint: `/api/flarehq-jobs/${job.id}/fund/confirm`, body: { txHash: "<createEscrow tx hash>" } },
      message: "Approve USDC, then fund the job from your wallet. The job becomes FUNDED only after FlareHQ verifies the createEscrow transaction on-chain.",
    });
  }

  await executeCircleJobEscrowCall({
    wallet,
    contractAddress: getNetworkConfig().usdcAddress,
    signature: "approve(address,uint256)",
    args: [contractAddress, amount.toString()],
    label: "FlareHQ Job USDC approval",
  });
  const txHash = await executeCircleJobEscrowCall({
    wallet,
    contractAddress,
    signature: "createEscrow(bytes32,address,uint256,uint256,string)",
    args: [escrowId, job.providerAddress, amount.toString(), String(deadline), condition],
    label: "FlareHQ Job funding",
  });

  try {
    const updated = await (prisma as any).$transaction(async (tx: any) => {
      const escrow = await tx.escrow.create({
        data: {
          reference,
          amount: Number(parseUnits(formatJobUnits(amount), 6)) / 1_000_000,
          currency: "USDC",
          depositorSCA: job.clientAddress,
          beneficiarySCA: job.providerAddress,
          beneficiaryKind: job.providerActorType ?? "external",
          contractAddress,
          contractEscrowId: escrowId,
          status: "ACTIVE",
          condition,
          deadline: new Date(deadline * 1000),
          txHash,
        },
      });
      const claim = await tx.flareHQJob.updateMany({
        where: { id: job.id, status: "SELECTED", escrowReference: null },
        data: { status: "FUNDED", escrowReference: reference },
      });
      if (claim.count !== 1) throw new Error("JOB_FUND_STATE_CONFLICT");
      const next = await tx.flareHQJob.findUnique({ where: { id: job.id } });
      return { job: next, escrow };
    });
    return NextResponse.json({ success: true, job: serializeFlareHQJob(updated.job), escrow: updated.escrow, txHash });
  } catch (e: any) {
    // On-chain funds may already be locked. Never retry another createEscrow;
    // owner can recover by its deterministic reference/id and receipt.
    return NextResponse.json({ success: false, code: "FUND_PERSIST_RECOVERY_REQUIRED", error: "The escrow transaction completed but the job mirror could not be updated. Recover this deterministic escrow; do not fund again.", txHash, escrowReference: reference, escrowId }, { status: 500 });
  }
}
