// src/app/api/escrow/[reference]/beneficiary-confirm/route.ts
//
// PUBLIC recording endpoint for an external-EOA beneficiary's on-chain
// confirmDelivery. Mirrors /api/escrow/link/[reference]/fund: the beneficiary
// pays nothing here and this route never moves funds — it VERIFIES the
// beneficiary's own on-chain confirmDelivery transaction and mirrors the
// authoritative contract state onto the Escrow row.
//
// TRUST MODEL: it is NOT enough that some successful transaction hit the
// escrow contract. The transaction is proven to be THE confirmDelivery for
// THIS exact escrow:
//
//   reference -> onchainId = keccak256(reference)   (deterministic, server)
//     -> tx FROM == beneficiarySCA (only the beneficiary's own signature can
//        produce a confirmDelivery from that address)
//     -> tx TO == escrow contract
//     -> calldata selector == confirmDelivery
//     -> decoded bytes32 argument == contractEscrowId (== keccak256(reference))
//     -> receipt.status == success
//     -> AUTHORITATIVE getEscrow(onchainId) state at the receipt block is
//        re-read and MIRRORED — the DB is never flipped from receipt success
//        alone. One-sided-confirmed stays ACTIVE with beneficiaryConfirmed;
//        the auto-released case (both sides confirmed) becomes RELEASED.
//
// A transaction from any other sender, targeting any other contract, calling
// any other function, or confirming a DIFFERENT escrow id can never mark this
// escrow confirmed.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/ratelimit';
import { isAddress, keccak256, toBytes, decodeAbiParameters, type Hash } from 'viem';
import {
  ARCFLARE_ESCROW_CONTRACT_ADDRESS,
  escrowAbi,
  escrowSelectors,
} from '@/lib/wallet/flarehqContracts';
import { getReceiptReliable, getTransactionReliable, extractSelector, readContractReliable } from '@/lib/wallet/chainClient';
import { notify } from '@/lib/notifications';

