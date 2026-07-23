// src/app/api/payments/initialize/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, InitializeSchema } from '@/src/lib/validation';
import { resolveInitializeCaller } from '@/src/lib/middleware/withMerchantAuth';

export async function POST(req: NextRequest) {
  try {
    // 1. Rate Limiting
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    // 2. Auth — merchant key, consumer session, or internal service key.
    // No unauthenticated caller can create a payment anymore.
    const caller = await resolveInitializeCaller(req);
    if (!caller) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Authentication required. Provide a valid x-api-key, or sign in to create a payment.',
        },
        { status: 401 }
      );
    }

    // 3. Zod Validation
    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(InitializeSchema, body);
    if (validationError) return validationError as NextResponse;

    const { amount, currency, email, merchant, agentSCA, webhookUrl, payoutAddress } = data;

    // 4. If agentSCA provided, verify it exists in AgentRegistry
    let resolvedSenderEmail = email || 'autonomous-agent@arc.network';
    let resolvedAgent = null;

    if (agentSCA) {
      resolvedAgent = await (prisma as any).agentRegistry.findUnique({
        where: { scaAddress: agentSCA },
      });

      if (!resolvedAgent) {
        return NextResponse.json(
          {
            success: false,
            error: `Agent SCA ${agentSCA} not found in registry. Deploy agent first via POST /api/agent/deploy.`,
          },
          { status: 404 }
        );
      }

      resolvedSenderEmail = agentSCA;
    }

    // 5. Resolve merchant/business name and merchantId server-side —
    // never trust a client-supplied "merchant" string as the business
    // identity for merchant-type callers, or a merchant link could be
    // created under someone else's business name.
    let merchantName = merchant || 'Dispatch Marketplace';
    let merchantId: string | undefined;
    let merchantSCA: string | undefined;

    if (caller.type === 'merchant' && caller.merchant) {
      const merchantRecord = await (prisma as any).merchant.findUnique({
        where: { id: caller.merchant.id },
      });
      if (!merchantRecord?.walletAddress) {
        return NextResponse.json(
          {
            success: false,
            error:
              'Your payout wallet is not set up yet. Finish wallet setup in your dashboard before creating payment links.',
          },
          { status: 400 }
        );
      }
      merchantName = merchantRecord.businessName;
      merchantId = merchantRecord.id;
      merchantSCA = merchantRecord.walletAddress;
    } else if (caller.type === 'consumer' && caller.consumerWalletAddress) {
      // Flow's "Send"/"Request" — sender is whichever consumer is logged in,
      // not whatever the client claims.
      resolvedSenderEmail = caller.consumerWalletAddress;

      // Payout destination:
      // - "Send": payoutAddress is the recipient the consumer typed/spoke —
      //   validated as a real 0x address by the schema, never taken from
      //   the free-text `merchant` label.
      // - "Request": no payoutAddress is given, so the requester is paying
      //   themselves — route to the requesting consumer's own wallet.
      merchantSCA = payoutAddress || caller.consumerWalletAddress;
    }
    // caller.type === 'internal' — trusted server-to-server call (agent/brain),
    // uses the agentSCA/merchant fields from the request body as before.

    const transactionReference = `arc_ref_${Math.random()
      .toString(36)
      .substring(2, 15)}${Date.now().toString(36)}`;

    await prisma.paymentLog.create({
      data: {
        reference: transactionReference,
        amount: Number(amount),
        currency: currency ?? 'USDC',
        chain: 'Arc Testnet v1.0',
        senderEmail: resolvedSenderEmail,
        merchant: merchantName,
        merchantId,
        merchantSCA,
        status: 'PENDING',
        webhookUrl: webhookUrl || null,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Payment initialized successfully.',
      reference: transactionReference,
      checkoutUrl: `https://flarehq.xyz/checkout/${transactionReference}`,
      agent: resolvedAgent
        ? {
          name: resolvedAgent.name,
          scaAddress: resolvedAgent.scaAddress,
          tokenId: resolvedAgent.tokenId,
          circleWalletId: resolvedAgent.circleWalletId,
        }
        : null,
      data: {
        reference: transactionReference,
        amount,
        currency: currency ?? 'USDC',
        status: 'ready',
        authorization_url: `/checkout/${transactionReference}`,
      },
    });
  } catch (error: any) {
    console.error('Initialize error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal Ledger Process Exception Error.' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ready',
    message: 'FlareHQ Gateway Ledger initialization channel is active.',
  });
}