// src/lib/wallet/transactionVerification.ts
//
// The core of the external-wallet repair: given a queued TRANSACTION request
// (server-authoritative intent) and a txHash the frontend got back from the
// wallet's broadcast, this module independently re-reads the chain and proves
// the transaction really did exactly what the request intended.
//
// Nothing here writes DB state or ledger rows — it is a pure verifier, which
// keeps it directly unit-testable. The resume executor (transactionResume.ts)
// calls it and only then transitions domain state.
//
// Invariants enforced for EVERY action:
//   - the receipt exists and its status is success (reverted = rejected)
//   - receipt.to == the intended contract/token
//   - receipt.from == the intended wallet (the merchant's connected EOA)
//   - the calldata selector == the intended function (proves WHICH function ran)
// plus an action-specific effect check (event decode / authoritative state).

import {
  decodeEventLog,
  getAddress,
  keccak256,
  parseUnits,
  toBytes,
  type Hash,
} from "viem";
import {
  getReceiptReliable,
  getTransactionReliable,
  extractSelector,
  readContractReliable,
} from "@/lib/wallet/chainClient";
import {
  ARCFLARE_ESCROW_CONTRACT_ADDRESS,
  ARCFLARE_USDC_CONTRACT,
  ARCFLARE_USDC_DECIMALS,
  escrowAbi,
  escrowEventTopics,
  usdcTransferAbi,
  type EscrowOnChain,
} from "@/lib/wallet/flarehqContracts";

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

export interface VerifiedExternalTransaction {
  txHash: string;
  action: string;
  from: string;
  to: string;
  receipt: NonNullable<Awaited<ReturnType<typeof getReceiptReliable>>>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function readEscrowOnChain(escrowId: string): Promise<EscrowOnChain | null> {
  if (!ARCFLARE_ESCROW_CONTRACT_ADDRESS) return null;
  try {
    const result = await readContractReliable({
      address: ARCFLARE_ESCROW_CONTRACT_ADDRESS,
      abi: escrowAbi,
      functionName: "getEscrow",
      args: [escrowId as Hash],
    });
    if (!result) return null;
    // viem returns a tuple-typed struct as an object with named fields.
    const r = result as unknown as {
      depositor?: string;
      beneficiary?: string;
      amount?: bigint;
      deadline?: bigint;
      ref?: string;
      depositorConfirmed?: boolean;
      beneficiaryConfirmed?: boolean;
      [k: number]: unknown; // some viem versions return an array-like tuple
    };
    const depositor = typeof r.depositor === "string" ? r.depositor : (r[0] as string);
    const beneficiary = typeof r.beneficiary === "string" ? r.beneficiary : (r[1] as string);
    const amount = typeof r.amount === "bigint" ? r.amount : (r[2] as bigint);
    const deadline = typeof r.deadline === "bigint" ? r.deadline : (r[3] as bigint);
    const ref = typeof r.ref === "string" ? r.ref : (r[4] as string);
    const depositorConfirmed = typeof r.depositorConfirmed === "boolean" ? r.depositorConfirmed : (r[5] as boolean);
    const beneficiaryConfirmed = typeof r.beneficiaryConfirmed === "boolean" ? r.beneficiaryConfirmed : (r[6] as boolean);
    if (!depositor || depositor === "0x0000000000000000000000000000000000000000") return null;
    return {
      depositor: getAddress(depositor),
      beneficiary: getAddress(beneficiary),
      amount,
      deadline,
      reference: ref,
      depositorConfirmed,
      beneficiaryConfirmed,
    };
  } catch {
    return null;
  }
}

function decodeTransferLogs(logs: any[]) {
  const transfers: { from: string; to: string; value: bigint }[] = [];
  const transferEvent = usdcTransferAbi.find((e) => e.type === "event");
  if (!transferEvent || transferEvent.type !== "event") return transfers;
  for (const log of logs) {
    if (!eq(log.address, ARCFLARE_USDC_CONTRACT)) continue;
    try {
      const decoded = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "Transfer") continue;
      const { from, to, value } = decoded.args as { from: string; to: string; value: bigint };
      transfers.push({ from, to, value });
    } catch {
      // not a decodable USDC Transfer log
    }
  }
  return transfers;
}

// ── action-specific verification ─────────────────────────────────────────────

async function verifyEscrowRelease(payload: any, receipt: any): Promise<void> {
  const escrowId = String(payload.contractEscrowId || "").toLowerCase();
  const caller = String(payload.callerSCA || "").toLowerCase();
  if (!escrowId) throw new VerificationError("escrow.release intent has no contractEscrowId");

  // Authoritative on-chain state after the confirmDelivery tx.
  const escrow = await readEscrowOnChain(escrowId);
  if (!escrow) {
    throw new VerificationError(
      "Escrow does not exist on-chain at the configured escrow contract."
    );
  }

  const isDepositor = eq(escrow.depositor, caller);
  const isBeneficiary = eq(escrow.beneficiary, caller);
  if (!isDepositor && !isBeneficiary) {
    throw new VerificationError("Broadcasting wallet is not a party to this escrow on-chain.");
  }
  // The tx must have flipped the caller's confirmation flag. Because the
  // contract reverts on double-confirmation ("already confirmed"), a success
  // receipt can only come from the FIRST confirmation by this party.
  const callerConfirmed = isDepositor
    ? escrow.depositorConfirmed
    : escrow.beneficiaryConfirmed;
  if (!callerConfirmed) {
    throw new VerificationError(
      "confirmDelivery receipt verified but the on-chain escrow does not show this party as confirmed."
    );
  }
  if (payload.amount !== undefined && payload.amount !== null) {
    const expectedAmount = parseUnits(String(payload.amount), ARCFLARE_USDC_DECIMALS);
    if (escrow.amount !== expectedAmount) {
      throw new VerificationError("On-chain escrow amount does not match the intended escrow.");
    }
  }
  if (payload.beneficiarySCA && !eq(escrow.beneficiary, String(payload.beneficiarySCA))) {
    throw new VerificationError("On-chain escrow beneficiary does not match the intended escrow.");
  }
}