const ESCROW_CONTRACT =
  process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || ARCFLARE_ESCROW_CONTRACT_ADDRESS || '';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse;

    const { reference } = await params;
    const body = await req.json().catch(() => ({}));
    const { callerSCA, txHash } = body;

    if (!callerSCA || !isAddress(callerSCA)) {
      return NextResponse.json({ success: false, error: 'Valid callerSCA (0x…) is required.' }, { status: 400 });
    }
    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return NextResponse.json({ success: false, error: 'Valid txHash is required.' }, { status: 400 });
    }
    if (!ESCROW_CONTRACT) {
      return NextResponse.json({ success: false, error: 'Escrow contract address is not configured.' }, { status: 500 });
    }

    const escrow = await prisma.escrow.findUnique({ where: { reference } });
    if (!escrow) {
      return NextResponse.json({ success: false, error: 'Escrow not found.' }, { status: 404 });
    }
    if (escrow.status !== 'ACTIVE') {
      return NextResponse.json({ success: false, error: `This escrow is ${escrow.status} — cannot confirm.` }, { status: 409 });
    }
    if (escrow.deadline && escrow.deadline.getTime() < Date.now()) {
      return NextResponse.json({ success: false, error: 'This escrow has expired — the depositor can reclaim it.' }, { status: 400 });
    }
    if (escrow.beneficiarySCA.toLowerCase() !== callerSCA.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'callerSCA is not the beneficiary of this escrow.' },
        { status: 403 }
      );
    }
    const onchainId = escrow.contractEscrowId || keccak256(toBytes(reference));

    // ── 1. Fetch the raw transaction (for sender + calldata selector) ──────
    const tx = await getTransactionReliable(txHash);
    if (!tx) {
      return NextResponse.json(
        { success: false, error: 'Transaction not found. Try again shortly.' },
        { status: 404 }
      );
    }
    if (tx.from.toLowerCase() !== callerSCA.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'Transaction sender does not match the beneficiary address.' },
        { status: 400 }
      );
    }
    if ((tx.to || '').toLowerCase() !== ESCROW_CONTRACT.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'Transaction was not sent to the escrow contract.' },
        { status: 400 }
      );
    }
    const selector = extractSelector(tx.input);
    if (!selector || selector !== escrowSelectors.confirmDelivery) {
      return NextResponse.json(
        { success: false, error: 'Transaction does not call confirmDelivery on the escrow contract.' },
        { status: 400 }
      );
    }
    // ── 2. Decode the bytes32 argument and match it to THIS escrow ─────────
    let decodedEscrowId: string | null = null;
    try {
      // tx.input = 0x + selector(8) + 32-byte arg(64). slice(10) drops the
      // 0x + selector, leaving the bare 64-hex arg — decodeAbiParameters needs
      // the 0x prefix back.
      const [arg] = decodeAbiParameters([{ type: 'bytes32' }], `0x${tx.input.slice(10)}` as Hash);
      decodedEscrowId = arg.toLowerCase();
    } catch {
      decodedEscrowId = null;
    }
    if (!decodedEscrowId || decodedEscrowId !== onchainId.toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'Transaction confirms a DIFFERENT escrow id — it cannot mark this escrow confirmed.' },
        { status: 400 }
      );
    }

    // ── 3. Receipt must be successful ───────────────────────────────────────
    const receipt = await getReceiptReliable(txHash);
    if (!receipt) {
      return NextResponse.json(
        { success: false, error: 'Transaction not yet confirmed. Try again shortly.' },
        { status: 404 }
      );
    }
    if (receipt.status !== 'success') {
      return NextResponse.json({ success: false, error: 'Transaction reverted on-chain.' }, { status: 400 });
    }

    // ── 4. AUTHORITATIVE state: re-read getEscrow at the receipt block and
    // mirror it. Never trust "receipt succeeded" alone — the contract is the
    // single source of truth for which party has confirmed and whether the
    // dual-confirm auto-release already fired.
    let onChain = await readContractReliable({
      address: ESCROW_CONTRACT,
      abi: escrowAbi,
      functionName: 'getEscrow',
      args: [onchainId as Hash],
      blockNumber: receipt.blockNumber,
    });
    if (!onChain) {
      // Node can't serve eth_call at an exact historical block — read at the
      // LATEST block as a fallback. State is monotonic (confirms only set
      // true, release is terminal), so a later read is still authoritative
      // for whether confirmation happened.
      onChain = await readContractReliable({
        address: ESCROW_CONTRACT,
        abi: escrowAbi,
        functionName: 'getEscrow',
        args: [onchainId as Hash],
      });
    }
    if (!onChain) {
      return NextResponse.json(
        { success: false, error: 'Could not read the on-chain escrow state to verify the confirmation.' },
        { status: 500 }
      );
    }

    const s = onChain as any;
    const depositorConfirmed = typeof s.depositorConfirmed === 'boolean' ? s.depositorConfirmed : s[5];
    const beneficiaryConfirmed = typeof s.beneficiaryConfirmed === 'boolean' ? s.beneficiaryConfirmed : s[6];
    const amount = typeof s.amount === 'bigint' ? s.amount : s[2];

    if (!beneficiaryConfirmed) {
      return NextResponse.json(
        { success: false, error: 'On-chain state shows the beneficiary has not confirmed — the transaction did not confirm this escrow.' },
        { status: 400 }
      );
    }

    // ── 5. Mirror the contract state onto the DB ────────────────────────────
    // One-sided confirmed → stays ACTIVE with beneficiaryConfirmed=true.
    // Both sides confirmed → the contract already auto-released → RELEASED.
    const bothConfirmed = depositorConfirmed && beneficiaryConfirmed;
    const newStatus = bothConfirmed ? 'RELEASED' : 'ACTIVE';

    const updated = await prisma.escrow.update({
      where: { reference },
      data: {
        beneficiaryConfirmed: true,
        depositorConfirmed: depositorConfirmed ? true : escrow.depositorConfirmed,
        status: newStatus,
        releaseTxHash: newStatus === 'RELEASED' ? txHash : escrow.releaseTxHash,
      },
    });

    // Mirror the ledger unlock the release route does (Build 5 repair D8):
    // when the escrow fully released, the depositor's JOB_ESCROW_LOCK leaves.
    if (newStatus === 'RELEASED') {
      try {
        const { recordLedgerEntry, resolveAgentIdBySca } = await import("@/lib/ledger/ledgerService");
        const agentId = await resolveAgentIdBySca(escrow.depositorSCA).catch(() => null);
        if (agentId) {
          const amt = BigInt(Math.round(Number(escrow.amount) * 1_000_000));
          await recordLedgerEntry({
            agentRegistryId: agentId,
            type: "JOB_ESCROW_RELEASE",
            amount: amt,
            direction: "CREDIT",
            txHash,
            description: `escrow released ${reference}`,
          });
        }
      } catch (e: any) { console.error("[ledger] escrow release failed:", e.message); }
    }

    // Notify the depositor's owning merchant (if any) that release happened.
    if (newStatus === 'RELEASED' && escrow.merchantId) {
      await notify({
        merchantId: escrow.merchantId,
        event: 'escrow.released',
        title: 'Escrow released',
        message: `Escrow ${reference} fully released — ${escrow.amount} USDC sent to ${escrow.beneficiarySCA}.`,
        data: { reference, amount: escrow.amount, txHash },
        webhookUrlOverride: escrow.webhookUrl,
      }).catch(() => {});
    } else if (escrow.webhookUrl) {
      fetch(escrow.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: newStatus === 'RELEASED' ? 'escrow.released' : 'escrow.confirmed',
          reference,
          amount: escrow.amount,
          currency: escrow.currency,
          confirmedBy: 'beneficiary',
          beneficiary: escrow.beneficiarySCA,
          txHash,
          releasedAt: newStatus === 'RELEASED' ? new Date().toISOString() : null,
        }),
      }).catch(() => { });
    }

    return NextResponse.json({
      success: true,
      escrow: updated,
      txHash,
      released: newStatus === 'RELEASED',
      beneficiaryConfirmed: true,
      depositorConfirmed: Boolean(depositorConfirmed),
      amount: Number(amount) / 1_000_000,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message:
        newStatus === 'RELEASED'
          ? `Both parties confirmed — escrow auto-released. ${escrow.amount} USDC sent to ${escrow.beneficiarySCA}.`
          : 'Delivery confirmed. Waiting for the depositor to confirm — the escrow auto-releases when both sides have.',
    });
  } catch (error: any) {
    console.error('Escrow beneficiary-confirm error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
