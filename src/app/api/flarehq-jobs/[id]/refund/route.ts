import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { escrowAddressOr503 } from "@/lib/escrow/escrowGuard";
import { requireFlareHQJobActor } from "@/lib/jobs/flarehqJobAuth";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { executeCircleJobEscrowCall, externalJobTransaction, resolveExactJobWallet, verifyExternalJobEscrowCall } from "@/lib/jobs/flarehqEscrowActions";
import { serializeFlareHQJob } from "@/lib/jobs/flarehqJob";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;
  const contractAddress = guard.address;
  const { id } = await params;
  const job = await (prisma as any).flareHQJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ success: false, error: "FlareHQ Job not found." }, { status: 404 });
  const auth = await requireFlareHQJobActor(req, job.clientAddress);
  if (!auth) return NextResponse.json({ success: false, error: "Only the job client can refund an expired job." }, { status: 403 });
  const stepUp = await requireConsumerStepUpForActor(req, auth.actor, "consumer.escrow-act");
  if (stepUp) return stepUp;
  if (!["FUNDED", "SUBMITTED"].includes(job.status) || !job.escrowReference) return NextResponse.json({ success: false, error: `Job is ${job.status}, not refundable.` }, { status: 409 });
  const escrow = await (prisma as any).escrow.findUnique({ where: { reference: job.escrowReference } });
  if (!escrow?.contractEscrowId || !escrow.deadline) return NextResponse.json({ success: false, error: "Job escrow is missing." }, { status: 409 });
  if (escrow.status === "DISPUTED") return NextResponse.json({ success: false, error: "A disputed job must be resolved by the arbiter." }, { status: 409 });
  if (escrow.deadline.getTime() > Date.now()) return NextResponse.json({ success: false, error: "The job escrow has not expired." }, { status: 409 });
  const body = await req.json().catch(() => ({}));
  const wallet = await resolveExactJobWallet(job.clientAddress);
  if (!wallet) return NextResponse.json({ success: false, error: "Client wallet cannot be resolved." }, { status: 409 });
  let txHash = typeof body.txHash === "string" ? body.txHash : "";
  if (wallet.mode === "EXTERNAL" && !txHash) return NextResponse.json({ success: true, pendingWallet: true, transaction: externalJobTransaction({ description: `Refund expired FlareHQ Job ${job.seq}`, from: job.clientAddress, to: contractAddress, signature: "refundExpired(bytes32)", args: [escrow.contractEscrowId] }), message: "Broadcast this refund from the client wallet, then submit its txHash here." });
  if (wallet.mode === "CIRCLE") txHash = await executeCircleJobEscrowCall({ wallet, contractAddress, signature: "refundExpired(bytes32)", args: [escrow.contractEscrowId], label: "FlareHQ Job refund" });
  else {
    const proof = await verifyExternalJobEscrowCall({ txHash, from: job.clientAddress, contractAddress });
    if (!proof.ok) return NextResponse.json({ success: false, error: proof.error }, { status: 422 });
  }
  const updated = await (prisma as any).$transaction(async (tx: any) => {
    await tx.escrow.update({ where: { reference: job.escrowReference }, data: { status: "REFUNDED", releaseTxHash: txHash } });
    return tx.flareHQJob.update({ where: { id }, data: { status: "REFUNDED" } });
  });
  return NextResponse.json({ success: true, job: serializeFlareHQJob(updated), txHash });
}
