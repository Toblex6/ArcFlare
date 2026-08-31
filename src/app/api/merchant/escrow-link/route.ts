// src/app/api/merchant/escrow-link/route.ts
// Authenticated merchants create shareable ESCROW REQUEST links.
//
// Same shape/pattern as merchant/payment-link/route.ts: the merchant is the
// only authenticated party; the OUTSIDER who funds the escrow never touches
// FlareHQ auth and pays from their own external wallet on-chain via the
// /escrow-pay/[reference] page. Release/dispute/refund are UNCHANGED — they
// still operate on the same Escrow row once it exists and is ACTIVE.
//
// This deliberately does NOT touch escrow/create (merchant-to-merchant,
// Circle-custodial depositor) or verifyCallerControlsAddress anywhere.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { jwtVerify } from 'jose';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { tryJwtSecret } from '@/src/lib/auth/secrets';
import { keccak256, toBytes, isAddress } from 'viem';

const JWT_SECRET = tryJwtSecret('MERCHANT_JWT_SECRET');

// Pre-funding sentinel: the Escrow model requires depositorSCA, but an
// unfunded escrow-request link has no depositor yet. Replaced with the real
// outsider wallet by /api/escrow/link/[reference]/fund after the on-chain
// transaction verifies. Zero address can never be a real depositor.
const UNFUNDED_DEPOSITOR = '0x0000000000000000000000000000000000000000';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse;

    const token = req.cookies.get('merchant_token')?.value;
    if (!token || !JWT_SECRET) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;

    const merchant = await (prisma as any).merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      return NextResponse.json({ success: false, error: 'Merchant not found.' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const { beneficiarySCA, amount, deadlineHours, condition } = body;

    if (!beneficiarySCA || !isAddress(beneficiarySCA)) {
      return NextResponse.json({ success: false, error: 'Valid beneficiarySCA (0x…) is required.' }, { status: 400 });
    }
    const amountFloat = parseFloat(amount);
    if (!amountFloat || isNaN(amountFloat) || amountFloat <= 0) {
      return NextResponse.json({ success: false, error: 'Valid amount is required.' }, { status: 400 });
    }
    const hours = deadlineHours === undefined ? 24 : parseFloat(deadlineHours);
    if (isNaN(hours) || hours <= 0 || hours > 24 * 30) {
      return NextResponse.json({ success: false, error: 'deadlineHours must be between 0 and 720.' }, { status: 400 });
    }

    const reference = `escrow_link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const deadlineDate = new Date(Date.now() + hours * 3600 * 1000);

    // Same deterministic onchainId derivation as escrow/create — the funding
    // page computes the same keccak256(reference) locally, so the on-chain
    // createEscrow call and this DB row agree without any server round-trip.
    const onchainId = keccak256(toBytes(reference));

    const escrowRecord = await prisma.escrow.create({
      data: {
        reference,
        contractEscrowId: onchainId,
        amount: amountFloat,
        currency: 'USDC',
        depositorSCA: UNFUNDED_DEPOSITOR, // replaced when the outsider funds
        beneficiarySCA,
        contractAddress: process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || '',
        status: 'PENDING_FUNDING',
        condition: condition || null,
        deadline: deadlineDate,
        merchantId: merchant.id,
      },
    });

    const escrowPayUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'https://flarehq.xyz'}/escrow-pay/${reference}`;

    return NextResponse.json({
      success: true,
      reference,
      escrowPayUrl,
      amount: amountFloat,
      currency: 'USDC',
      beneficiarySCA,
      condition: condition || null,
      deadline: deadlineDate.toISOString(),
      escrow: escrowRecord,
      expiresInHours: hours,
    });
  } catch (error: any) {
    console.error('Escrow link error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}

// List this merchant's escrow request links.
export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('merchant_token')?.value;
    if (!token || !JWT_SECRET) {
      return NextResponse.json({ success: false, error: 'Not authenticated.' }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;

    const escrows = await prisma.escrow.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return NextResponse.json({
      success: true,
      links: escrows.map((e) => ({
        reference: e.reference,
        amount: e.amount,
        currency: e.currency,
        status: e.status,
        depositorSCA: e.depositorSCA,
        beneficiarySCA: e.beneficiarySCA,
        escrowPayUrl: `${process.env.NEXT_PUBLIC_BASE_URL || 'https://flarehq.xyz'}/escrow-pay/${e.reference}`,
        createdAt: e.createdAt,
      })),
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid session.' }, { status: 401 });
  }
}
