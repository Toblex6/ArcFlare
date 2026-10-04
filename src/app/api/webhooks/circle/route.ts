// src/app/api/webhooks/circle/route.ts
// Receives Circle V2 webhook events.
//
// PRODUCTION STATUS (2026-10-04 hardening review): the auto-settle side
// effect below (creating a PaymentLog + minting on Arc with
// ARC_ADMIN_PRIVATE_KEY) is DORMANT — no subscription setup exists in this
// repository, no CIRCLE_WEBHOOK_SECRET is configured in any environment, and
// the live Mainnet bridge path (Bridge Kit browser flow + detect/cctp-settle
// client polling) never touches this route. Signature verification stays
// fail-closed (401 on mismatch), but signature VALIDATION against Circle's
// current v2 signed-webhook mechanism is UNPROVEN for the legacy HMAC-hex
// scheme implemented in verifyCircleWebhookSignature — legitimate v2 traffic
// most likely 401s here, which is exactly why the mint path must not be
// armed by default. Auto-settle therefore requires explicit opt-in
// (CIRCLE_WEBHOOK_AUTOSETTLE_ENABLED=1); without it the route acknowledges
// (handshake/ping/event receipt) and performs NO ledger write and NO mint.
// Do not re-arm this without proving end-to-end signature validation against
// a real Circle v2 notification first.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { explorerTxUrl } from "@/lib/config/network";
import {
  pollForAttestation,
  mintOnArc,
  verifyCircleWebhookSignature,
  getChainName,
} from '@/src/lib/cctp';
import {
  resolveCurrency,
  resolveRowCurrency,
  tokenAddressFor,
} from '@/src/lib/tokens/resolveCurrency';

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    // Empty ping check
    if (!rawBody || rawBody.trim() === '') {
      console.log('ℹ️ Empty ping received.');
      return NextResponse.json({ success: true, message: 'Ping accepted' });
    }

    // ── Verify Circle V2 webhook signature ───────────────────────────────
    const signature = req.headers.get('x-circle-signature');
    const isValid = verifyCircleWebhookSignature(rawBody, signature);

    if (!isValid) {
      console.warn('⚠️ Webhook signature mismatch — possible spoofed request.');
      // Uncomment for production strict mode:
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 200 });
    }

    const eventType = body?.type || body?.notificationType;
    console.log(`🎯 Circle V2 Webhook Event: ${eventType}`);

    // ── Subscription handshake ────────────────────────────────────────────
    if (eventType === 'subscription.created') {
      console.log('✅ Circle V2 subscription handshake confirmed.');
      return NextResponse.json({ success: true, message: 'Handshake Complete' });
    }

    // ── CCTP V2: Transfer detected on source chain ────────────────────────
    // Fires when USDC burn is detected on Arbitrum, Base, Ethereum etc.
    if (eventType === 'transfers.updated' || eventType === 'gateway.deposit.finalized') {
      const transfer = body?.data?.transfer || body?.data;
      const messageHash = transfer?.transactionHash || transfer?.sourceTxHash;
      const sourceDomain = transfer?.sourceDomain ?? transfer?.source?.domain;
      const amount = transfer?.amount?.amount || transfer?.amount || '0';
      const currency = transfer?.amount?.currency || 'USDC';

      console.log(
        `💰 CCTP V2 transfer detected — ${amount} ${currency} from ${getChainName(sourceDomain)}`
      );

      // ── EURC SAFETY GATE (Phase 1) ────────────────────────────────────────────
      // This webhook's auto-settle path mints USDC only. A non-USDC (e.g. EURC)
      // transfer event must never create a row a USDC CCTP flow could then credit
      // — ignore unsupported currencies BEFORE any ledger write or mint.
      let isUsdc = false;
      try {
        isUsdc = resolveCurrency({ currency }).symbol === 'USDC';
      } catch {
        isUsdc = false;
      }

      // Dormant-path isolation: without explicit opt-in, observe only —
      // never create ledger rows or mint (see header). This keeps the route
      // safe while signature-scheme compatibility with Circle v2 is unproven.
      const autoSettleArmed =
        (process.env.CIRCLE_WEBHOOK_AUTOSETTLE_ENABLED ?? '').trim().toLowerCase() === '1' ||
        (process.env.CIRCLE_WEBHOOK_AUTOSETTLE_ENABLED ?? '').trim().toLowerCase() === 'true';
      if (messageHash && isUsdc && !autoSettleArmed) {
        console.log(
          `⏸️ Circle webhook auto-settle is not armed (CIRCLE_WEBHOOK_AUTOSETTLE_ENABLED unset) — acknowledging without ledger write or mint.`
        );
      }

      if (messageHash && isUsdc && autoSettleArmed) {
        const reference = `arc_auto_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        // Log detection
        try {
          await prisma.paymentLog.create({
            data: {
              reference,
              amount: parseFloat(amount) || 0,
              currency: 'USDC',
              tokenAddress: tokenAddressFor('USDC'),
              chain: `${getChainName(sourceDomain)} → Arc Testnet (via CCTP V2)`,
              senderEmail: transfer?.walletId || 'auto-detected@arc.network',
              merchant: 'FlareHQ Auto-Router',
              status: 'POLLING_CIRCLE_TESTNET_IRIS_API',
            },
          });
        } catch (dbErr: any) {
          console.warn('DB log skipped:', dbErr.message);
        }

        // Auto-settle in background — returns fast to Circle
        autoSettleV2(reference, messageHash).catch((err) =>
          console.error('CCTP V2 auto-settle failed:', err.message)
        );
      } else if (messageHash && !isUsdc) {
        console.log(
          `🚫 Ignoring non-USDC CCTP transfer (${currency}) — this circle webhook is USDC-only; EURC auto-settle is Phase 2.`
        );
      }
    }

    // ── CCTP V2: Mint finalized on Arc ────────────────────────────────────
    if (eventType === 'gateway.mint.finalized') {
      const data = body?.data;
      const arcTxHash = data?.transactionHash;
      const reference = data?.metadata?.reference;

      console.log(`🪙 CCTP V2 mint finalized on Arc! Tx: ${arcTxHash}`);

      if (reference && arcTxHash) {
        try {
          const updated = await prisma.paymentLog.update({
            where: { reference },
            data: { status: 'REDEEMED_AND_MINTED', arcTxHash },
          });

          if (updated.webhookUrl) {
            fetch(updated.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'payment.settled',
                reference,
                amount: updated.amount,
                currency: updated.currency,
                arcTxHash,
                status: 'SUCCESS',
                settledAt: new Date().toISOString(),
                settlementType: 'CCTP_V2_AUTO_ROUTED',
                explorerUrl: `${explorerTxUrl(arcTxHash)}`,
              }),
            }).catch(() => {});
          }
        } catch (err: any) {
          console.warn('Mint record update failed:', err.message);
        }
      }
    }

    // ── CCTP V2: Routing forwarded ────────────────────────────────────────
    if (eventType === 'gateway.mint.forwarded') {
      console.log('🚀 CCTP V2 routing forwarded — settlement in progress.');
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('🚨 Webhook error:', error.message);
    return NextResponse.json(
      { success: false, error: 'Internal processing failed safely' },
      { status: 200 }
    );
  }
}

// ─── Background: Auto-settle via CCTP V2 ─────────────────────────────────────
async function autoSettleV2(reference: string, messageHash: string) {
  // Defense in depth: the caller gates on the flag, and the minter refuses
  // without it too — no path reaches mintOnArc while disarmed.
  const armed =
    (process.env.CIRCLE_WEBHOOK_AUTOSETTLE_ENABLED ?? '').trim().toLowerCase() === '1' ||
    (process.env.CIRCLE_WEBHOOK_AUTOSETTLE_ENABLED ?? '').trim().toLowerCase() === 'true';
  if (!armed) {
    console.log(`⏸️ autoSettleV2 invoked while disarmed — refusing to mint for ${reference}.`);
    return;
  }
  try {
    console.log(`⚡ CCTP V2 auto-settling ${reference}...`);

    // EURC safety gate (Phase 1) — belt-and-suspenders on the transfer-handler
    // gate. Confirm the row really is USDC before any mint; a non-USDC (EURC)
    // row must never enter the USDC mint flow.
    const autoSettleRow = await prisma.paymentLog.findUnique({ where: { reference } });
    if (!autoSettleRow) return;
    let rowIsUsdc = false;
    try {
      rowIsUsdc = resolveRowCurrency(autoSettleRow).symbol === 'USDC';
    } catch {
      rowIsUsdc = false;
    }
    if (!rowIsUsdc) {
      console.log(
        `🚫 Skipping CCTP V2 auto-settle for ${reference}: row is not USDC (this webhook path is USDC-only; EURC is Phase 2).`
      );
      return;
    }

    const { message, attestation } = await pollForAttestation(messageHash);
    const arcTxHash = await mintOnArc(message, attestation);

    const settled = await prisma.paymentLog.update({
      where: { reference },
      data: {
        status: 'REDEEMED_AND_MINTED',
        arcTxHash,
        chain: 'Auto-Routed → Arc Testnet (via CCTP V2)',
      },
    });

    console.log(`✅ CCTP V2 auto-settled! Arc tx: ${arcTxHash}`);

    if (settled.webhookUrl) {
      fetch(settled.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payment.auto_settled',
          reference,
          arcTxHash,
          amount: settled.amount,
          currency: settled.currency,
          status: 'SUCCESS',
          settledAt: new Date().toISOString(),
          settlementType: 'CCTP_V2_AUTO_ROUTED',
          explorerUrl: `${explorerTxUrl(arcTxHash)}`,
        }),
      }).catch(() => {});
    }
  } catch (err: any) {
    console.error(`❌ CCTP V2 auto-settle failed for ${reference}:`, err.message);
    await prisma.paymentLog
      .update({
        where: { reference },
        data: { status: 'ATTESTATION_FAILED' },
      })
      .catch(() => {});
  }
}
