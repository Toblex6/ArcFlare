// src/app/api/swap/verify/route.ts
// POST /api/swap/verify — verify a Flow Swap execution on-chain (backend
// only; no UI in this stage).
//
// Collects fixed-block-tag evidence for the broadcast swap (plus the wrap
// linkage for USDC-leg inputs), runs the existing pure UnitFlow verifier,
// enforces payer == session wallet and cross-table single-consumption, and
// atomically marks the intent EXECUTED. Replay of the same execution
// re-verifies idempotently; any other tx against a consumed intent is a 409.
//
// Submission-shape dispatch: browser-signed (direct) executions prove
// through the shared service; server-broadcast (Circle SCA relayed)
// executions prove through the relay-aware verifier — both evidence-based,
// both fail-closed, neither trusts client claims.

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { parseBody, SwapVerifySchema } from '@/src/lib/validation';
import { resolveFlowPayer, verifyFlowSwap } from '@/src/lib/swap/service';
import { isDirectSubmissionShape, verifyFlowSwapRelayed } from '@/src/lib/swap/relayedVerify';
import { getUnitFlowV3Deployment } from '@/src/lib/config/unitflow';
import { getNetworkConfig } from '@/src/lib/config/network';
import { getRoutingPublicClient, readWithRetry } from '@/src/lib/routing/canonical';

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(SwapVerifySchema, body);
    if (validationError) return validationError as NextResponse;

    const { wallet } = await resolveFlowPayer(req);

    const locator = {
      ...(data.intentId ? { intentId: data.intentId } : {}),
      ...(data.quoteHash ? { quoteHash: data.quoteHash } : {}),
      ...(data.wrapTxHash ? { wrapTxHash: data.wrapTxHash } : {}),
      ...(data.executionTxHash ? { executionTxHash: data.executionTxHash } : {}),
    };

    // Peek at the execution shape when a hash is supplied: direct
    // submissions keep the existing proof; relayed (Circle SCA) submissions
    // route to the relay-aware proof. Without a hash the shared service
    // resolves it from the stored intent (direct path unchanged).
    let relayed = false;
    if (data.executionTxHash) {
      const deployment = getUnitFlowV3Deployment();
      const client = getRoutingPublicClient(getNetworkConfig().primaryRpc);
      const tx = await readWithRetry('verify shape peek', () =>
        client.getTransaction({ hash: data.executionTxHash as `0x${string}` })
      ).catch(() => null);
      if (tx && !isDirectSubmissionShape(tx.to ?? '', tx.input, deployment.universalRouter)) {
        relayed = true;
      }
    }

    const result = relayed
      ? await verifyFlowSwapRelayed({ ownerWallet: wallet, ...locator })
      : await verifyFlowSwap({ ownerWallet: wallet, ...locator });
    return NextResponse.json({
      success: true,
      alreadySettled: result.alreadySettled,
      intentId: result.intent.id,
      status: result.intent.status,
      payer: result.payer,
      actualInput: result.actualInput,
      actualOutput: result.actualOutput,
      executionTxHash: result.intent.executionTxHash,
      wrapTxHash: result.intent.wrapTxHash,
    });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status === 500) console.error('Swap verify error:', error);
    return NextResponse.json(
      { success: false, error: status === 500 ? 'Swap verification failed.' : error.message },
      { status }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ready',
    message: 'Flow Swap verification is active.',
  });
}
