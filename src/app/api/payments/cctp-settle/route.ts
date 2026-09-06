// src/app/api/payments/cctp-settle/route.ts
//
// Settles a checkout payment made via CCTP from another chain. Mirrors
// /api/payments/verify-onchain's trust model for the direct-wallet flow:
// the payer's own browser reports what they did (a burn txHash), and this
// route independently verifies + settles server-side before ever marking
// the PaymentLog as SUCCESS — it never trusts the client's claim alone.
//
// SECURITY: two checks added after review, both required before this is
// safe to merge —
//   1. The decoded CCTP message's mintRecipient and amount are checked
//      against the actual payment.merchantSCA/payment.amount. Without
//      this, ANY valid attested CCTP burn (someone's own unrelated
//      transfer, or any public one found on an explorer) could be
//      replayed against an arbitrary checkout reference and settle it —
//      the route previously only checked that Iris had SOME completed
//      attestation for the given txHash, never what it was actually for.
//   2. sourceTxHash is claimed atomically (unique DB constraint) before
//      minting, so the same burn can't be used to settle two different
//      references. This relies on `cctpSourceTxHash String? @unique`
//      existing on PaymentLog — see README in this delivery for the
//      schema addition, it is NOT optional, the idempotency guarantee
//      depends on the DB enforcing uniqueness, not application logic alone.
//
// No session/API-key auth on this route is intentional and consistent
// with /api/payments/verify-onchain — checkout is public by design, a
// payer is never logged in. The two checks above ARE this route's real
// authorization mechanism: the on-chain proof itself, not a session.

import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { pollForAttestationByTxHash, mintOnArc, getChainName, decodeBurnMessage } from '@/src/lib/cctp';
import { resolveRowCurrency } from '@/src/lib/tokens/resolveCurrency';
import { parseUnits } from 'viem';

const USDC_DECIMALS = 6;

