// src/app/api/merchant/wallet/sign-requests/[id]/route.ts
//
// Verifies signature and RESUMES the underlying action. Idempotent and
// fail-closed: PENDING->SIGNED (atomic) -> EXECUTING -> COMPLETED/FAILED.
// Signature is bound to server-created payload; modified payload cannot
// redirect the action because resume re-validates against DB state.

import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { prisma } from "@/lib/prisma";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { resumeSignatureRequest } from "@/lib/wallet/signatureResume";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const merchant = await resolveMerchant(req);
  if (!merchant) {
    return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
  }

  const { id } = await params;
  const { signature, signedTx } = await req.json();
  if (!signature) {
    return NextResponse.json({ success: false, error: "signature is required." }, { status: 400 });
  }

  let request = await (prisma as any).walletSignatureRequest.findUnique({ where: { id } });
  if (!request || request.merchantId !== merchant.id) {
    return NextResponse.json({ success: false, error: "Signature request not found." }, { status: 404 });
  }

  // Idempotent replay: already completed
  if (request.status === "COMPLETED") {
    return NextResponse.json({ success: true, request, resumed: true, txHash: request.signedTx, note: "Already completed — idempotent replay." });
  }
  if (request.status === "FAILED") {
    return NextResponse.json({ success: false, error: "Previous resume failed — retry the original action.", request }, { status: 500 });
  }
  if (request.status === "EXECUTING") {
    return NextResponse.json({ success: true, request, note: "Resume already in progress." });
  }
  if (request.status !== "PENDING") {
    return NextResponse.json({ success: false, error: `Request is already ${request.status}.` }, { status: 409 });
  }
  if (request.expiresAt < new Date()) {
    await (prisma as any).walletSignatureRequest.update({ where: { id }, data: { status: "EXPIRED" } });
    return NextResponse.json({ success: false, error: "This request expired — the original action needs to be retried." }, { status: 410 });
  }

  const merchantRecord = await (prisma as any).merchant.findUnique({ where: { id: merchant.id } });
  const valid = await verifyMessage({
    address: merchantRecord.walletAddress as `0x${string}`,
    message: JSON.stringify(request.payload),
    signature,
  }).catch(() => false);

  if (!valid) {
    return NextResponse.json({ success: false, error: "Signature does not match this wallet." }, { status: 401 });
  }

  // Atomic PENDING->SIGNED claim
  const claimed = await (prisma as any).walletSignatureRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "SIGNED", signedTx: signedTx || null },
  });
  if (claimed.count === 0) {
    request = await (prisma as any).walletSignatureRequest.findUnique({ where: { id } });
    if (request?.status === "COMPLETED") return NextResponse.json({ success: true, request, resumed: true, txHash: request.signedTx });
    return NextResponse.json({ success: false, error: `Request is already ${request?.status}.` }, { status: 409 });
  }
  request = await (prisma as any).walletSignatureRequest.findUnique({ where: { id } });

  // Resume underlying action — fail-closed, never mark COMPLETED until success
  const result = await resumeSignatureRequest(request);

  const updated = await (prisma as any).walletSignatureRequest.findUnique({ where: { id } });

  if (result.status === "COMPLETED") {
    return NextResponse.json({
      success: true,
      request: updated,
      txHash: result.txHash,
      message: `Action ${updated.action} completed.`,
    });
  }
  if (result.status === "EXECUTING") {
    return NextResponse.json({ success: true, request: updated, note: "Resume in progress." });
  }
  // FAILED
  console.error(`[sign-requests/${id}] resume failed:`, result.error);
  return NextResponse.json({ success: false, error: "Underlying action failed — not marked completed.", details: result.error, request: updated }, { status: 500 });
}
