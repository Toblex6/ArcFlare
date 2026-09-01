// src/lib/wallet/signatureQueue.ts
// Authoritative queue for external-wallet actions.
//
// Two kinds of rows are created here:
//
//   1. TRANSACTION requests (preferred — the only kind newly created):
//      action namespaced "tx.*", payload carries a `transaction` intent
//      (exact contract/token call the connected wallet must broadcast:
//      to/from/function/args/value). The frontend broadcasts the REAL
//      transaction, submits the real txHash, and the server verifies the
//      receipt + on-chain effect before touching domain state.
//
//   2. Legacy SIGNATURE requests (action namespaced without "tx."): these
//      were the EIP-191 personal-sign + fake-hash resume model and are NO
//      LONGER created. Any pre-existing row is refused by the resume route
//      (it never fabricates a success).
//
// Every queued row carries server-created context that the verifier
// re-validates — the signer cannot alter payer/beneficiary/amount/reference
// after creation.

import { prisma } from "@/lib/prisma";

const TTL_MS = 15 * 60 * 1000;

export const TX_ACTIONS = {
  escrowRelease: "tx.escrow.release",
  escrowDispute: "tx.escrow.dispute",
  payrollTransfer: "tx.payroll.transfer",
} as const;

/**
 * The exact on-chain call an external wallet must broadcast. Server-created,
 * never body-supplied. The frontend builds writeContract(...) from this and
 * the server re-checks every field against the actual broadcast.
 */
export interface TransactionIntent {
  description: string;
  chainId: number;
  /** contract/token the wallet must call (matches receipt.to) */
  to: string;
  /** wallet that must broadcast (matches receipt.from) */
  from: string;
  /** e.g. "confirmDelivery(bytes32)", "transfer(address,uint256)" */
  abiFunctionSignature: string;
  /** ABI-encoded argument values (server-authoritative) */
  args: unknown[];
  /** native value to send, "0" for pure contract calls */
  value?: string;
}

export async function queueTransactionRequest(params: {
  merchantId: string;
  action: string;
  actionRefId: string;
  payload: Record<string, unknown> & { transaction: TransactionIntent };
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

// Backward-compat alias — older routes import the legacy name; they now
// create Transaction requests (never legacy personal-sign rows).
export const queueExternalSignatureRequest = queueTransactionRequest;
