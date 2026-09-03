// src/lib/notifications.ts
//
// Central notification dispatcher. Every route that needs to tell a
// merchant something happened calls notify({...}) instead of firing its
// own ad-hoc webhook fetch (which is what escrow create/release/dispute
// were each doing separately before this). One call fans out to
// email / webhook / in-app based on that merchant's saved preferences.

import { prisma } from '@/src/lib/prisma';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'FlareHQ <onboarding@resend.dev>';

// ── Event registry ──────────────────────────────────────────────────────
// Single source of truth for every notifiable event. The settings UI reads
// this list to render toggles, so adding a new event here automatically
// makes it appear in Settings — no separate UI update needed.
export const NOTIFICATION_EVENTS = {
    'payment.received': {
        label: 'Payment received',
        description: 'A customer completed a checkout payment.',
    },
    'escrow.funded': {
        label: 'Escrow funded',
        description: 'USDC was locked into a new escrow.',
    },
    'escrow.incoming': {
        label: 'Incoming escrow',
        description: 'You (or one of your agents) are the beneficiary of a new escrow.',
    },
    'escrow.released': {
        label: 'Escrow released',
        description: 'An escrow fully released funds to the beneficiary.',
    },
    'refund.completed': {
        label: 'Refund completed',
        description: 'An escrow or payment was refunded to the depositor/payer.',
    },
    'dispute.opened': {
        label: 'Dispute opened',
        description: 'A party raised a dispute on an active escrow.',
    },
    'dispute.resolved': {
        label: 'Dispute resolved',
        description: 'An admin resolved a disputed escrow.',
    },
    'agent.budget_exceeded': {
        label: 'Agent exceeds budget',
        description: 'An AI agent attempted spend beyond its configured monthly budget.',
    },
    'cctp.transfer_completed': {
        label: 'CCTP transfer completed',
        description: 'A cross-chain USDC bridge into Arc finished successfully.',
    },
    // SUBTASK D (minimal additive use): validator-side fan-out for
    // ERC-8004 validation requests, sent via notifyValidator.ts AFTER the
    // on-chain validationRequest succeeds. No other route uses this event.
    'validation.requested': {
        label: 'Validation requested',
        description: 'You (or your agent) were selected as validator for an agent validation request.',
    },
} as const;

export type NotificationEventType = keyof typeof NOTIFICATION_EVENTS;

interface NotifyParams {
    merchantId: string;
    event: NotificationEventType;
    title: string;
    message: string;
    data?: Record<string, unknown>;
    // Optional per-call webhook override (e.g. a specific escrow's saved
    // webhookUrl) — takes priority over the merchant's default preference.webhookUrl.
    webhookUrlOverride?: string | null;
}

async function getOrCreatePreference(merchantId: string) {
    const existing = await (prisma as any).notificationPreference.findUnique({ where: { merchantId } });
    if (existing) return existing;
    // Defaults: email + in-app ON, webhook OFF until a merchant sets a URL.
    return (prisma as any).notificationPreference.create({
        data: { merchantId, emailEnabled: true, webhookEnabled: false, inAppEnabled: true, mutedEvents: [] },
    });
}

async function sendNotificationEmail(toEmail: string, title: string, message: string) {
    try {
        await resend.emails.send({
            from: FROM_EMAIL,
            to: toEmail,
            subject: title,
            html: `
        <div style="font-family: Inter, system-ui, sans-serif; background:#0e0b08; color:#f0ece6; padding:32px; border-radius:16px; max-width:480px; margin:0 auto;">
          <h2 style="margin:0 0 12px;">${title}</h2>
          <p style="color:#c8bba8; font-size:14px; line-height:1.5;">${message}</p>
          <p style="color:#6b5a45; font-size:11px; margin-top:24px;">Manage which notifications you receive in your FlareHQ dashboard settings.</p>
        </div>
      `,
        });
    } catch (err) {
        // Notification failures should never break the calling route's main flow.
        console.error('[notifications] email send failed:', err);
    }
}

async function sendNotificationWebhook(url: string, event: NotificationEventType, title: string, message: string, data?: Record<string, unknown>) {
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event,
                title,
                message,
                data: data || {},
                sentAt: new Date().toISOString(),
            }),
        });
    } catch (err) {
        console.error('[notifications] webhook send failed:', err);
    }
}

/**
 * Fire a notification for `event` to `merchantId` across every channel
 * they've enabled, respecting per-event mute preferences. Never throws —
 * a notification failure should never break the caller's main flow (a
 * payment settling successfully matters more than the email about it).
 */
export async function notify({ merchantId, event, title, message, data, webhookUrlOverride }: NotifyParams) {
    try {
        const pref = await getOrCreatePreference(merchantId);

        if (pref.mutedEvents?.includes(event)) {
            return; // merchant explicitly opted out of this event entirely
        }

        const tasks: Promise<unknown>[] = [];

        if (pref.inAppEnabled) {
            tasks.push(
                (prisma as any).notification.create({
                    data: { merchantId, type: event, title, message, data: data || {} },
                })
            );
        }

        if (pref.emailEnabled) {
            const merchant = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { email: true } });
            if (merchant?.email) {
                tasks.push(sendNotificationEmail(merchant.email, title, message));
            }
        }

        if (pref.webhookEnabled) {
            const targetUrl = webhookUrlOverride || pref.webhookUrl;
            if (targetUrl) {
                tasks.push(sendNotificationWebhook(targetUrl, event, title, message, data));
            }
        }

        await Promise.allSettled(tasks);
    } catch (err) {
        console.error('[notifications] notify() failed:', err);
    }
}
