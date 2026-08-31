// src/app/api/escrow/link/[reference]/fund/route.ts
// PUBLIC funding-recording endpoint for escrow request links. The outsider
// pays DIRECTLY from their own external wallet on-chain (approve +
// createEscrow, mirrored from CheckoutWidget's external-wallet pattern) —
// this route never moves funds and never touches Circle. It only VERIFIES
// the outsider's on-chain transaction and flips the PENDING_FUNDING Escrow
// row to ACTIVE so release/dispute/refund operate on it normally.
//
// Trust model = Checkout's: the server re-reads the chain and refuses
// anything that doesn't actually hit the escrow contract with success.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkRateLimit } from '@/lib/ratelimit';
import { isAddress, createPublicClient, http } from 'viem';
import { arcTestnet } from '@/lib/wagmi';

const RPC_URL = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';

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
    if (!escrow.contractAddress) {
      return NextResponse.json({ success: false, error: 'Escrow contract address is not configured.' }, { status: 500 });
    }

    // ── On-chain verification (same shape as /api/payments/verify-onchain) ──
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null);
    if (!receipt) {
      return NextResponse.json({ success: false, error: 'Transaction not found or not yet confirmed. Try again shortly.' }, { status: 404 });
    }
    if (receipt.status !== 'success') {
      return NextResponse.json({ success: false, error: 'Transaction reverted on-chain.' }, { status: 400 });
    }
    if (receipt.to?.toLowerCase() !== escrow.contractAddress.toLowerCase()) {
      return NextResponse.json({ success: false, error: 'Transaction was not sent to the escrow contract.' }, { status: 400 });
    }
    if (receipt.from.toLowerCase() !== depositorSCA.toLowerCase()) {
      return NextResponse.json({ success: false, error: 'Transaction sender does not match depositorSCA.' }, { status: 400 });
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
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message: `Escrow funded. ${escrow.amount} USDC is now locked on Arc Testnet for ${escrow.beneficiarySCA}.`,
    });
  } catch (error: any) {
    console.error('Escrow link fund error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}
