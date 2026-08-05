// src/app/api/admin/disputes/[reference]/resolve/route.ts
//
// Calls FlareHQEscrow.resolveDispute(bytes32,bool) directly. This is a
// DIFFERENT signing path than every other escrow route — those all go
// through Circle's developer-controlled wallets API. resolveDispute is
// gated by the contract's on-chain `admin` address, which is whichever
// wallet deployed the contract — almost certainly the one derived from
// ESCROW_ADMIN_PRIVATE_KEY  (the raw EOA private key next.config.mjs already
// prints the address of on boot). Circle's API can only sign for wallets
// IT manages, so this route uses viem directly against that raw key.
//
// If a different wallet actually deployed FlareHQEscrow, this will revert
// with "FlareHQ: caller is not admin" — check ESCROW_ADMIN_PRIVATE_KEY  matches
// the deployer if that happens.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { resolveAdminSession } from '@/src/lib/middleware/withAdminAuth';
import { createWalletClient, createPublicClient, http, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from '@/src/lib/wagmi';

const ESCROW_CONTRACT = process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || '';
const RPC_URL = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';

const RESOLVE_DISPUTE_ABI = parseAbiItem(
    'function resolveDispute(bytes32 id, bool releaseToBeneficiary) external'
);

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ reference: string }> }
) {
    const isAdmin = await resolveAdminSession(req);
    if (!isAdmin) {
        return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }

    try {
        const { reference } = await params;
        const { releaseToBeneficiary } = await req.json();

        if (typeof releaseToBeneficiary !== 'boolean') {
            return NextResponse.json({ success: false, error: 'releaseToBeneficiary (boolean) is required.' }, { status: 400 });
        }

        const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
        if (!escrow) {
            return NextResponse.json({ success: false, error: 'Escrow not found.' }, { status: 404 });
        }
        if (escrow.status !== 'DISPUTED') {
            return NextResponse.json({ success: false, error: `Escrow is ${escrow.status} — cannot resolve, must be DISPUTED.` }, { status: 400 });
        }
        if (!escrow.contractEscrowId) {
            return NextResponse.json({ success: false, error: 'This escrow has no contractEscrowId recorded.' }, { status: 400 });
        }
        if (!process.env.ESCROW_ADMIN_PRIVATE_KEY) {
            return NextResponse.json({ success: false, error: 'ESCROW_ADMIN_PRIVATE_KEY  is not configured on the server.' }, { status: 500 });
        }

        const account = privateKeyToAccount(process.env.ESCROW_ADMIN_PRIVATE_KEY as `0x${string}`);

        const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });
        const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL) });

        console.log(`⚖️ Resolving dispute for ${reference} — releaseToBeneficiary=${releaseToBeneficiary}, admin=${account.address}`);

        let txHash: `0x${string}`;
        try {
            txHash = await walletClient.writeContract({
                address: ESCROW_CONTRACT as `0x${string}`,
                abi: [RESOLVE_DISPUTE_ABI],
                functionName: 'resolveDispute',
                args: [escrow.contractEscrowId as `0x${string}`, releaseToBeneficiary],
            });
        } catch (err: any) {
            console.error('❌ resolveDispute onchain call failed:', err);
            const revertReason = err.shortMessage || err.message || 'Unknown revert reason.';
            throw new Error(
                `Onchain resolveDispute call failed: ${revertReason}` +
                (revertReason.includes('not admin') ? ' — ESCROW_ADMIN_PRIVATE_KEY  may not match the wallet that deployed FlareHQEscrow.sol.' : '')
            );
        }

        console.log(`⏳ Waiting for resolveDispute tx receipt: ${txHash}`);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== 'success') {
            throw new Error('resolveDispute transaction reverted onchain.');
        }
        console.log(`✅ Dispute resolved. Tx: ${txHash}`);

        const newStatus = releaseToBeneficiary ? 'RELEASED' : 'REFUNDED';
        const updated = await (prisma as any).escrow.update({
            where: { reference },
            data: {
                status: newStatus,
                ...(releaseToBeneficiary ? { releaseTxHash: txHash } : {}),
            },
        });

        if (escrow.merchantId) {
            try {
                const { notify } = await import('@/lib/notifications');
                await notify({
                    merchantId: escrow.merchantId,
                    event: 'dispute.resolved',
                    title: 'Dispute resolved',
                    message: releaseToBeneficiary
                        ? `Admin resolved the dispute on ${reference} in favor of the beneficiary — funds released.`
                        : `Admin resolved the dispute on ${reference} in favor of the depositor — funds refunded.`,
                    data: { reference, releaseToBeneficiary, txHash },
                    webhookUrlOverride: escrow.webhookUrl,
                });
            } catch (err) {
                console.error('Dispute-resolved notification failed (non-fatal):', err);
            }
        }

        return NextResponse.json({
            success: true,
            escrow: updated,
            txHash,
            explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
            message: releaseToBeneficiary
                ? `${escrow.amount} USDC released to beneficiary.`
                : `${escrow.amount} USDC refunded to depositor.`,
        });
    } catch (error: any) {
        console.error('Admin resolve dispute error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}