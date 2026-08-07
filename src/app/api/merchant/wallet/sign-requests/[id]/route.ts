// src/app/api/merchant/wallet/sign-requests/[id]/route.ts
//
// Accepts the signature a connected wallet produced for a pending request.
// This closes the generic half of the loop (verify + record). It does NOT
// yet resume whatever feature queued the request (broadcasting the tx,
// flipping an Escrow to RELEASED, etc.) — that resume logic is specific to
// each of the 19 call sites and is follow-up work, not built here. Marking
// this honestly rather than pretending the loop is fully closed.

import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { prisma } from "@/lib/prisma";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";

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

  const request = await (prisma as any).walletSignatureRequest.findUnique({ where: { id } });
  if (!request || request.merchantId !== merchant.id) {
    return NextResponse.json({ success: false, error: "Signature request not found." }, { status: 404 });
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

  const updated = await (prisma as any).walletSignatureRequest.update({
    where: { id },
    data: { status: "SIGNED", signedTx: signedTx || null },
  });

  return NextResponse.json({
    success: true,
    request: updated,
    note: `Signature recorded for ${updated.action}. Resuming the original action (${updated.actionRefId}) is feature-specific and not yet wired for every call site.`,
  });
}
