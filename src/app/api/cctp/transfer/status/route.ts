// src/app/api/cctp/transfer/status/route.ts
// Poll this after POST /api/cctp/transfer returns { status: "pending" }.
// Resumes/checks the bridge via Bridge Kit's own retry() mechanism.

import { NextRequest, NextResponse } from "next/server";
import { checkBridgeStatus, findStep } from "@/lib/cctp-v2";
import { explorerTxUrl, getNetworkConfig } from "@/lib/config/network";
import {
  getUserBridgeIntent,
  minorToDisplay,
  readArcUsdcBalanceOf,
  setUserBridgeIntent,
} from "@/lib/circle/userBridge";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const reference = searchParams.get("reference");

        if (!reference) {
            return NextResponse.json(
                { success: false, error: "reference query param is required." },
                { status: 400 }
            );
        }

        // USER_CONTROLLED bridges (ucbridge_*) live in the user-bridge
        // intent store, not the Bridge-Kit store. Terminal states:
        // pre-mint states echo the intent; minting polls the Arc
        // balance-delta (recipient credited ≥ amount − maxFee) since the
        // destination mint needs nothing from the wallet.
        if (reference.startsWith("ucbridge_")) {
            return userBridgeStatus(reference);
        }

        const tracked = await checkBridgeStatus(reference);
        if (!tracked) {
            return NextResponse.json(
                { success: false, error: "No bridge found for that reference (it may have already completed, or the server restarted)." },
                { status: 404 }
            );
        }

        if (tracked.status === 'submitting') {
            return NextResponse.json({ success: true, state: 'submitting' });
        }

        if (tracked.status === 'error') {
            return NextResponse.json({ success: true, state: 'error', error: tracked.message });
        }

        // tracked.status === 'settled' — tracked.result is a real BridgeResult
        const { result } = tracked;
        const burnStep = findStep(result, 'Burn');
        const mintStep = findStep(result, 'Mint');

        // Bridge Kit doesn't always populate step.explorerUrl until the step is
        // fully finalized — fall back to building the Arc explorer link
        // ourselves from the tx hash if we have one but no ready-made URL yet.
        const destinationExplorerUrl =
            mintStep?.explorerUrl || (mintStep?.txHash ? `${explorerTxUrl(mintStep.txHash)}` : undefined);

        return NextResponse.json({
            success: true,
            state: result.state, // 'pending' | 'success' | 'error'
            amount: result.amount,
            sourceExplorerUrl: burnStep?.explorerUrl,
            destinationExplorerUrl,
            error: result.state === 'error' ? mintStep?.errorMessage || burnStep?.errorMessage : undefined,
        });
    } catch (error: any) {
        console.error("[CCTP Bridge status]", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

async function userBridgeStatus(reference: string) {
  const intent = getUserBridgeIntent(reference);
  if (!intent) {
    return NextResponse.json(
      { success: false, error: "No bridge found for that reference (it may have expired — start the bridge again)." },
      { status: 404 }
    );
  }
  if (intent.state === "success") {
    return NextResponse.json({
      success: true,
      state: "success",
      amount: minorToDisplay(BigInt(intent.amountMinor)),
      burnTxHash: intent.burnTxHash,
    });
  }
  if (intent.state === "error") {
    return NextResponse.json({
      success: true,
      state: "error",
      error: intent.error ?? "Bridge failed.",
    });
  }
  if (intent.state !== "minting") {
    // Pre-mint states (needs-approval / needs-burn / executing /
    // confirming) are driven by the challenge endpoint, not by polling —
    // report where the bridge is waiting.
    return NextResponse.json({
      success: true,
      state: intent.state,
      reference: intent.reference,
    });
  }
  // Minting: poll the Arc balance-delta. No baseline (restart edge) means
  // we cannot prove the mint — keep reporting minting rather than guessing.
  if (intent.balanceBeforeMinor === null) {
    return NextResponse.json({ success: true, state: "minting", reference: intent.reference });
  }
  try {
    const now = await readArcUsdcBalanceOf(intent.recipientAddress);
    const credited = now - BigInt(intent.balanceBeforeMinor);
    const expected = BigInt(intent.amountMinor) - BigInt(intent.maxFeeMinor);
    if (credited >= expected) {
      intent.state = "success";
      setUserBridgeIntent(intent);
      const net = getNetworkConfig();
      return NextResponse.json({
        success: true,
        state: "success",
        amount: minorToDisplay(BigInt(intent.amountMinor)),
        burnTxHash: intent.burnTxHash,
        destinationExplorerUrl: intent.burnTxHash
          ? `${net.explorerBaseUrl}/address/${intent.recipientAddress}`
          : undefined,
      });
    }
    return NextResponse.json({ success: true, state: "minting", reference: intent.reference });
  } catch {
    // Arc RPC flake (documented cluster instability) — transient, keep
    // polling rather than failing the bridge.
    return NextResponse.json({ success: true, state: "minting", reference: intent.reference });
  }
}
