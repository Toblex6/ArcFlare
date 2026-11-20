// Standalone ArcFlareStream create/list. No ERC-8183 job required.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { streamAddressOr503 } from "@/lib/stream/streamGuard";
import { verifyCallerControlsAddress, getCallerControlledAddresses } from "@/lib/wallet/verifyCallerControlsAddress";
import { requireConsumerStepUpForActor } from "@/lib/auth/consumerStepUp";
import { getNetworkConfig } from "@/lib/config/network";
import { computeTrancheAmounts, readStreamOnChain } from "@/lib/contracts/streamContract";
import { parseStreamAmount, formatStreamAmount, streamOpenedFromReceipt, verifyStreamTransaction, exactStreamState } from "@/lib/stream/standalone";
import { executeCircleStreamCall, externalStreamTransaction, resolveExactStreamWallet } from "@/lib/stream/standaloneActions";

export async function POST(req: NextRequest) {
  const gate = streamAddressOr503();
  if ("response" in gate) return gate.response;
  const contractAddress = gate.address;
  const body = await req.json().catch(() => ({}));
  const posterAddress = String(body.posterAddress ?? "");
  const workerAddress = String(body.workerAddress ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(workerAddress) || workerAddress.toLowerCase() === posterAddress.toLowerCase()) return NextResponse.json({ success: false, error: "workerAddress must be a valid address distinct from the poster." }, { status: 400 });
  const actor = await verifyCallerControlsAddress(req, posterAddress);
  if (!actor) return NextResponse.json({ success: false, error: "You do not control posterAddress." }, { status: 403 });
  const stepUp = await requireConsumerStepUpForActor(req, actor, "consumer.job-fund");
  if (stepUp) return stepUp;
  let budget: bigint;
  try { budget = parseStreamAmount(body.totalBudget); } catch (e: any) { return NextResponse.json({ success: false, error: e.message }, { status: 400 }); }
  const trancheCount = Number(body.trancheCount);
  if (!Number.isInteger(trancheCount) || trancheCount < 1 || trancheCount > 50) return NextResponse.json({ success: false, error: "trancheCount must be an integer from 1 to 50." }, { status: 400 });
  const wallet = await resolveExactStreamWallet(posterAddress);
  if (!wallet) return NextResponse.json({ success: false, error: "Poster wallet cannot be resolved." }, { status: 409 });
  const token = getNetworkConfig().usdcAddress;
  const reference = `stream_${crypto.randomUUID()}`;

  if (wallet.mode === "EXTERNAL" && !body.txHash) {
    return NextResponse.json({
      success: true, pendingWallet: true, reference,
      transactions: [
        externalStreamTransaction({ description: `Approve ${formatStreamAmount(budget)} USDC for milestones`, from: posterAddress, to: token, signature: "approve(address,uint256)", args: [contractAddress, budget.toString()] }),
        externalStreamTransaction({ description: `Create ${trancheCount}-tranche stream`, from: posterAddress, to: contractAddress, signature: "openStream(address,address,uint256,uint256)", args: [workerAddress, token, budget.toString(), String(trancheCount)] }),
      ],
      confirm: { endpoint: "/api/streams", body: { posterAddress, workerAddress, totalBudget: body.totalBudget, trancheCount, reference } },
      message: "Approve USDC, then open the stream. FlareHQ records it only after verifying the mined StreamOpened event and state.",
    });
  }

  let txHash = String(body.txHash ?? "");
  if (wallet.mode === "CIRCLE") {
    await executeCircleStreamCall({ wallet, contractAddress: token, signature: "approve(address,uint256)", args: [contractAddress, budget.toString()], label: "stream USDC approval" });
    txHash = await executeCircleStreamCall({ wallet, contractAddress, signature: "openStream(address,address,uint256,uint256)", args: [workerAddress, token, budget.toString(), String(trancheCount)], label: "open stream" });
  }
  const proof = await verifyStreamTransaction({ txHash, from: posterAddress, contractAddress });
  if (!proof.ok) return NextResponse.json({ success: false, error: proof.error }, { status: 422 });
  const event = streamOpenedFromReceipt(proof.receipt, contractAddress);
  if (!event || event.poster.toLowerCase() !== posterAddress.toLowerCase() || event.worker.toLowerCase() !== workerAddress.toLowerCase() || event.token.toLowerCase() !== token.toLowerCase() || event.totalBudget !== budget || event.trancheCount !== BigInt(trancheCount)) return NextResponse.json({ success: false, error: "The transaction did not open this exact stream." }, { status: 422 });
  const state = await exactStreamState({ streamId: event.streamId, poster: posterAddress, worker: workerAddress, token, totalBudget: budget, trancheCount });
  if (!state) return NextResponse.json({ success: false, error: "On-chain stream state does not match." }, { status: 422 });
  const workerActor = await verifyCallerControlsAddress(req, workerAddress).catch(() => null); // only resolves if same caller; classification optional
  const record = await (prisma as any).standaloneStream.create({ data: {
    reference: typeof body.reference === "string" && /^stream_[0-9a-f-]{36}$/.test(body.reference) ? body.reference : reference,
    streamId: event.streamId.toString(), posterAddress: posterAddress.toLowerCase(), posterActorType: actor.type, posterActorId: actor.id,
    workerAddress: workerAddress.toLowerCase(), workerActorType: workerActor?.type ?? null, workerActorId: workerActor?.id ?? null,
    totalBudget: budget.toString(), trancheCount, txHash,
  }});
  return NextResponse.json({ success: true, stream: { ...record, totalBudgetUSDC: formatStreamAmount(budget), trancheAmounts: computeTrancheAmounts(budget, trancheCount).map(formatStreamAmount) } });
}

export async function GET(req: NextRequest) {
  const gate = streamAddressOr503(); if ("response" in gate) return gate.response;
  const controlled = await getCallerControlledAddresses(req);
  if (!controlled.size) return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
  const rows = await (prisma as any).standaloneStream.findMany({ where: { OR: [{ posterAddress: { in: [...controlled], mode: "insensitive" } }, { workerAddress: { in: [...controlled], mode: "insensitive" } }] }, include: { tranches: true }, orderBy: { createdAt: "desc" } });
  const streams = await Promise.all(rows.map(async (row: any) => {
    const state = await readStreamOnChain(BigInt(row.streamId)).catch(() => null);
    return { ...row, totalBudgetUSDC: formatStreamAmount(BigInt(row.totalBudget)), onChain: state ? { ...state, totalBudget: state.totalBudget.toString(), trancheCount: state.trancheCount.toString(), tranchesReleased: state.tranchesReleased.toString(), totalReleased: state.totalReleased.toString(), openedAt: state.openedAt.toString() } : null };
  }));
  return NextResponse.json({ success: true, product: "Milestone streams", protocol: "ArcFlareStream", standalone: true, streams });
}
