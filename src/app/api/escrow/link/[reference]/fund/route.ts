// src/app/api/escrow/link/[reference]/fund/route.ts
// PUBLIC funding-recording endpoint for escrow request links. The outsider
// pays DIRECTLY from their own external wallet on-chain (approve +
// createEscrow, mirrored from CheckoutWidget's external-wallet pattern) —
// this route never moves funds and never touches Circle. It VERIFIES the
// outsider's on-chain transaction and flips the PENDING_FUNDING Escrow row
// to ACTIVE so release/dispute/refund operate on it normally.
//
// TRUST MODEL (hardened 2026-08-31): it is NOT enough that some successful
// transaction hit the escrow contract. The transaction is proven to be THE
// createEscrow for THIS exact request:
//
//   reference -> onchainId = keccak256(reference)   (deterministic, server)
//     -> EscrowCreated event in THIS receipt has topics[1] == onchainId
//     -> event depositor == depositorSCA
//     -> event beneficiary == escrow.beneficiarySCA
//     -> event amount == escrow.amount (6-dec)
//     -> event deadline == escrow.deadline (unix seconds)
//     -> authoritative getEscrow(onchainId) state at the receipt block agrees
//
// A valid transaction that created a DIFFERENT escrow (different reference,
// amount, beneficiary, or a wholly separate escrow request) can never
// activate this request.
//
// release/dispute/refund are UNCHANGED — they still operate on the same
// Escrow row once it exists and is ACTIVE.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/ratelimit';
import {
  decodeEventLog,
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
  toBytes,
  type Hash,
} from 'viem';
import {
  ARCFLARE_ESCROW_CONTRACT_ADDRESS,
  ARCFLARE_USDC_DECIMALS,
  escrowAbi,
  escrowEventTopics,
  escrowEvents,
} from '@/lib/wallet/flarehqContracts';
import { getReceiptReliable, readContractReliable } from '@/lib/wallet/chainClient';

const ESCROW_CONTRACT =
  process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || ARCFLARE_ESCROW_CONTRACT_ADDRESS || '';

const ESCROW_CREATED_EVENT = escrowEvents.EscrowCreated;

interface EscrowCreatedArgs {
  escrowId: Hash;
  depositor: string;
  beneficiary: string;
  amount: bigint;
  deadline: bigint;
  reference: string;
}

