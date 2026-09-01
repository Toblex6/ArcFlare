// src/app/api/escrow/release/route.ts
// Releases escrowed USDC to beneficiary when conditions are met.
// Called by depositor confirming delivery, or admin releasing directly.
//
// SECURITY FIX: previously executed confirmDelivery AS whatever callerSCA
// was named in the request body, verifying party membership only AFTER
// execution and only against our own DB. Because Circle's API executes on
// behalf of any wallet address within our entity — not scoped by which
// merchant "owns" it in our DB — this meant an authenticated merchant could
// name a DIFFERENT party's SCA and the confirmation would actually execute
// as them. Now verified via verifyCallerControlsAddress() BEFORE any
// execution happens, and rejects up front if the caller doesn't control
// the address they're claiming.

import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveMerchant } from '@/lib/middleware/withMerchantAuth';
import { resolveWalletProvider } from '@/lib/wallet/resolve';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { queueTransactionRequest, TX_ACTIONS } from '@/lib/wallet/signatureQueue';
import { ARCFLARE_ESCROW_CONTRACT_ADDRESS, ARC_TESTNET_CHAIN_ID, escrowAbi } from '@/lib/wallet/flarehqContracts';
import { readContractReliable } from '@/lib/wallet/chainClient';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import type { Hash } from 'viem';

const ESCROW_CONTRACT = process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || ARCFLARE_ESCROW_CONTRACT_ADDRESS || '';

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForCircleTx(
  client: ReturnType<typeof getCircleClient>,
  txId: string,
  label: string
): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    const state = data?.transaction?.state;
    if (state === 'COMPLETE' && data?.transaction?.txHash) {
      return data.transaction.txHash;
    }
    if (state === 'FAILED') {
      console.error(`❌ [${label}] Circle tx FAILED — full transaction object:`, JSON.stringify(data?.transaction, null, 2));
      throw new Error(
        `${label} transaction failed onchain.` +
        (data?.transaction?.errorReason ? ` Reason: ${data.transaction.errorReason}` : '')
      );
    }
    console.log(`⏳ [${label}] tx polling... attempt ${i + 1}, state=${state}`);
  }
  throw new Error(`${label} transaction timed out.`);
}

