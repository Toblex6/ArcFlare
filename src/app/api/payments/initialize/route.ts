// src/app/api/payments/initialize/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, InitializeSchema } from '@/src/lib/validation';

export async function POST(req: NextRequest) {
  try {
    // 1. Rate Limiting
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    // 2. Zod Validation
    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(InitializeSchema, body);
    if (validationError) return validationError as NextResponse;

    const { amount, currency, email, merchant, agentSCA, webhookUrl } = data;

    // 3. If agentSCA provided, verify it exists in AgentRegistry
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
        merchant: merchant || 'Dispatch Marketplace',
        status: 'PENDING',
        webhookUrl: webhookUrl || null,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Payment initialized successfully.',
      reference: transactionReference,
      checkoutUrl: `https://arcflare-gateway.onrender.com/checkout/${transactionReference}`,
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
    message: 'ArcFlare Gateway Ledger initialization channel is active.',
  });
}
