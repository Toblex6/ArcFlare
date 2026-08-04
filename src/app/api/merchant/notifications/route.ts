// src/app/api/merchant/notifications/route.ts
// List in-app notifications, and mark one or all as read.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { withMerchantAuth, AuthedMerchant } from '@/src/lib/middleware/withMerchantAuth';

async function getHandler(request: NextRequest, merchant: AuthedMerchant) {
    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get('unread') === 'true';
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);

    const notifications = await (prisma as any).notification.findMany({
        where: { merchantId: merchant.id, ...(unreadOnly ? { read: false } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limit,
    });

    const unreadCount = await (prisma as any).notification.count({
        where: { merchantId: merchant.id, read: false },
    });

    return NextResponse.json({ success: true, notifications, unreadCount });
}

async function patchHandler(request: NextRequest, merchant: AuthedMerchant) {
    try {
        const { id, markAllRead } = await request.json();

        if (markAllRead) {
            await (prisma as any).notification.updateMany({
                where: { merchantId: merchant.id, read: false },
                data: { read: true },
            });
            return NextResponse.json({ success: true, message: 'All notifications marked as read.' });
        }

        if (!id) {
            return NextResponse.json({ success: false, error: 'id or markAllRead is required.' }, { status: 400 });
        }

        // Scope the update to this merchant so one merchant can't mark another's notification read.
        const result = await (prisma as any).notification.updateMany({
            where: { id, merchantId: merchant.id },
            data: { read: true },
        });

        if (result.count === 0) {
            return NextResponse.json({ success: false, error: 'Notification not found.' }, { status: 404 });
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export const GET = withMerchantAuth(getHandler as any);
export const PATCH = withMerchantAuth(patchHandler as any);