async function verifyEscrowDispute(payload: any, receipt: any): Promise<void> {
  const escrowId = String(payload.contractEscrowId || "").toLowerCase();
  if (!escrowId) throw new VerificationError("escrow.dispute intent has no contractEscrowId");

  // The on-chain effect of dispute(bytes32,string) is the EscrowDisputed
  // event (the deployed contract exposes no public getter for the disputed
  // flag). Find it in the receipt, emitted by the escrow contract, for THIS
  // escrowId (topics[1]).
  let found = false;
  for (const log of receipt.logs || []) {
    if (!eq(log.address, ARCFLARE_ESCROW_CONTRACT_ADDRESS)) continue;
    if (log.topics?.[0]?.toLowerCase() !== escrowEventTopics.EscrowDisputed) continue;
    const logId = log.topics?.[1]?.toLowerCase();
    if (logId && logId !== escrowId) {
      throw new VerificationError("EscrowDisputed event references a different escrow than intended.");
    }
    found = true;
    break;
  }
  if (!found) {
    throw new VerificationError(
      "No EscrowDisputed event from the escrow contract found in this transaction."
    );
  }
}

async function verifyPayrollTransfer(payload: any, receipt: any): Promise<void> {
  const recipient = String(payload.recipientSCA || "").toLowerCase();
  const payer = String(payload.payerSCA || "").toLowerCase();
  const amount = String(payload.amount ?? "");
  if (!recipient || !amount) {
    throw new VerificationError("payroll.transfer intent missing recipient or amount.");
  }
  const expectedAmount = parseUnits(amount, ARCFLARE_USDC_DECIMALS);

  const transfers = decodeTransferLogs(receipt.logs || []);
  const match = transfers.find(
    (t) =>
      eq(t.from, payer) &&
      eq(t.to, recipient) &&
      t.value === expectedAmount
  );
  if (!match) {
    throw new VerificationError(
      "No USDC Transfer from the intended payer to the intended recipient for the exact intended amount was found in this transaction."
    );
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Derive the 4-byte selector for a function signature string.
 */
export function selectorForSignature(signature: string): string {
  const sig = signature.includes(" ") ? signature.split(" ").slice(-1)[0] : signature;
  const normalized = sig.replace(/\s+/g, "");
  if (!normalized.includes("(")) return "";
  return keccak256(toBytes(normalized)).slice(0, 10).toLowerCase();
}

/**
 * Verifies that `txHash` is a real, successful broadcast that executed the
 * exact operation encoded in the queued request's payload. Throws
 * VerificationError on any mismatch or missing evidence.
 */
export async function verifyExternalTransaction(
  request: { action: string; payload: any },
  txHash: string
): Promise<VerifiedExternalTransaction> {
  const payload = request.payload || {};
  const intent = payload.transaction;
  if (!intent || typeof intent !== "object") {
    throw new VerificationError(
      "Request payload has no transaction intent — refusing to verify."
    );
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new VerificationError("Not a valid transaction hash.");
  }

  // 1. Authoritative receipt — never trust the client's claim it "worked".
  const receipt = await getReceiptReliable(txHash);
  if (!receipt) {
    throw new VerificationError(
      "Transaction not found on-chain (or not yet confirmed). No success is recorded."
    );
  }
  if (receipt.status !== "success") {
    throw new VerificationError("Transaction reverted on-chain.");
  }

  // 2. The transaction must be from the intended wallet and to the intended
  //    contract/token.
  const txTo = receipt.to;
  if (txTo && !eq(txTo, String(intent.to))) {
    throw new VerificationError("Transaction was not sent to the intended contract.");
  }
  if (!eq(receipt.from, String(intent.from))) {
    throw new VerificationError("Transaction was not sent from the intended wallet.");
  }

  // 3. The calldata selector must be the intended function — this is what
  //    proves WHICH operation the tx executed (e.g. confirmDelivery, not an
  //    arbitrary contract call to the same address).
  const tx = await getTransactionReliable(txHash);
  const selector = extractSelector(tx?.input);
  const expectedSelector = selectorForSignature(intent.abiFunctionSignature);
  if (expectedSelector && (!selector || selector !== expectedSelector)) {
    throw new VerificationError(
      `Transaction calls a different function than intended (got ${selector || "none"}, expected ${expectedSelector}).`
    );
  }

  // 4. Action-specific on-chain effect.
  switch (request.action) {
    case "tx.escrow.release":
      await verifyEscrowRelease(payload, receipt);
      break;
    case "tx.escrow.dispute":
      await verifyEscrowDispute(payload, receipt);
      break;
    case "tx.payroll.transfer":
      await verifyPayrollTransfer(payload, receipt);
      break;
    default:
      throw new VerificationError(
        `Unknown external-wallet action ${request.action} — not supported.`
      );
  }

  return {
    txHash,
    action: request.action,
    from: receipt.from,
    to: receipt.to as string,
    receipt,
  };
}
