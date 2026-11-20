import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { streamAddressOr503 } from "@/lib/stream/streamGuard";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { readStreamOnChain } from "@/lib/contracts/streamContract";
import { executeCircleStreamCall, externalStreamTransaction, resolveExactStreamWallet } from "@/lib/stream/standaloneActions";
import { verifyStreamTransaction, formatStreamAmount } from "@/lib/stream/standalone";

export async function POST(req: NextRequest, { params }: { params: Promise<{ reference: string }> }) {
  const gate = streamAddressOr503(); if ("response" in gate) return gate.response;
  const { reference } = await params;
  const row = await (prisma as any).standaloneStream.findUnique({ where: { reference } });
  if (!row) return NextResponse.json({ success: false, error: "Stream not found." }, { status: 404 });
  const actor = await verifyCallerControlsAddress(req, row.posterAddress); if (!actor) return NextResponse.json({ success: false, error: "Only the poster can close the stream." }, { status: 403 });
  const stepUp = await requireConsumerStepUpForActor(req, actor, "consumer.job-fund"); if (stepUp) return stepUp;
  if (row.status === "CLOSED") return NextResponse.json({ success: true, replayed: true, stream: row });
  const body = await req.json().catch(() => ({})); const wallet = await resolveExactStreamWallet(row.posterAddress); if (!wallet) return NextResponse.json({ success: false, error: "Poster wallet cannot be resolved." }, { status: 409 });
  let txHash = String(body.txHash ?? "");
  if (wallet.mode === "EXTERNAL" && !txHash) return NextResponse.json({ success: true, pendingWallet: true, transaction: externalStreamTransaction({ description: "Close stream and pay all remaining funds to the worker", from: row.posterAddress, to: gate.address, signature: "closeStream(uint256)", args: [row.streamId] }), confirm: { endpoint: `/api/streams/${reference}/close`, body: {} }, warning: "Closing pays the entire remaining budget to the worker. It is not a refund." });
  if (wallet.mode === "CIRCLE") txHash = await executeCircleStreamCall({ wallet, contractAddress: gate.address, signature: "closeStream(uint256)", args: [row.streamId], label: "close stream" });
  else { const proof = await verifyStreamTransaction({ txHash, from: row.posterAddress, contractAddress: gate.address }); if (!proof.ok) return NextResponse.json({ success: false, error: proof.error }, { status: 422 }); }
  const state = await readStreamOnChain(BigInt(row.streamId));
  if (!state.closed || state.totalReleased !== state.totalBudget) return NextResponse.json({ success: false, error: "Closed state and full worker payment are not proven on-chain." }, { status: 422 });
  const updated = await (prisma as any).standaloneStream.update({ where: { reference }, data: { status: "CLOSED", totalReleased: state.totalReleased.toString(), tranchesReleased: Number(state.tranchesReleased), closeTxHash: txHash, closedAt: new Date() } });
  return NextResponse.json({ success: true, stream: { ...updated, totalReleasedUSDC: formatStreamAmount(state.totalReleased) }, txHash, warning: "All remaining funds were paid to the worker; close is not a refund." });
}
