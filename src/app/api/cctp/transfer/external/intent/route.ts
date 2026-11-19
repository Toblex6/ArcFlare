// src/app/api/cctp/transfer/external/intent/route.ts
//
// EXTERNAL bridge intent: the browser wallet will sign the source-chain
// approve/burn via Circle BridgeKit; this endpoint authenticates the
// consumer, validates the request, server-resolves the Arc destination, and
// records a PENDING FlowBridgeIntent the verify/complete endpoints advance.
// The server never signs or broadcasts here (no Circle wallet SDK, no keys).
//
// Networks: testnet sources (Sepolia-family) and mainnet sources
// (Ethereum/Base/Arbitrum/Optimism/Polygon/Avalanche → Arc Mainnet) resolve
// from the network-scoped table in sourceChains.ts. Testnet behavior is
// unchanged.

import { NextRequest, NextResponse } from 'next/server';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { prisma } from '@/src/lib/prisma';
import { resolveConsumerWallet } from '@/src/lib/auth/consumerWallet';
import { getArcNetworkName } from '@/lib/config/network';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { checkRateLimit } from '@/src/lib/ratelimit';
import {
  getBridgeSourceChain,
  validateBridgeAmount,
  formatBridgeBaseUnits,
  type BridgeAmountError,
} from '@/lib/bridge/sourceChains';
import { resolveExternalBridgeDestination } from '@/lib/bridge/externalDestination';
import { logBridgeStage } from '@/lib/bridge/stageLogger';
import { getExternalBridgeAvailability } from '@/lib/bridge/externalAvailability';
import { reserveBridgeIntent, BridgeIntentConflictError } from '@/lib/bridge/intentReuse';
import {
  WALLET_CHECK_FAILED_CODE,
  WALLET_CHECK_RETRY_MESSAGE,
  WALLET_NEEDS_UPDATE_MESSAGE,
  checkCircleWalletLiveness,
} from '@/src/lib/wallets/liveness';

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

    // Network-scoped source table (Step D): testnet keeps the Sepolia
    // family; mainnet offers Ethereum/Base/Arbitrum/Optimism/Polygon/
    // Avalanche → Arc Mainnet via BridgeKit.
    const network = getArcNetworkName() === 'mainnet' ? 'mainnet' : 'testnet';
    const availability = getExternalBridgeAvailability();
    if (!availability.available) {
      return NextResponse.json({ success: false, code: 'EXTERNAL_BRIDGE_UNAVAILABLE', error: availability.message }, { status: 503 });
    }

    const sessionAddress = await resolveConsumerSession(req);
    if (!sessionAddress) {
      return NextResponse.json(
        { success: false, error: 'Sign in required to bridge funds.' },
        { status: 401 }
      );
    }

    const actor = await verifyCallerControlsAddress(req, sessionAddress);
    if (!actor) return NextResponse.json({ success: false, error: 'You do not control the source wallet.' }, { status: 403 });

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
    const { sourceChain, amount, reference, retryBeforeBurn } = body ?? {};
    if (retryBeforeBurn !== undefined && typeof retryBeforeBurn !== 'boolean') {
      return NextResponse.json({ success: false, code: 'INTENT_INVALID', error: 'Invalid retry confirmation.' }, { status: 400 });
    }
    if (reference !== undefined && (typeof reference !== 'string' || !reference.length || reference.length > 100)) {
      return NextResponse.json({ success: false, code: 'INTENT_INVALID', error: 'Invalid bridge reference.' }, { status: 400 });
    }

    const source = typeof sourceChain === 'string' ? getBridgeSourceChain(sourceChain, network) : null;
    if (!source) {
      return NextResponse.json(
        {
          success: false,
          code: 'UNSUPPORTED_SOURCE',
          error:
            network === 'mainnet'
              ? 'This source chain is not currently supported for Arc Mainnet (Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche).'
              : 'This source chain is not currently supported.',
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
    // Mainnet sink gate (same display/liveness rule as the destination
    // preview): never record a bridge into a wallet that is not ARC+LIVE
    // under the production key. Testnet: never gated.
    if (getArcNetworkName() === 'mainnet') {
      const live = await checkCircleWalletLiveness(dest.circleWalletId, dest.destination);
      if (live.checked && !live.live) {
        // Transient: retry, no intent recorded. Stale: re-login.
        if (!live.stale) {
          return NextResponse.json(
            { success: false, code: WALLET_CHECK_FAILED_CODE, error: WALLET_CHECK_RETRY_MESSAGE },
            { status: 503 }
          );
        }
        return NextResponse.json(
          { success: false, code: 'WALLET_NEEDS_UPDATE', error: WALLET_NEEDS_UPDATE_MESSAGE },
          { status: 409 }
        );
      }
    }

    const { intent, reused } = await reserveBridgeIntent(prisma, {
        sourceWallet: sessionAddress,
        destination: dest.destination,
        sourceChain: source.id,
        amount: checked.amountBaseUnits.toString(),
        reference,
        renewSubmission: !!reference && retryBeforeBurn === true,
    });

    // Awaited (not fire-and-forget) so the PREPARING row is never lost on
    // serverless freeze before the response returns. logBridgeStage never
    // throws, so awaiting is safe.
    if (!reused) await logBridgeStage(intent.id, {
      stage: 'PREPARING',
      chainId: source.chainId,
      metadata: {
        sourceChain: source.id,
        sourceWallet: sessionAddress,
        destination: dest.destination,
        amount: checked.amountBaseUnits.toString(),
        amountDisplay: formatBridgeBaseUnits(checked.amountBaseUnits),
      },
    });

    return NextResponse.json({
      success: true,
      reference: intent.id,
      reused,
      state: intent.status,
      burnTxHash: intent.burnTxHash ?? null,
      mintTxHash: intent.mintTxHash ?? null,
      canSubmitBurn: intent.status === 'PENDING' && !intent.burnTxHash && new Date(intent.expiresAt).getTime() > Date.now(),
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
    if (error instanceof BridgeIntentConflictError) {
      return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
    }
    console.error('[cctp/transfer/external/intent]', error);
    return NextResponse.json({ success: false, error: 'Could not start the bridge. Please try again.' }, { status: 500 });
  }
}
