// src/app/api/payments/initialize/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, InitializeSchema } from '@/src/lib/validation';
import { resolveCurrency } from '@/src/lib/tokens/resolveCurrency';
import { resolveMerchantSettlementPreference } from '@/src/lib/routing/preference';
import { resolveInitializeCaller } from '@/src/lib/middleware/withMerchantAuth';
import { requireConsumerStepUp } from '@/lib/auth/consumerStepUp';

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

    // 3. Zod Validation (schema default keeps legacy USDC for absent
    // currency — preference inheritance below keys off EXPLICIT raw input).
    const rawBody = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(InitializeSchema, rawBody);
    if (validationError) return validationError as NextResponse;
    const rawObj = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
    const explicitToken = rawObj.currency !== undefined || rawObj.tokenAddress !== undefined;

    const { amount, currency, email, merchant, agentSCA, webhookUrl, payoutAddress, direction, tokenAddress } = data;

    // Merchant record for settlement-preference inheritance (routing v1).
    // Loaded in the merchant branch below; null for consumer/internal
    // callers, who keep the legacy USDC default via the resolver.
    let preferenceMerchant: any = null;

    // 4. If agentSCA provided, verify it exists in AgentRegistry
    let resolvedSenderEmail = email || 'autonomous-agent@arc.network';
    let resolvedAgent = null;

    if (agentSCA) {
      // The platform's own agent (AGENT_OWNER_WALLET_ADDRESS) has no
      // registry row — the internal service key IS its credential. Allow
      // internal callers (agent/brain) to pay from it directly; everyone
      // else must name a registered agent they own.
      const platformAgent = (process.env.AGENT_OWNER_WALLET_ADDRESS || '').toLowerCase();
      const isPlatformAgent =
        caller.type === 'internal' && agentSCA.toLowerCase() === platformAgent;

      resolvedAgent = isPlatformAgent
        ? { scaAddress: agentSCA }
        : await (prisma as any).agentRegistry.findUnique({
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

      // Ownership gate: a merchant may only name an agent THEY registered.
      // Without this, any verified merchant could create a payment whose
      // payer is another tenant's agent — settle Path B then debits the
      // victim agent's custodial Circle wallet and pays the attacker
      // (cross-tenant custodial drain). Internal calls are trusted and
      // unchanged; consumers can never name an agent as payer (the consumer
      // branch below overwrites senderEmail with the session wallet).
      if (caller.type === 'merchant' && caller.merchant) {
        if (resolvedAgent.merchantId !== caller.merchant.id) {
          return NextResponse.json(
            {
              success: false,
              error:
                'You can only create payments from agents you own. This agent belongs to another merchant.',
            },
            { status: 403 }
          );
        }
      }

      resolvedSenderEmail = agentSCA;
    }

    // 5. Resolve merchant/business name and merchantId server-side —
    // never trust a client-supplied "merchant" string as the business
    // identity for merchant-type callers, or a merchant link could be
    // created under someone else's business name.
    let merchantName = merchant || 'Unknown Merchant';
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
      preferenceMerchant = merchantRecord;
    } else if (caller.type === 'consumer' && caller.consumerWalletAddress) {
      // Consumer step-up (Stage 2): initiating a payment needs the step-up
      // credential once a payment PIN is enrolled. A session alone is not
      // sufficient — the helper enforces this in front of the session check.
      const initAccount = await (prisma as any).consumerAccount.findUnique({
        where: { walletAddress: caller.consumerWalletAddress },
      });
      const initStepUp = await requireConsumerStepUp(
        req,
        initAccount,
        direction === 'request' ? 'consumer.request' : 'consumer.send'
      );
      if (initStepUp) return initStepUp as NextResponse;
      // Flow's "Send"/"Request" — the requesting/sending party is whichever
      // consumer is logged in, not whatever the client claims.
      //
      // "send": this consumer IS the payer — record them as sender now.
      // "request": this consumer is asking to be paid — there is no real
      // payer yet, so leave senderEmail as a placeholder (same convention
      // merchant payment links already use) until someone actually settles
      // it. Previously this always filled in the requester's own wallet,
      // which made the checkout page treat the requester as if they were
      // the payer before anyone had actually paid.
      resolvedSenderEmail = direction === 'request' ? 'pending@checkout' : caller.consumerWalletAddress;

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

    // Payment links have never actually expired: this field was checked at
    // settle time (see /api/payments/settle) but never SET anywhere, so it
    // was always null and the expiry check never fired. 120 minutes is a
    // reasonable default for a one-off checkout link.
    const EXPIRY_MINUTES = 120;
    const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60_000);

    // Resolve the canonical settlement token for this invoice. Rejects
    // unsupported symbols/addresses and guards against symbol/address
    // mismatch. Persisted below so every payment record carries exact token
    // identity.
    //
    // Routing v1: a merchant that names no explicit token inherits their
    // default settlement preference (NULL = USDC). Explicit input always
    // wins; every other caller resolves exactly as before (schema default
    // USDC flows into the resolver).
    let token: { symbol: 'USDC' | 'EURC'; address: string; decimals: number };
    try {
      token =
        !explicitToken && caller.type === 'merchant' && preferenceMerchant
          ? resolveMerchantSettlementPreference(preferenceMerchant)
          : resolveCurrency({ currency, tokenAddress });
    } catch (tokenErr: any) {
      return NextResponse.json(
        { success: false, error: `Unsupported settlement token: ${tokenErr.message}` },
        { status: 400 }
      );
    }

    await prisma.paymentLog.create({
      data: {
        reference: transactionReference,
        amount: Number(amount),
        currency: token.symbol,
        tokenAddress: token.address,
        chain: 'Arc Testnet v1.0',
        senderEmail: resolvedSenderEmail,
        direction: direction || 'send',
        merchant: merchantName,
        merchantId,
        merchantSCA,
        status: 'PENDING',
        webhookUrl: webhookUrl || null,
        expiresAt,
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
        currency: token.symbol,
        status: 'ready',
        authorization_url: `/checkout/${transactionReference}`,
      },
      // Canonical settlement-token identity (Phase 1 read-model). EURC is NOT
      // settleable yet — this informs the checkout data path only.
      token: {
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
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