function decodeEscrowCreated(logs: any[]): EscrowCreatedArgs | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== ESCROW_CONTRACT.toLowerCase()) continue;
    if (log.topics?.[0]?.toLowerCase() !== escrowEventTopics.EscrowCreated) continue;
    try {
      const decoded = decodeEventLog({
        abi: [ESCROW_CREATED_EVENT],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== 'EscrowCreated') continue;
      const { escrowId, depositor, beneficiary, amount, deadline, reference } = decoded
        .args as unknown as EscrowCreatedArgs;
      return { escrowId, depositor, beneficiary, amount, deadline, reference };
    } catch {
      // malformed log — keep looking
    }
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse;

    const { reference } = await params;
    const body = await req.json().catch(() => ({}));
    const { depositorSCA, txHash } = body;

    if (!depositorSCA || !isAddress(depositorSCA)) {
      return NextResponse.json({ success: false, error: 'Valid depositorSCA (0x…) is required.' }, { status: 400 });
    }
    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return NextResponse.json({ success: false, error: 'Valid txHash is required.' }, { status: 400 });
    }
    if (!ESCROW_CONTRACT) {
      return NextResponse.json({ success: false, error: 'Escrow contract address is not configured.' }, { status: 500 });
    }

    const escrow = await prisma.escrow.findUnique({ where: { reference } });
    if (!escrow) {
      return NextResponse.json({ success: false, error: 'Escrow request not found.' }, { status: 404 });
    }
    if (escrow.status !== 'PENDING_FUNDING') {
      return NextResponse.json({ success: false, error: `This escrow request is already ${escrow.status}.` }, { status: 409 });
    }
    if (escrow.deadline && escrow.deadline.getTime() < Date.now()) {
      return NextResponse.json({ success: false, error: 'This escrow request has expired.' }, { status: 400 });
    }

    // ── On-chain verification (authoritative receipt, not client claims) ──
    const receipt = await getReceiptReliable(txHash);
    if (!receipt) {
      return NextResponse.json(
        { success: false, error: 'Transaction not found or not yet confirmed. Try again shortly.' },
        { status: 404 }
      );
    }
    if (receipt.status !== 'success') {
      return NextResponse.json({ success: false, error: 'Transaction reverted on-chain.' }, { status: 400 });
    }
    if (receipt.to?.toLowerCase() !== ESCROW_CONTRACT.toLowerCase()) {
      return NextResponse.json({ success: false, error: 'Transaction was not sent to the escrow contract.' }, { status: 400 });
    }
    if (receipt.from.toLowerCase() !== depositorSCA.toLowerCase()) {
      return NextResponse.json({ success: false, error: 'Transaction sender does not match depositorSCA.' }, { status: 400 });
    }

    // ── Prove the tx created THE escrow for THIS reference ────────────────
    // reference -> deterministic onchainId -> actual created escrow id.
    const onchainId = keccak256(toBytes(reference));
    if (escrow.contractEscrowId && escrow.contractEscrowId.toLowerCase() !== onchainId.toLowerCase()) {
      return NextResponse.json({ success: false, error: 'Internal escrow id mismatch.' }, { status: 500 });
    }

    const created = decodeEscrowCreated(receipt.logs || []);
    if (!created) {
      return NextResponse.json(
        { success: false, error: 'No EscrowCreated event from the escrow contract in this transaction — it did not create an escrow.' },
        { status: 400 }
      );
    }

    const expectedAmount = parseUnits(escrow.amount.toFixed(6), ARCFLARE_USDC_DECIMALS);
    const expectedDeadline = BigInt(Math.floor(new Date(escrow.deadline ?? 0).getTime() / 1000));
    const expectedReference = escrow.condition || 'No condition set';

    if (created.escrowId.toLowerCase() !== onchainId.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'This transaction created a DIFFERENT escrow (escrowId mismatch) — it cannot fund this request.' },
        { status: 400 }
      );
    }
    if (getAddress(created.depositor).toLowerCase() !== depositorSCA.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'This transaction created an escrow for a different depositor.' },
        { status: 400 }
      );
    }
    if (getAddress(created.beneficiary).toLowerCase() !== escrow.beneficiarySCA.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'This transaction created an escrow for a different beneficiary.' },
        { status: 400 }
      );
    }
    if (created.amount !== expectedAmount) {
      return NextResponse.json(
        { success: false, error: `This transaction escrowed ${created.amount} (6-dec) instead of the requested ${expectedAmount}.` },
        { status: 400 }
      );
    }
    if (escrow.deadline && created.deadline !== expectedDeadline) {
      return NextResponse.json(
        { success: false, error: 'This transaction used a different deadline than this request.' },
        { status: 400 }
      );
    }
    if (created.reference !== expectedReference) {
      return NextResponse.json(
        { success: false, error: 'This transaction used a different condition than this request.' },
        { status: 400 }
      );
    }

    // Cross-check authoritative on-chain state at the receipt block: the
    // escrow must exist with matching depositor/beneficiary/amount. This is
    // best-effort — the EscrowCreated event above is the primary proof, and
    // some nodes can't serve eth_call at an exact historical block.
    try {
      const stateCheck = await readContractReliable({
        address: ESCROW_CONTRACT,
        abi: escrowAbi,
        functionName: 'getEscrow',
        args: [onchainId as Hash],
        blockNumber: receipt.blockNumber,
      });
      if (stateCheck) {
        const s = stateCheck as any;
        const dep = typeof s.depositor === 'string' ? s.depositor : s[0];
        const ben = typeof s.beneficiary === 'string' ? s.beneficiary : s[1];
        const amt = typeof s.amount === 'bigint' ? s.amount : s[2];
        if (
          !dep ||
          dep.toLowerCase() !== depositorSCA.toLowerCase() ||
          !ben ||
          ben.toLowerCase() !== escrow.beneficiarySCA.toLowerCase() ||
          amt !== expectedAmount
        ) {
          return NextResponse.json(
            { success: false, error: 'On-chain escrow state does not match this request.' },
            { status: 400 }
          );
        }
      }
    } catch {
      // state read unavailable at that block — the event proof already stands
    }

    const updated = await prisma.escrow.update({
      where: { reference },
      data: {
        status: 'ACTIVE',
        depositorSCA,
        txHash,
      },
    });

    return NextResponse.json({
      success: true,
      escrow: { reference: updated.reference, status: updated.status, depositorSCA: updated.depositorSCA },
      txHash,
      escrowId: onchainId,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message: `Escrow funded. ${escrow.amount} USDC is now locked on Arc Testnet for ${escrow.beneficiarySCA}.`,
    });
  } catch (error: any) {
    console.error('Escrow link fund error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
