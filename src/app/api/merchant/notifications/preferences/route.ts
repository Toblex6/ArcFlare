// src/app/api/merchant/notifications/preferences/route.ts

import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { withMerchantAuth, AuthedMerchant } from '@/src/lib/middleware/withMerchantAuth';
import { NOTIFICATION_EVENTS } from '@/src/lib/notifications';

async function getHandler(request: Request, merchant: AuthedMerchant) {
    let pref = await (prisma as any).notificationPreference.findUnique({ where: { merchantId: merchant.id } });
    if (!pref) {
        pref = await (prisma as any).notificationPreference.create({
            data: { merchantId: merchant.id, emailEnabled: true, webhookEnabled: false, inAppEnabled: true, mutedEvents: [] },
        });
    }
    return NextResponse.json({
        success: true,
        preferences: pref,
        availableEvents: NOTIFICATION_EVENTS,
    });
}

async function putHandler(request: Request, merchant: AuthedMerchant) {
    try {
        const { emailEnabled, webhookEnabled, inAppEnabled, webhookUrl, mutedEvents } = await request.json();

        const validEventKeys = Object.keys(NOTIFICATION_EVENTS);
        if (mutedEvents && !Array.isArray(mutedEvents)) {
            return NextResponse.json({ success: false, error: 'mutedEvents must be an array.' }, { status: 400 });
        }
        if (mutedEvents && mutedEvents.some((e: string) => !validEventKeys.includes(e))) {
            return NextResponse.json({ success: false, error: 'mutedEvents contains an unknown event type.' }, { status: 400 });
        }
        if (webhookEnabled && !webhookUrl) {
            return NextResponse.json({ success: false, error: 'webhookUrl is required when webhookEnabled is true.' }, { status: 400 });
        }

        const updated = await (prisma as any).notificationPreference.upsert({
            where: { merchantId: merchant.id },
            update: {
                ...(emailEnabled !== undefined && { emailEnabled }),
                ...(webhookEnabled !== undefined && { webhookEnabled }),
                ...(inAppEnabled !== undefined && { inAppEnabled }),
                ...(webhookUrl !== undefined && { webhookUrl }),
                ...(mutedEvents !== undefined && { mutedEvents }),
            },
            create: {
                merchantId: merchant.id,
                emailEnabled: emailEnabled ?? true,
                webhookEnabled: webhookEnabled ?? false,
                inAppEnabled: inAppEnabled ?? true,
                webhookUrl: webhookUrl ?? null,
                mutedEvents: mutedEvents ?? [],
            },
        });

        return NextResponse.json({ success: true, preferences: updated });
    } catch (error: any) {
        console.error('Notification preferences update error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export const GET = withMerchantAuth(getHandler as any);
export const PUT = withMerchantAuth(putHandler as any);
