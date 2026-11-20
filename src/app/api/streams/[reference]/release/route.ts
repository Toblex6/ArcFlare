import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { streamAddressOr503 } from "@/lib/stream/streamGuard";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { readStreamOnChain, readTrancheAmount } from "@/lib/contracts/streamContract";
import { executeCircleStreamCall, externalStreamTransaction, resolveExactStreamWallet } from "@/lib/stream/standaloneActions";
import { verifyStreamTransaction, formatStreamAmount } from "@/lib/stream/standalone";

export async function POST(req: NextRequest, { params }: { params: Promise<{ reference: string }> }) {
  const gate = streamAddressOr503(); if ("response" in gate) return gate.response;
  const { reference } = await params;
  const row = await (prisma as any).standaloneStream.findUnique({ where: { reference } });
  if (!row) return NextResponse.json({ success: false, error: "Stream not found." }, { status: 404 });
  const actor = await verifyCallerControlsAddress(req, row.posterAddress); if (!actor) return NextResponse.json({ success: false, error: "Only the stream poster can release a tranche." }, { status: 403 });
  const stepUp = await requireConsumerStepUpForActor(req, actor, "consumer.job-fund"); if (stepUp) return stepUp;
  if (row.status !== "ACTIVE") return NextResponse.json({ success: false, error: "Stream is closed." }, { status: 409 });
  const body = await req.json().catch(() => ({})); const index = Number(body.requirementIndex);
  if (!Number.isInteger(index) || index < 0 || index >= row.trancheCount) return NextResponse.json({ success: false, error: "requirementIndex is out of range." }, { status: 400 });
  const existing = await (prisma as any).standaloneStreamTranche.findUnique({ where: { streamReference_requirementIndex: { streamReference: reference, requirementIndex: index } } });
  if (existing) return NextResponse.json({ success: true, replayed: true, tranche: existing });
  const wallet = await resolveExactStreamWallet(row.posterAddress); if (!wallet) return NextResponse.json({ success: false, error: "Poster wallet cannot be resolved." }, { status: 409 });
  let txHash = String(body.txHash ?? "");
  if (wallet.mode === "EXTERNAL" && !txHash) return NextResponse.json({ success: true, pendingWallet: true, transaction: externalStreamTransaction({ description: `Release stream tranche ${index}`, from: row.posterAddress, to: gate.address, signature: "releaseTranche(uint256,uint256)", args: [row.streamId, String(index)] }), confirm: { endpoint: `/api/streams/${reference}/release`, body: { requirementIndex: index } } });
  if (wallet.mode === "CIRCLE") txHash = await executeCircleStreamCall({ wallet, contractAddress: gate.address, signature: "releaseTranche(uint256,uint256)", args: [row.streamId, String(index)], label: "release stream tranche" });
  else { const proof = await verifyStreamTransaction({ txHash, from: row.posterAddress, contractAddress: gate.address }); if (!proof.ok) return NextResponse.json({ success: false, error: proof.error }, { status: 422 }); }
  const state = await readStreamOnChain(BigInt(row.streamId));
  const amount = await readTrancheAmount(BigInt(row.streamId), index);
  if (Number(state.tranchesReleased) <= row.tranchesReleased || state.totalReleased < BigInt(row.totalReleased) + amount) return NextResponse.json({ success: false, error: "The tranche release is not proven on-chain." }, { status: 422 });
  const tranche = await (prisma as any).$transaction(async (tx: any) => {
    const created = await tx.standaloneStreamTranche.create({ data: { streamReference: reference, requirementIndex: index, amount: amount.toString(), txHash } });
    await tx.standaloneStream.update({ where: { reference }, data: { tranchesReleased: Number(state.tranchesReleased), totalReleased: state.totalReleased.toString() } });
    return created;
  });
  return NextResponse.json({ success: true, tranche: { ...tranche, amountUSDC: formatStreamAmount(amount) }, txHash });
}
