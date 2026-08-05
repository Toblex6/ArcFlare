// src/app/api/escrow/evidence/route.ts
// Lets either party on a DISPUTED escrow submit evidence for the admin to
// review. No on-chain interaction — this is purely off-chain record-keeping
// that the admin dispute view reads from.

import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { withMerchantAuth, AuthedMerchant } from '@/src/lib/middleware/withMerchantAuth';

async function postHandler(request: Request, merchant: AuthedMerchant) {
    try {
        const { reference, callerSCA, type, content } = await request.json();

        if (!reference || !callerSCA || !content) {
            return NextResponse.json({ success: false, error: 'reference, callerSCA, and content are required.' }, { status: 400 });
        }
        if (type && !['text', 'link'].includes(type)) {
            return NextResponse.json({ success: false, error: 'type must be "text" or "link".' }, { status: 400 });
        }
        if (content.length > 5000) {
            return NextResponse.json({ success: false, error: 'content is too long (max 5000 characters).' }, { status: 400 });
        }

        const escrow = await (prisma as any).escrow.findUnique({ where: { reference } });
        if (!escrow) {
            return NextResponse.json({ success: false, error: 'Escrow not found.' }, { status: 404 });
        }
        if (escrow.status !== 'DISPUTED') {
            return NextResponse.json({ success: false, error: 'Evidence can only be submitted on a disputed escrow.' }, { status: 400 });
        }

        const isDepositor = callerSCA.toLowerCase() === escrow.depositorSCA.toLowerCase();
        const isBeneficiary = callerSCA.toLowerCase() === escrow.beneficiarySCA.toLowerCase();
        if (!isDepositor && !isBeneficiary) {
            return NextResponse.json({ success: false, error: 'callerSCA is not a party to this escrow.' }, { status: 403 });
        }

        const evidence = await (prisma as any).disputeEvidence.create({
            data: {
                reference,
                submittedBy: callerSCA,
                role: isDepositor ? 'depositor' : 'beneficiary',
                type: type || 'text',
                content,
            },
        });

        return NextResponse.json({ success: true, evidence });
    } catch (error: any) {
        console.error('Evidence submission error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

// Parties can also read back what's been submitted on their own dispute.
async function getHandler(request: Request, merchant: AuthedMerchant) {
    const { searchParams } = new URL(request.url);
    const reference = searchParams.get('reference');
    if (!reference) {
        return NextResponse.json({ success: false, error: 'reference query param is required.' }, { status: 400 });
    }

    const evidence = await (prisma as any).disputeEvidence.findMany({
        where: { reference },
        orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({ success: true, evidence });
}

export const POST = withMerchantAuth(postHandler as any);
export const GET = withMerchantAuth(getHandler as any);