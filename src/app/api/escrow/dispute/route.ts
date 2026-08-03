// src/app/api/escrow/dispute/route.ts
// Raises a dispute on an active escrow.
// Admin can then resolve via resolveDispute on the contract.
//
// AUTH: switched from withApiKey to withMerchantAuth — see release/route.ts
// comment for why (dashboard session cookie, no x-api-key header sent).

import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { withMerchantAuth, AuthedMerchant } from '@/src/lib/middleware/withMerchantAuth';
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
    if (state === 'COMPLETE' && data.transaction?.txHash) {
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

async function disputeHandler(request: Request, merchant: AuthedMerchant) {
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

    const disputeReason = reason || 'No reason provided';
    const circleClient = getCircleClient();

    // Call dispute(bytes32 id, string reason) on the escrow contract.
    const disputeTx = await circleClient.createContractExecutionTransaction({
      walletAddress: callerSCA,
      blockchain: 'ARC-TESTNET' as any,
      contractAddress: ESCROW_CONTRACT,
      abiFunctionSignature: 'dispute(bytes32,string)',
      abiParameters: [escrow.contractEscrowId, disputeReason],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    if (!disputeTx.data?.id) throw new Error('Dispute tx returned no ID.');
    const txHash = await waitForCircleTx(circleClient, disputeTx.data.id, 'Dispute');

    const updated = await (prisma as any).escrow.update({
      where: { reference },
      data: {
        status: 'DISPUTED',
        disputeReason,
        disputeTxHash: txHash,
        disputedBy: callerSCA,
      },
    });

    // Notify admin webhook if set
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

export const POST = withMerchantAuth(disputeHandler as any);