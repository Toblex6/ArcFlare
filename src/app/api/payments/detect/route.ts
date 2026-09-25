// src/app/api/payments/detect/route.ts
// Manually trigger CCTP V2 cross-chain detection for a specific burn tx hash.
// Used by agents self-reporting a burn tx or for manual testing.

import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { pollForAttestation, mintOnArc, getChainName } from '@/src/lib/cctp';
import { withApiKey } from '@/src/lib/middleware/withApiKey';
import { resolveCurrency, tokenAddressFor } from '@/src/lib/tokens/resolveCurrency';
import { explorerTxUrl } from "@/lib/config/network";

async function detectHandler(request: Request) {
  try {
    const { messageHash, amount, currency, sourceDomain, webhookUrl } = await request.json();

    if (!messageHash) {
      return NextResponse.json(
        {
          success: false,
          error:
            'messageHash is required — pass the keccak256 hash of the ' +
            'CCTP V2 MessageSent event bytes from the source chain burn tx.',
        },
        { status: 400 }
      );
    }

    // ── EURC SAFETY GATE (Phase 1) ────────────────────────────────────────────
    // This route's CCTP V2 mint is USDC-only. An EURC-labelled burn must never
    // be minted/credited as USDC — reject any non-USDC currency BEFORE any
    // ledger write or mint. Null/empty legacy input defaults to USDC.
    let detectCurrency: { symbol: 'USDC' | 'EURC' };
    try {
      detectCurrency = resolveCurrency({ currency: currency ?? 'USDC' });
    } catch {
      return NextResponse.json(
        {
          success: false,
          error:
            'Unsupported currency. This CCTP detect route is USDC-only; EURC settlement is coming in Phase 2.',
        },
        { status: 400 }
      );
    }
    if (detectCurrency.symbol !== 'USDC') {
      return NextResponse.json(
        {
          success: false,
          error:
            'EURC settlement is not yet supported. This CCTP detect route is USDC-only; EURC is coming in Phase 2.',
        },
        { status: 400 }
      );
    }

    const reference = `arc_detect_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const sourceChain = getChainName(sourceDomain ?? 3);

    // M2: shared amount validation (decimal string, ≤6 decimals, >0,
    // capped) — a zero/negative/malformed amount must never create a row.
    const amountStr = String(amount ?? "").trim();
    if (!/^\d+(\.\d{1,6})?$/.test(amountStr) || !Number.isFinite(parseFloat(amountStr)) || parseFloat(amountStr) <= 0 || parseFloat(amountStr) > 10_000_000) {
      return NextResponse.json(
        { success: false, error: 'amount must be a positive decimal (up to 6 decimals) not exceeding 10,000,000.' },
        { status: 400 }
      );
    }

    // M2: unique source-message claim at create time (cctpSourceTxHash is
    // @unique) — the same burn can never be detected twice. P2002 → 409.
    let created: any;
    try {
      created = await prisma.paymentLog.create({
        data: {
          reference,
          amount: parseFloat(amountStr),
          currency: detectCurrency.symbol,
          tokenAddress: tokenAddressFor('USDC'),
          chain: `${sourceChain} → Arc Testnet (via CCTP V2)`,
          senderEmail: 'cross-chain-detect@arc.network',
          merchant: 'FlareHQ CCTP V2 Router',
          status: 'POLLING_CIRCLE_TESTNET_IRIS_API',
          webhookUrl: webhookUrl || null,
          cctpSourceTxHash: messageHash,
        },
      });
    } catch (claimErr: any) {
      if (claimErr?.code === 'P2002') {
        return NextResponse.json(
          { success: false, error: 'This transaction has already been detected.' },
          { status: 409 }
        );
      }
      throw claimErr;
    }

    // Poll Circle Iris V2 API
    let arcTxHash: string;
    let attestationPolled = false;
    try {
      const { message, attestation } = await pollForAttestation(messageHash);
      attestationPolled = true;
      // M2: decodeBurnMessage binding — the burn must cover the claimed
      // amount and name a real recipient before anything mints. Releases the
      // source-tx claim on mismatch so a genuine retry isn't blocked.
      const { decodeBurnMessage } = await import('@/src/lib/cctp');
      const { parseUnits } = await import('viem');
      const { mintRecipient, amount: burnedAmount } = decodeBurnMessage(message);
      if (!/^0x[a-fA-F0-9]{40}$/.test(mintRecipient)) {
        await prisma.paymentLog.update({ where: { reference }, data: { status: 'MISMATCH', cctpSourceTxHash: null } });
        return NextResponse.json({ success: false, error: 'This transaction does not pay a valid recipient.', reference }, { status: 400 });
      }
      if (burnedAmount < parseUnits(amountStr, 6)) {
        await prisma.paymentLog.update({ where: { reference }, data: { status: 'MISMATCH', cctpSourceTxHash: null } });
        return NextResponse.json({ success: false, error: 'This transaction does not cover the claimed amount.', reference }, { status: 400 });
      }
      arcTxHash = await mintOnArc(message, attestation);
    } catch (cctpErr: any) {
      // M2 claim-release: attestation wasn't ready — free the source-tx
      // claim so a genuine retry isn't blocked by our own earlier claim.
      // (Binding mismatches above already returned; this path is polling.)
      if (!attestationPolled) {
        await prisma.paymentLog.update({
          where: { reference },
          data: { status: 'ATTESTATION_FAILED', cctpSourceTxHash: null },
        });
      } else {
        await prisma.paymentLog.update({
          where: { reference },
          data: { status: 'ATTESTATION_FAILED' },
        });
      }
      return NextResponse.json(
        {
          success: false,
          error: cctpErr.message,
          reference,
          hint: 'The burn tx may still be confirming. Retry in 30 seconds.',
        },
        { status: 502 }
      );
    }

    // Mark settled
    const settled = await prisma.paymentLog.update({
      where: { reference },
      data: {
        status: 'REDEEMED_AND_MINTED',
        arcTxHash,
        chain: `${sourceChain} → Arc Testnet (via CCTP V2)`,
      },
    });

    // Fire webhook
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payment.detected_and_settled',
          reference,
          arcTxHash,
          amount: settled.amount,
          currency: settled.currency,
          sourceChain,
          status: 'SUCCESS',
          settledAt: new Date().toISOString(),
          settlementType: 'CCTP_V2_MANUAL_DETECT',
          explorerUrl: `${explorerTxUrl(arcTxHash)}`,
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      reference,
      arcTxHash,
      sourceChain,
      settlementType: 'CCTP_V2_MANUAL_DETECT',
      explorerUrl: `${explorerTxUrl(arcTxHash)}`,
      message: `USDC auto-routed from ${sourceChain} to Arc Testnet via CCTP V2.`,
    });
  } catch (error: any) {
    console.error('Detect route error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(detectHandler);
