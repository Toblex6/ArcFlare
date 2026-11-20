// Client approval is the first escrow confirmation. Provider acceptance is
// the second, which releases net amount + 25 bps treasury fee on-chain.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { escrowAddressOr503 } from "@/lib/escrow/escrowGuard";
import { requireFlareHQJobActor } from "@/lib/jobs/flarehqJobAuth";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { executeCircleJobEscrowCall, escrowStateField, externalJobTransaction, readJobEscrowState, resolveExactJobWallet, verifyExternalJobEscrowCall } from "@/lib/jobs/flarehqEscrowActions";
import { serializeFlareHQJob } from "@/lib/jobs/flarehqJob";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;
  const contractAddress = guard.address;
  const { id } = await params;
  const job = await (prisma as any).flareHQJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ success: false, error: "FlareHQ Job not found." }, { status: 404 });
  const auth = await requireFlareHQJobActor(req, job.clientAddress);
  if (!auth) return NextResponse.json({ success: false, error: "Only the job client can approve delivery." }, { status: 403 });
  const stepUp = await requireConsumerStepUpForActor(req, auth.actor, "consumer.escrow-act");
  if (stepUp) return stepUp;
  if (job.status !== "SUBMITTED" || !job.escrowReference) return NextResponse.json({ success: false, error: `Job is ${job.status}, not SUBMITTED.` }, { status: 409 });
  const escrow = await (prisma as any).escrow.findUnique({ where: { reference: job.escrowReference } });
  if (!escrow?.contractEscrowId) return NextResponse.json({ success: false, error: "Job escrow is missing." }, { status: 409 });
  const body = await req.json().catch(() => ({}));
  const wallet = await resolveExactJobWallet(job.clientAddress);
  if (!wallet) return NextResponse.json({ success: false, error: "Client wallet cannot be resolved." }, { status: 409 });
  let txHash = typeof body.txHash === "string" ? body.txHash : "";
  if (wallet.mode === "EXTERNAL" && !txHash) {
    return NextResponse.json({
      success: true,
      pendingWallet: true,
      transaction: externalJobTransaction({ description: `Approve delivery for FlareHQ Job ${job.seq}`, from: job.clientAddress, to: contractAddress, signature: "confirmDelivery(bytes32)", args: [escrow.contractEscrowId] }),
      message: "Broadcast this approval from the client wallet, then submit its txHash to this endpoint.",
    });
  }
  if (wallet.mode === "CIRCLE") {
    txHash = await executeCircleJobEscrowCall({ wallet, contractAddress, signature: "confirmDelivery(bytes32)", args: [escrow.contractEscrowId], label: "FlareHQ Job client approval" });
  } else {
    const proof = await verifyExternalJobEscrowCall({ txHash, from: job.clientAddress, contractAddress });
    if (!proof.ok) return NextResponse.json({ success: false, error: proof.error }, { status: 422 });
  }
  const state = await readJobEscrowState(contractAddress, escrow.contractEscrowId);
  if (!state || !escrowStateField(state, "depositorConfirmed", 5)) return NextResponse.json({ success: false, error: "Client approval is not confirmed on-chain." }, { status: 422 });
  await (prisma as any).escrow.update({ where: { reference: job.escrowReference }, data: { depositorConfirmed: true } });
  return NextResponse.json({ success: true, job: serializeFlareHQJob(job), approved: true, txHash, next: `/api/flarehq-jobs/${job.id}/release` });
}
