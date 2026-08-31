// src/lib/wallet/signatureQueue.ts
// Authoritative queue for external-wallet actions. Every queued row carries
// server-created context that the resume handler will re-validate — the
// signer cannot alter payer/beneficiary/amount/reference after creation.

import { prisma } from "@/lib/prisma";

const TTL_MS = 15 * 60 * 1000;

export async function queueExternalSignatureRequest(params: {
  merchantId: string;
  action: string;
  actionRefId: string;
  payload: Record<string, unknown>;
}) {
  const request = await (prisma as any).walletSignatureRequest.create({
    data: {
      merchantId: params.merchantId,
      action: params.action,
      actionRefId: params.actionRefId,
      payload: params.payload as any,
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });
  return request;
}
