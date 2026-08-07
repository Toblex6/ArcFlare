// src/app/api/escrow/dispute/route.ts
// Raises a dispute on an active escrow.
// Admin can then resolve via resolveDispute on the contract.
//
// SECURITY FIX: same as release/route.ts — party membership was checked
// against our DB, but ownership of callerSCA itself was never verified,
// meaning a merchant could name another party's SCA and Circle would
// execute as them regardless of DB membership. Now verified via
// verifyCallerControlsAddress() before execution.

import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveWalletProvider } from '@/lib/wallet/resolve';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const ESCROW_CONTRACT = process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || '';

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

async function disputeHandler(request: NextRequest) {
  try {
    const { reference, callerSCA, reason } = await request.json();

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
        { success: false, error: `Escrow is ${escrow.status} — cannot dispute.` },
        { status: 400 }
      );
    }
    if (!escrow.contractEscrowId) {
      return NextResponse.json(
        { success: false, error: 'This escrow has no contractEscrowId recorded — it may predate the FlareHQEscrow migration and cannot be disputed onchain.' },
        { status: 400 }
      );
    }

    const isDepositor = callerSCA.toLowerCase() === escrow.depositorSCA.toLowerCase();
    const isBeneficiary = callerSCA.toLowerCase() === escrow.beneficiarySCA.toLowerCase();
    if (!isDepositor && !isBeneficiary) {
      return NextResponse.json(
        { success: false, error: 'callerSCA is not a party to this escrow.' },
        { status: 403 }
      );
    }

    const actor = await verifyCallerControlsAddress(request, callerSCA);
    if (!actor) {
      return NextResponse.json(
        { success: false, error: 'You do not control the wallet named in callerSCA.' },
        { status: 403 }
      );
    }

    const disputeReason = reason || 'No reason provided';

    let txHash: string;
    if (actor.type === 'merchant') {
      const walletProvider = await resolveWalletProvider(actor.id);
      const result = await walletProvider.executeContract({
        contractAddress: ESCROW_CONTRACT,
        abiFunctionSignature: 'dispute(bytes32,string)',
        args: [escrow.contractEscrowId, disputeReason],
      });
      if (result.status === 'failed') {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 });
      }
      if (result.status === 'pending_signature') {
        return NextResponse.json({
          success: true,
          pendingSignature: true,
          requestId: result.requestId,
          message: 'Your wallet needs to approve this dispute — check /api/merchant/wallet/sign-requests.',
        });
      }
      txHash = result.txHash;
    } else {
      const circleClient = getCircleClient();
      const disputeTx = await circleClient.createContractExecutionTransaction({
        walletAddress: callerSCA,
        blockchain: 'ARC-TESTNET' as any,
        contractAddress: ESCROW_CONTRACT,
        abiFunctionSignature: 'dispute(bytes32,string)',
        abiParameters: [escrow.contractEscrowId, disputeReason],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });
      if (!disputeTx.data?.id) throw new Error('Dispute tx returned no ID.');
      txHash = await waitForCircleTx(circleClient, disputeTx.data.id, 'Dispute');
    }

    const updated = await (prisma as any).escrow.update({
      where: { reference },
      data: {
        status: 'DISPUTED',
        disputeReason,
        disputeTxHash: txHash,
        disputedBy: callerSCA,
      },
    });

    if (escrow.webhookUrl) {
      fetch(escrow.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'escrow.disputed',
          reference,
          amount: escrow.amount,
          currency: escrow.currency,
          disputedBy: callerSCA,
          reason: disputeReason,
          txHash,
          disputedAt: new Date().toISOString(),
          explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
        }),
      }).catch(() => { });
    }

    return NextResponse.json({
      success: true,
      escrow: updated,
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message: 'Dispute raised. FlareHQ admin will review and resolve.',
    });
  } catch (error: any) {
    console.error('Escrow dispute error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = disputeHandler;