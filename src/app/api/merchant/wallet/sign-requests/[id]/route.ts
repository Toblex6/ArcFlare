// src/app/api/merchant/wallet/sign-requests/[id]/route.ts
//
// The frontend broadcasts a REAL transaction with the connected external
// wallet, then submits the REAL txHash here. This route:
//
//   1. authenticates the merchant,
//   2. loads the queued TRANSACTION request,
//   3. claims it PENDING -> EXECUTING,
//   4. re-reads the chain (receipt + on-chain effect) via
//      verifyExternalTransaction(), and ONLY then
//   5. transitions domain state / writes the ledger with the real txHash.
//
// A signature alone is never accepted; a fabricated hash is never accepted;
// a tx that didn't actually execute the intended operation is never accepted.
// Idempotent: re-submitting a COMPLETED request replays its recorded txHash;
// a FAILED request can be retried with the SAME txHash.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { resumeTransactionRequest } from "@/lib/wallet/transactionResume";

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const merchant = await resolveMerchant(req);
  if (!merchant) {
    return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
  }

  const { id } = await params;
  const { txHash } = await req.json().catch(() => ({}));

  let request = await (prisma as any).walletSignatureRequest.findUnique({ where: { id } });
  if (!request || request.merchantId !== merchant.id) {
    return NextResponse.json({ success: false, error: "Signature request not found." }, { status: 404 });
  }

  const isTransactionRequest = Boolean(request.payload?.transaction);

  // Legacy SIGNATURE requests (EIP-191 personal_sign resume) are dead by
  // design: a message signature does not move funds. Never fabricate a hash.
  if (!isTransactionRequest) {
    return NextResponse.json(
      {
        success: false,
        error:
          "This request is a legacy message-signature request. Signature-only approvals no longer execute actions — start the action again to create a real transaction request.",
      },
      { status: 410 }
    );
  }

  if (!txHash || typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) {
    return NextResponse.json(
      { success: false, error: "A real transaction hash (0x…) from your wallet broadcast is required." },
      { status: 400 }
    );
  }

  // Idempotent replay — already completed with a real txHash.
  if (request.status === "COMPLETED") {
    return NextResponse.json({
      success: true,
      request,
      resumed: true,
      txHash: request.signedTx,
      note: "Already completed — idempotent replay.",
    });
  }
  if (request.status === "EXECUTING") {
    return NextResponse.json({ success: true, request, note: "Verification already in progress." });
  }

  // A FAILED request may be retried with the SAME txHash (e.g. a transient
  // node hiccup during verification). Re-claim it and re-verify. A DIFFERENT
  // txHash is refused — retry the original action to create a fresh request.
  if (request.status === "FAILED") {
    if (request.signedTx?.toLowerCase() !== txHash.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "Previous verification failed — retry the original action or resubmit the SAME transaction hash." },
        { status: 409 }
      );
    }
    await (prisma as any).walletSignatureRequest.update({
      where: { id },
      data: { status: "PENDING", signedTx: null },
    });
    request = await (prisma as any).walletSignatureRequest.findUnique({ where: { id } });
  }

  if (request.status !== "PENDING") {
    return NextResponse.json(
      { success: false, error: `Request is already ${request.status}.` },
      { status: 409 }
    );
  }
  if (request.expiresAt < new Date()) {
    await (prisma as any).walletSignatureRequest.update({ where: { id }, data: { status: "EXPIRED" } });
    return NextResponse.json(
      { success: false, error: "This request expired — the original action needs to be retried." },
      { status: 410 }
    );
  }

  // Verify the real broadcast + apply domain state.
  const result = await resumeTransactionRequest(request, txHash);

  const updated = await (prisma as any).walletSignatureRequest.findUnique({ where: { id } });

  if (result.status === "COMPLETED") {
    return NextResponse.json({
      success: true,
      request: updated,
      txHash: result.txHash,
      details: result.details ?? null,
      explorerUrl: `https://testnet.arcscan.app/tx/${result.txHash}`,
      message: `Action ${updated.action} completed and verified on-chain.`,
    });
  }
  if (result.status === "EXECUTING") {
    return NextResponse.json({ success: true, request: updated, note: "Verification in progress." });
  }
  // FAILED
  const failureMsg = result.status === "FAILED" ? result.error : "unexpected resume state";
  console.error(`[sign-requests/${id}] verification failed:`, failureMsg);
  return NextResponse.json(
    {
      success: false,
      error: "On-chain verification failed — no state was changed.",
      details: failureMsg,
      request: updated,
    },
    { status: 422 }
  );
}
