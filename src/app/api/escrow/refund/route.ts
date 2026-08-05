// src/app/api/escrow/refund/route.ts
// Exposes FlareHQEscrow's refundExpired(bytes32) — this function has
// existed on-chain since deployment but nothing called it. Depositor-only,
// only after the escrow's deadline has passed, only while status is ACTIVE
// (contract itself also enforces both of these — this route is UX/auth,
// not the source of truth for correctness).

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

async function waitForCircleTx(client: ReturnType<typeof getCircleClient>, txId: string): Promise<string> {
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const { data } = await client.getTransaction({ id: txId });
        const state = data?.transaction?.state;
        if (state === 'COMPLETE' && data.transaction?.txHash) return data.transaction.txHash;
        if (state === 'FAILED') {
            console.error('❌ [Refund] Circle tx FAILED — full transaction object:', JSON.stringify(data?.transaction, null, 2));
            throw new Error(`Refund transaction failed onchain.` + (data?.transaction?.errorReason ? ` Reason: ${data.transaction.errorReason}` : ''));
        }
        console.log(`⏳ [Refund] tx polling... attempt ${i + 1}, state=${state}`);
    }
    throw new Error('Refund transaction timed out.');
}

async function refundHandler(request: Request, merchant: AuthedMerchant) {
    try {
        const { reference, callerSCA } = await request.json();

        if (!reference || !callerSCA) {
            return NextResponse.json({ success: false, error: 'reference and callerSCA are required.' }, { status: 400 });
        }

        const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
        if (!escrow) {
            return NextResponse.json({ success: false, error: 'Escrow not found.' }, { status: 404 });
        }
        if (escrow.status !== 'ACTIVE') {
            return NextResponse.json({ success: false, error: `Escrow is ${escrow.status} — cannot refund.` }, { status: 400 });
        }
        if (!escrow.contractEscrowId) {
            return NextResponse.json({ success: false, error: 'This escrow has no contractEscrowId recorded and cannot be refunded onchain.' }, { status: 400 });
        }
        if (callerSCA.toLowerCase() !== escrow.depositorSCA.toLowerCase()) {
            return NextResponse.json({ success: false, error: 'Only the depositor can reclaim an expired escrow.' }, { status: 403 });
        }
        if (!escrow.deadline || new Date(escrow.deadline) > new Date()) {
            return NextResponse.json({ success: false, error: 'This escrow has not expired yet.' }, { status: 400 });
        }

        const circleClient = getCircleClient();

        const refundTx = await circleClient.createContractExecutionTransaction({
            walletAddress: callerSCA,
            blockchain: 'ARC-TESTNET' as any,
            contractAddress: ESCROW_CONTRACT,
            abiFunctionSignature: 'refundExpired(bytes32)',
            abiParameters: [escrow.contractEscrowId],
            fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        });

        if (!refundTx.data?.id) throw new Error('Refund tx returned no ID.');
        const txHash = await waitForCircleTx(circleClient, refundTx.data.id);
        console.log(`✅ Escrow refunded to depositor. Tx: ${txHash}`);

        const updated = await (prisma as any).escrow.update({
            where: { reference },
            data: { status: 'REFUNDED', releaseTxHash: txHash },
        });

        if (escrow.merchantId) {
            try {
                const { notify } = await import('@/lib/notifications');
                await notify({
                    merchantId: escrow.merchantId,
                    event: 'refund.completed',
                    title: 'Refund completed',
                    message: `${escrow.amount} USDC refunded to depositor after escrow ${reference} expired unconfirmed.`,
                    data: { reference, amount: escrow.amount, txHash },
                    webhookUrlOverride: escrow.webhookUrl,
                });
            } catch (err) {
                console.error('Refund notification failed (non-fatal):', err);
            }
        }

        return NextResponse.json({
            success: true,
            escrow: updated,
            txHash,
            explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
            message: `${escrow.amount} USDC refunded to depositor.`,
        });
    } catch (error: any) {
        console.error('Escrow refund error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export const POST = withMerchantAuth(refundHandler as any);