export async function POST(request: Request) {
  try {
    const { reference, sourceTxHash, sourceDomain } = await request.json();

    if (!reference || !sourceTxHash || sourceDomain === undefined) {
      return NextResponse.json(
        { success: false, error: 'reference, sourceTxHash, and sourceDomain are required.' },
        { status: 400 }
      );
    }

    const payment = await prisma.paymentLog.findUnique({ where: { reference } });
    if (!payment) {
      return NextResponse.json({ success: false, error: 'Payment reference not found.' }, { status: 404 });
    }
    if (payment.status === 'SUCCESS') {
      // Idempotent for retries on the SAME reference (e.g. the widget
      // re-submitting after a slow response) — don't re-poll/re-mint.
      return NextResponse.json({ success: true, alreadySettled: true, payment });
    }

    // ── CCTP IS INTENTIONALLY USDC-ONLY (Phase 2A) ───────────────────────────
    // The CCTP message-transmitter redemption on Arc mints USDC; no EURC CCTP
    // mechanism has been proven in this repository, so this route must never
    // settle a non-USDC invoice. A USDC CCTP burn must never silently settle
    // an EURC invoice (currency mismatch the parties did not authorize), and
    // an EURC-denominated burn must never satisfy a USDC invoice. Resolve the
    // invoice's canonical token first (legacy NULL tokenAddress → USDC,
    // unsupported/mismatched identity rejected), then refuse anything that is
    // not USDC. EURC invoices settle via the same-chain token-native paths
    // (settle Path B / verify-onchain), never through CCTP.
    let cctpToken: { symbol: 'USDC' | 'EURC'; address: string; decimals: number };
    try {
      cctpToken = resolveRowCurrency({
        currency: (payment as any).currency ?? null,
        tokenAddress: (payment as any).tokenAddress ?? null,
      });
    } catch (tokenErr: any) {
      return NextResponse.json(
        { success: false, error: `Unsupported settlement token for this payment: ${tokenErr.message}` },
        { status: 400 }
      );
    }
    if (cctpToken.symbol !== 'USDC') {
      return NextResponse.json(
        {
          success: false,
          error: `CCTP settlement is USDC-only. This payment is denominated in ${cctpToken.symbol} — CCTP settlement for ${cctpToken.symbol} is not supported.`,
        },
        { status: 400 }
      );
    }

    if (!payment.merchantSCA) {
      return NextResponse.json(
        { success: false, error: 'This merchant has not finished payout wallet setup — cannot settle.' },
        { status: 400 }
      );
    }

    // ── Claim sourceTxHash atomically BEFORE doing any polling/minting.
    // The unique constraint on cctpSourceTxHash means a second request
    // (whether replaying this same tx against a different reference, or a
    // genuine concurrent duplicate request) fails here at the DB level,
    // not via an application-level race-prone check-then-act.
    try {
      await prisma.paymentLog.update({
        where: { reference },
        data: { cctpSourceTxHash: sourceTxHash },
      });
    } catch (claimErr: any) {
      if (claimErr.code === 'P2002') {
        return NextResponse.json(
          { success: false, error: 'This transaction has already been used to settle a different payment.' },
          { status: 409 }
        );
      }
      throw claimErr;
    }

    const sourceChain = getChainName(sourceDomain);
    console.log(`🌉 [CCTP checkout] Settling ${reference} — source tx ${sourceTxHash} on ${sourceChain}`);

    await prisma.paymentLog.update({
      where: { reference },
      data: { status: 'POLLING_CIRCLE_TESTNET_IRIS_API', chain: `${sourceChain} → Arc Testnet (via CCTP V2)` },
    });

    let message: string, attestation: string;
    try {
      ({ message, attestation } = await pollForAttestationByTxHash(sourceDomain, sourceTxHash));
    } catch (cctpErr: any) {
      // Release the claim on failure so a genuine retry (e.g. attestation
      // wasn't ready yet) isn't permanently blocked by its own earlier claim.
      await prisma.paymentLog.update({ where: { reference }, data: { status: 'ATTESTATION_FAILED', cctpSourceTxHash: null } });
      return NextResponse.json(
        {
          success: false,
          error: cctpErr.message,
          hint: 'The burn tx may still be confirming on the source chain. Retry in 30 seconds.',
        },
        { status: 502 }
      );
    }

    // ── Validate the message actually pays what this reference expects,
    // BEFORE minting. This is the check that was missing entirely before.
    // USDC_DECIMALS is correct here (not resolver decimals): the gate above
    // guarantees this invoice is USDC, and CCTP burns/mints are USDC.
    const { mintRecipient, amount: burnedAmount } = decodeBurnMessage(message);
    const expectedRecipient = payment.merchantSCA.toLowerCase();
    const expectedAmount = parseUnits(payment.amount.toString(), USDC_DECIMALS);

    if (mintRecipient.toLowerCase() !== expectedRecipient) {
      await prisma.paymentLog.update({ where: { reference }, data: { status: 'MISMATCH', cctpSourceTxHash: null } });
      console.error(`❌ [CCTP checkout] Mint recipient mismatch for ${reference}: expected ${expectedRecipient}, got ${mintRecipient}`);
      return NextResponse.json(
        { success: false, error: 'This transaction does not pay the correct recipient for this checkout.' },
        { status: 400 }
      );
    }
    if (burnedAmount < expectedAmount) {
      await prisma.paymentLog.update({ where: { reference }, data: { status: 'MISMATCH', cctpSourceTxHash: null } });
      console.error(`❌ [CCTP checkout] Amount mismatch for ${reference}: expected >= ${expectedAmount}, got ${burnedAmount}`);
      return NextResponse.json(
        { success: false, error: 'This transaction does not cover the required payment amount.' },
        { status: 400 }
      );
    }

    let arcTxHash: string;
    try {
      arcTxHash = await mintOnArc(message, attestation);
    } catch (mintErr: any) {
      await prisma.paymentLog.update({ where: { reference }, data: { status: 'ATTESTATION_FAILED', cctpSourceTxHash: null } });
      throw mintErr;
    }

    const settled = await prisma.paymentLog.update({
      where: { reference },
      data: {
        status: 'SUCCESS',
        arcTxHash,
        chain: `${sourceChain} → Arc Testnet (via CCTP V2)`,
      },
    });

    console.log(`✅ [CCTP checkout] ${reference} settled. Arc tx: ${arcTxHash}`);

    if (settled.webhookUrl) {
      fetch(settled.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payment.settled',
          reference,
          amount: settled.amount,
          currency: settled.currency,
          arcTxHash,
          sourceChain,
          status: 'SUCCESS',
          settledAt: new Date().toISOString(),
          settlementType: 'CCTP_V2_CHECKOUT',
          explorerUrl: `https://testnet.arcscan.app/tx/${arcTxHash}`,
        }),
      }).catch(() => { });
    }

    return NextResponse.json({
      success: true,
      payment: settled,
      arcTxHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${arcTxHash}`,
    });
  } catch (error: any) {
    console.error('CCTP checkout settle error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
