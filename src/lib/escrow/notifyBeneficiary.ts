// src/lib/escrow/notifyBeneficiary.ts
//
// Best-effort, idempotent beneficiary notification at escrow creation.
//
//   merchant  → central notify() dispatcher (in-app + email + webhook per the
//               beneficiary merchant's own preferences).
//   consumer  → Telegram DM when ConsumerAccount.telegramUserId is present
//               (reuses sendTelegramMessage).
//   agent     → the agent's OWNER merchant is the acting party; notify() them.
//   external  → no direct channel — the depositor already received the
//               shareable confirm link in the create response.
//
// NEVER fails the creation flow: any transport error is caught and logged.
// Idempotent via Escrow.beneficiaryNotifiedAt — a second call for the same
// escrow does nothing.

import { prisma } from "@/lib/prisma";
import { notify } from "@/lib/notifications";
import { sendTelegramMessage } from "@/lib/telegram/sendTelegramMessage";
import { beneficiaryConfirmUrl, ResolvedBeneficiary } from "@/lib/escrow/resolveBeneficiary";

export async function notifyBeneficiary(input: {
  reference: string;
  beneficiary: ResolvedBeneficiary;
  amount: number;
  currency: string;
}): Promise<{ notified: boolean; channel?: string; reason?: string }> {
  const { reference, beneficiary, amount, currency } = input;

  // Idempotency gate — read current state first so a crash between update and
  // this check can't double-notify (the timestamp is the guard, written last).
  try {
    const row = await (prisma as any).escrow.findUnique({
      where: { reference },
      select: { beneficiaryNotifiedAt: true },
    });
    if (row?.beneficiaryNotifiedAt) {
      return { notified: false, reason: "already-notified" };
    }
  } catch {
    // DB hiccup — proceed to attempt; the timestamp still guards duplicates.
  }

  const amountLabel = `${amount} ${currency}`;
  const base = `You are the beneficiary of escrow ${reference} for ${amountLabel} on Arc Testnet.`;

  try {
    switch (beneficiary.kind) {
      case "merchant": {
        // FlareHQ merchant actor — central dispatcher fans out per their prefs.
        await notify({
          merchantId: beneficiary.actorId!,
          event: "escrow.incoming",
          title: "Incoming escrow",
          message: `${base} Confirm delivery in Escrow → Incoming.`,
          data: { reference, amount, currency, confirmUrl: beneficiaryConfirmUrl(reference) },
        });
        await markNotified(reference);
        return { notified: true, channel: "notify(merchant)" };
      }

      case "consumer": {
        const consumer = await (prisma as any).consumerAccount.findFirst({
          where: { id: beneficiary.actorId },
          select: { telegramUserId: true },
        });
        if (consumer?.telegramUserId) {
          await sendTelegramMessage(
            String(consumer.telegramUserId),
            `${base} Confirm delivery to release the funds: ${beneficiaryConfirmUrl(reference)}`
          );
        }
        await markNotified(reference);
        return { notified: true, channel: consumer?.telegramUserId ? "telegram" : "no-telegram" };
      }

      case "agent": {
        const agent = await (prisma as any).agentRegistry.findUnique({
          where: { id: Number(beneficiary.actorId) },
          select: { merchantId: true },
        });
        if (agent?.merchantId) {
          await notify({
            merchantId: agent.merchantId,
            event: "escrow.incoming",
            title: "Incoming escrow (your agent)",
            message: `${base} Your agent is the beneficiary — confirm delivery in Escrow → Incoming.`,
            data: { reference, amount, currency, confirmUrl: beneficiaryConfirmUrl(reference) },
          });
        }
        await markNotified(reference);
        return { notified: true, channel: "notify(owner)" };
      }

      case "external":
      default:
        // No direct channel — the depositor holds the shareable link. Mark
        // notified so the idempotency guard doesn't keep trying.
        await markNotified(reference);
        return { notified: true, channel: "link-shared" };
    }
  } catch (error: any) {
    // Best-effort: never fail the escrow creation because a notification
    // transport errored. The escrow is already created and funded on-chain.
    console.error(`[notifyBeneficiary] ${reference} failed:`, error?.message);
    return { notified: false, reason: error?.message || "transport-failed" };
  }
}

async function markNotified(reference: string): Promise<void> {
  await (prisma as any).escrow.update({
    where: { reference },
    data: { beneficiaryNotifiedAt: new Date() },
  });
}