async function releaseHandler(request: NextRequest) {
  try {
    const { reference, callerSCA } = await request.json();

    if (!reference || !callerSCA) {
      return NextResponse.json(
        { success: false, error: 'reference and callerSCA are required.' },
        { status: 400 }
      );
    }

    const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
    if (!escrow) {
      return NextResponse.json({ success: false, error: 'Escrow not found.' }, { status: 404 });
    }
    if (escrow.status !== 'ACTIVE') {
      return NextResponse.json(
        { success: false, error: `Escrow is ${escrow.status} — cannot release.` },
        { status: 400 }
      );
    }
    if (!escrow.contractEscrowId) {
      return NextResponse.json(
        { success: false, error: 'This escrow has no contractEscrowId recorded — it may predate the FlareHQEscrow migration and cannot be confirmed onchain.' },
        { status: 400 }
      );
    }

    // ── Party membership check FIRST, before any execution ────────────────
    const isDepositor = callerSCA.toLowerCase() === escrow.depositorSCA.toLowerCase();
    const isBeneficiary = callerSCA.toLowerCase() === escrow.beneficiarySCA.toLowerCase();
    if (!isDepositor && !isBeneficiary) {
      return NextResponse.json(
        { success: false, error: 'callerSCA is not a party to this escrow.' },
        { status: 403 }
      );
    }

    // ── Ownership check SECOND, also before any execution ──────────────────
    // Proves the authenticated caller actually controls callerSCA — this is
    // the check that was missing entirely before.
    const actor = await verifyCallerControlsAddress(request, callerSCA);
    if (!actor) {
      return NextResponse.json(
        { success: false, error: 'You do not control the wallet named in callerSCA.' },
        { status: 403 }
      );
    }

    // ── Execute confirmDelivery(bytes32) ────────────────────────────────────
    let txHash: string;
    if (actor.type === 'merchant') {
      const walletProvider = await resolveWalletProvider(actor.id);
      if (walletProvider.kind !== "CIRCLE") {
        // External wallet: queue a TRANSACTION request. The merchant's wallet
        // broadcasts confirmDelivery(contractEscrowId) directly; the server
        // verifies the receipt + on-chain state before marking anything.
        const req = await queueTransactionRequest({
          merchantId: actor.id,
          action: TX_ACTIONS.escrowRelease,
          actionRefId: reference,
          payload: {
            kind: "transaction",
            reference,
            contractEscrowId: escrow.contractEscrowId,
            contractAddress: ESCROW_CONTRACT,
            callerSCA,
            amount: escrow.amount,
            beneficiarySCA: escrow.beneficiarySCA,
            transaction: {
              description: `Confirm delivery of escrow ${reference}`,
              chainId: ARC_TESTNET_CHAIN_ID,
              to: ESCROW_CONTRACT,
              from: callerSCA,
              abiFunctionSignature: 'confirmDelivery(bytes32)',
              args: [escrow.contractEscrowId],
              value: '0',
            },
          },
        });
        return NextResponse.json({
          success: true,
          pendingSignature: true,
          requestId: req.id,
          transaction: req.payload?.transaction ?? null,
          message: 'Your wallet needs to broadcast the confirmation transaction — approve it in your wallet, then the server verifies the on-chain receipt.',
        });
      }
      const result = await walletProvider.executeContract({
        contractAddress: ESCROW_CONTRACT,
        abiFunctionSignature: 'confirmDelivery(bytes32)',
        args: [escrow.contractEscrowId],
      });
      if (result.status === 'failed') {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 });
      }
      if (result.status === 'pending_signature') {
        return NextResponse.json({
          success: true,
          pendingSignature: true,
          requestId: result.requestId,
          message: 'Your wallet needs to approve this confirmation — check /api/merchant/wallet/sign-requests.',
        });
      }
      txHash = result.txHash;
    } else {
      // Consumer or agent parties — these actor types don't have the
      // Circle-vs-external abstraction (ConsumerAccount/AgentRegistry are
      // Circle-only in this codebase today, by existing design, not a gap
      // introduced here), so this stays a direct Circle execution — now
      // gated by the ownership check above, which is the actual fix.
      const circleClient = getCircleClient();
      const confirmTx = await circleClient.createContractExecutionTransaction({
        walletAddress: callerSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: ESCROW_CONTRACT,
        abiFunctionSignature: 'confirmDelivery(bytes32)',
        abiParameters: [escrow.contractEscrowId],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });
      if (!confirmTx.data?.id) throw new Error('Confirm tx returned no ID.');
      txHash = await waitForCircleTx(circleClient, confirmTx.data.id, 'Release/confirm');
    }
    console.log(`✅ Delivery confirmed by ${callerSCA} (verified ${actor.type} ${actor.id}). Tx: ${txHash}`);

    // ── AUTHORITATIVE STATE: never derive confirmation/RELEASED from the
    // request body + receipt success alone. Re-read getEscrow() on-chain and
    // mirror the contract — one-sided-confirmed stays ACTIVE with that side's
    // flag; the dual-confirm auto-release becomes RELEASED. The contract is
    // the single source of truth for which party has actually confirmed.
    let onChain = await readContractReliable({
      address: ESCROW_CONTRACT,
      abi: escrowAbi,
      functionName: 'getEscrow',
      args: [escrow.contractEscrowId as Hash],
    });
    let depositorConfirmed = escrow.depositorConfirmed || isDepositor;
    let beneficiaryConfirmed = escrow.beneficiaryConfirmed || isBeneficiary;
    if (onChain) {
      const s = onChain as any;
      const depConfirmed = typeof s.depositorConfirmed === 'boolean' ? s.depositorConfirmed : s[5];
      const benConfirmed = typeof s.beneficiaryConfirmed === 'boolean' ? s.beneficiaryConfirmed : s[6];
      depositorConfirmed = Boolean(depConfirmed);
      beneficiaryConfirmed = Boolean(benConfirmed);
    } else {
      // Node couldn't serve the state read — fail closed instead of trusting
      // the body: the DB flags must never advance past what the contract
      // provably holds.
      return NextResponse.json(
        { success: false, error: 'Could not read the on-chain escrow state after confirmation — no state change was recorded. Try again shortly.' },
        { status: 500 }
      );
    }

    let newStatus = escrow.status;
    if (depositorConfirmed && beneficiaryConfirmed) {
      newStatus = 'RELEASED';
    }

    const updated = await (prisma as any).escrow.update({
      where: { reference },
      data: {
        status: newStatus,
        depositorConfirmed,
        beneficiaryConfirmed,
        releaseTxHash: newStatus === 'RELEASED' ? txHash : null,
      },
    });

    // Build 5 repair (D8): when the escrow is fully released, the depositor's
    // locked funds leave the contract (to the beneficiary) — release the
    // JOB_ESCROW_LOCK taken at deposit so escrowLocked returns to zero. This is
    // not revenue for the depositor.
    if (newStatus === 'RELEASED') {
      try {
        const { recordLedgerEntry, resolveAgentIdBySca } = await import("@/lib/ledger/ledgerService");
        const agentId = await resolveAgentIdBySca(escrow.depositorSCA).catch(() => null);
        if (agentId && txHash) {
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

    if (newStatus === 'RELEASED' && escrow.webhookUrl) {
      fetch(escrow.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'escrow.released',
          reference,
          amount: escrow.amount,
          currency: escrow.currency,
          beneficiary: escrow.beneficiarySCA,
          txHash,
          releasedAt: new Date().toISOString(),
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        }),
      }).catch(() => { });
    }

    return NextResponse.json({
      success: true,
      escrow: updated,
      txHash,
      released: newStatus === 'RELEASED',
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message:
        newStatus === 'RELEASED'
          ? `Escrow fully released — ${escrow.amount} USDC sent to ${escrow.beneficiarySCA}`
          : `Delivery confirmed by ${isDepositor ? 'depositor' : 'beneficiary'} — waiting for other party.`,
    });
  } catch (error: any) {
    console.error('Escrow release error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = releaseHandler;