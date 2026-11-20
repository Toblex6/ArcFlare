import { NextRequest, NextResponse } from "next/server";
import { decodeEventLog } from "viem";
import { prisma } from "@/lib/prisma";
import { escrowAddressOr503 } from "@/lib/escrow/escrowGuard";
import { requireFlareHQJobActor } from "@/lib/jobs/flarehqJobAuth";
import { flareHQJobEscrowId, flareHQJobEscrowReference, formatJobUnits, serializeFlareHQJob } from "@/lib/jobs/flarehqJob";
import { readJobEscrowState, verifyExternalJobEscrowCall } from "@/lib/jobs/flarehqEscrowActions";
import { escrowEvents } from "@/lib/wallet/flarehqContracts";
import { getReceiptReliable } from "@/lib/wallet/chainClient";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = escrowAddressOr503();
  if ("response" in guard) return guard.response;
  const contractAddress = guard.address;
  const { id } = await params;
  const job = await (prisma as any).flareHQJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ success: false, error: "FlareHQ Job not found." }, { status: 404 });
  const auth = await requireFlareHQJobActor(req, job.clientAddress);
  if (!auth) return NextResponse.json({ success: false, error: "Only the job client can confirm funding." }, { status: 403 });
  if (job.status === "FUNDED") return NextResponse.json({ success: true, replayed: true, job: serializeFlareHQJob(job) });
  if (job.status !== "SELECTED" || !job.providerAddress) return NextResponse.json({ success: false, error: "Job is not ready to fund." }, { status: 409 });
  const body = await req.json().catch(() => ({}));
  const txHash = String(body.txHash ?? "");
  const receiptCheck = await verifyExternalJobEscrowCall({ txHash, from: job.clientAddress, contractAddress });
  if (!receiptCheck.ok) return NextResponse.json({ success: false, error: receiptCheck.error }, { status: 422 });
  const receipt = await getReceiptReliable(txHash);
  const escrowId = flareHQJobEscrowId(job.id);
  let event: any = null;
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    try {
      const parsed: any = decodeEventLog({ abi: [escrowEvents.EscrowCreated] as any, data: log.data, topics: log.topics });
      if (parsed.eventName === "EscrowCreated") { event = parsed.args; break; }
    } catch {}
  }
  if (!event || String(event.escrowId).toLowerCase() !== escrowId.toLowerCase() ||
      String(event.depositor).toLowerCase() !== job.clientAddress.toLowerCase() ||
      String(event.beneficiary).toLowerCase() !== job.providerAddress.toLowerCase() ||
      BigInt(event.amount) !== BigInt(job.budget)) {
    return NextResponse.json({ success: false, error: "The transaction did not create this job's exact escrow." }, { status: 422 });
  }
  const state = await readJobEscrowState(contractAddress, escrowId);
  if (!state) return NextResponse.json({ success: false, error: "Could not read the funded escrow state." }, { status: 503 });
  const reference = flareHQJobEscrowReference(job.id);
  const deadline = Number(event.deadline);
  const updated = await (prisma as any).$transaction(async (tx: any) => {
    await tx.escrow.create({
      data: {
        reference,
        amount: Number(BigInt(job.budget)) / 1_000_000,
        currency: "USDC",
        depositorSCA: job.clientAddress,
        beneficiarySCA: job.providerAddress,
        beneficiaryKind: job.providerActorType ?? "external",
        contractAddress,
        contractEscrowId: escrowId,
        status: "ACTIVE",
        condition: String(event.reference),
        deadline: new Date(deadline * 1000),
        txHash,
      },
    });
    const claim = await tx.flareHQJob.updateMany({ where: { id: job.id, status: "SELECTED" }, data: { status: "FUNDED", escrowReference: reference } });
    if (claim.count !== 1) throw new Error("JOB_FUND_STATE_CONFLICT");
    return tx.flareHQJob.findUnique({ where: { id: job.id } });
  });
  return NextResponse.json({ success: true, job: serializeFlareHQJob(updated), amountUSDC: formatJobUnits(BigInt(job.budget)), txHash });
}
