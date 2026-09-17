// src/app/api/cctp/transfer/external/intent/route.ts
//
// EXTERNAL bridge intent: the browser wallet will sign the source-chain
// approve/burn via Circle BridgeKit; this endpoint authenticates the
// consumer, validates the request, server-resolves the Arc destination, and
// records a PENDING FlowBridgeIntent the verify/complete endpoints advance.
// The server never signs or broadcasts here (no Circle wallet SDK, no keys).
//
// TESTNET ONLY — mainnet refuses closed.

import { NextRequest, NextResponse } from 'next/server';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { prisma } from '@/src/lib/prisma';
import { resolveConsumerWallet } from '@/src/lib/auth/consumerWallet';
import { getArcNetworkName } from '@/lib/config/network';
import { checkRateLimit } from '@/src/lib/ratelimit';
import {
  getBridgeSourceChain,
  validateBridgeAmount,
  formatBridgeBaseUnits,
  type BridgeAmountError,
} from '@/lib/bridge/sourceChains';
import { resolveExternalBridgeDestination } from '@/lib/bridge/externalDestination';

const INTENT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours to submit the burn

function amountErrorCopy(e: BridgeAmountError): string {
  switch (e) {
    case 'EMPTY':
      return 'Enter an amount of USDC to bridge.';
    case 'MALFORMED':
      return 'Enter a valid USDC amount (numbers only, e.g. 10.00).';
    case 'TOO_MANY_DECIMALS':
      return 'USDC supports at most 6 decimals.';
    case 'ZERO_OR_NEGATIVE':
      return 'Bridge amount must be greater than zero.';
    case 'INSUFFICIENT_BALANCE':
      return 'Bridge amount exceeds the available balance.';
  }
}

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse!;

    if (getArcNetworkName() === 'mainnet') {
      return NextResponse.json(
        {
          success: false,
          code: 'BRIDGE_DISABLED_ON_MAINNET',
          error: 'External bridging is testnet-only in this release.',
        },
        { status: 403 }
      );
    }

    const sessionAddress = await resolveConsumerSession(req);
    if (!sessionAddress) {
      return NextResponse.json(
        { success: false, error: 'Sign in required to bridge funds.' },
        { status: 401 }
      );
    }

    const account = await (prisma as any).consumerAccount.findUnique({
      where: { walletAddress: sessionAddress },
    });
    const wallet = resolveConsumerWallet(account);
    if (!wallet) {
      return NextResponse.json(
        {
          success: false,
          code: 'WALLET_UNSUPPORTED',
          error: 'This wallet type is no longer supported for bridging.',
        },
        { status: 403 }
      );
    }
    if (wallet.mode !== 'EXTERNAL') {
      // CIRCLE sessions keep the Arc-only funding UX; the two modes are
      // never mixed, and this path must never server-sign.
      return NextResponse.json(
        {
          success: false,
          code: 'CIRCLE_CANNOT_USE_EXTERNAL_BRIDGE',
          error:
            'This FlareHQ wallet lives on Arc — fund it directly on Arc. The external bridge is for connected wallets bringing USDC from another chain.',
        },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { sourceChain, amount } = body ?? {};

    const source = typeof sourceChain === 'string' ? getBridgeSourceChain(sourceChain) : null;
    if (!source) {
      return NextResponse.json(
        {
          success: false,
          code: 'UNSUPPORTED_SOURCE',
          error: 'This source chain is not currently supported.',
        },
        { status: 400 }
      );
    }

    const checked = validateBridgeAmount(amount, null);
    if (!checked.ok) {
      return NextResponse.json(
        { success: false, code: 'AMOUNT_INVALID', error: amountErrorCopy(checked.error) },
        { status: 400 }
      );
    }

    // Server-resolved destination — the browser-supplied body carries no
    // recipient; a body `recipient`/`destination` field is ignored even if
    // present (never authoritative).
    const dest = await resolveExternalBridgeDestination(account);
    if (!dest.ok) {
      return NextResponse.json(
        { success: false, code: dest.code, reason: dest.reason, error: dest.error },
        { status: 400 }
      );
    }

    const intent = await (prisma as any).flowBridgeIntent.create({
      data: {
        sourceWallet: sessionAddress,
        destination: dest.destination,
        sourceChain: source.id,
        amount: checked.amountBaseUnits.toString(),
        status: 'PENDING',
        expiresAt: new Date(Date.now() + INTENT_TTL_MS),
      },
    });

    return NextResponse.json({
      success: true,
      reference: intent.id,
      sourceAddress: sessionAddress,
      destination: dest.destination,
      source: {
        id: source.id,
        label: source.label,
        chainId: source.chainId,
        usdcAddress: source.usdcAddress,
      },
      amount: checked.amountBaseUnits.toString(),
      amountDisplay: formatBridgeBaseUnits(checked.amountBaseUnits),
      expiresAt: intent.expiresAt,
    });
  } catch (error: any) {
    console.error('[cctp/transfer/external/intent]', error);
    return NextResponse.json({ success: false, error: 'Could not start the bridge. Please try again.' }, { status: 500 });
  }
}
