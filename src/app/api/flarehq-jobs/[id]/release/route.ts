// Provider confirmation releases the FlareHQEscrow after client approval.
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
  if (job.status === "COMPLETED") return NextResponse.json({ success: true, replayed: true, job: serializeFlareHQJob(job) });
  if (job.status !== "SUBMITTED" || !job.providerAddress || !job.escrowReference) return NextResponse.json({ success: false, error: `Job is ${job.status}, not releasable.` }, { status: 409 });
  const auth = await requireFlareHQJobActor(req, job.providerAddress);
  if (!auth) return NextResponse.json({ success: false, error: "Only the selected provider can accept release." }, { status: 403 });
  const stepUp = await requireConsumerStepUpForActor(req, auth.actor, "consumer.escrow-act");
  if (stepUp) return stepUp;
  const escrow = await (prisma as any).escrow.findUnique({ where: { reference: job.escrowReference } });
  if (!escrow?.contractEscrowId || !escrow.depositorConfirmed) return NextResponse.json({ success: false, error: "The client must approve the submission first." }, { status: 409 });
  const body = await req.json().catch(() => ({}));
  const wallet = await resolveExactJobWallet(job.providerAddress);
  if (!wallet) return NextResponse.json({ success: false, error: "Provider wallet cannot be resolved." }, { status: 409 });
  let txHash = typeof body.txHash === "string" ? body.txHash : "";
  if (wallet.mode === "EXTERNAL" && !txHash) {
    return NextResponse.json({ success: true, pendingWallet: true, transaction: externalJobTransaction({ description: `Accept release for FlareHQ Job ${job.seq}`, from: job.providerAddress, to: contractAddress, signature: "confirmDelivery(bytes32)", args: [escrow.contractEscrowId] }), message: "Broadcast this confirmation from the provider wallet, then submit its txHash here." });
  }
  if (wallet.mode === "CIRCLE") txHash = await executeCircleJobEscrowCall({ wallet, contractAddress, signature: "confirmDelivery(bytes32)", args: [escrow.contractEscrowId], label: "FlareHQ Job release" });
  else {
    const proof = await verifyExternalJobEscrowCall({ txHash, from: job.providerAddress, contractAddress });
    if (!proof.ok) return NextResponse.json({ success: false, error: proof.error }, { status: 422 });
  }
  const state = await readJobEscrowState(contractAddress, escrow.contractEscrowId);
  if (!state || !escrowStateField(state, "depositorConfirmed", 5) || !escrowStateField(state, "beneficiaryConfirmed", 6)) return NextResponse.json({ success: false, error: "Dual confirmation is not proven on-chain." }, { status: 422 });
  const updated = await (prisma as any).$transaction(async (tx: any) => {
    await tx.escrow.update({ where: { reference: job.escrowReference }, data: { status: "RELEASED", beneficiaryConfirmed: true, releaseTxHash: txHash } });
    return tx.flareHQJob.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } });
  });
  return NextResponse.json({ success: true, job: serializeFlareHQJob(updated), txHash, feeBps: 25 });
}
