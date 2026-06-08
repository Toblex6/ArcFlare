// src/app/api/payments/nano/settle/route.ts
// Batch settles all unsettled nanopayments for an agent-merchant pair.
// Aggregates micro-charges into one USDC payment via ArcFlare settle route.
// Can also auto-settle ALL pairs that have reached threshold.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKey } from "@/lib/middleware/withApiKey";
import { checkRateLimit } from "@/lib/ratelimit";
import { parseBody, NanoSettleSchema } from "@/lib/validation";
import {
  getUnsettledBalance,
  markBatchSettled,
  getUnsettledPairs,
  getBatchSummary,
  NANO_BATCH_THRESHOLD_USDC,
} from "@/lib/nanopayment";

// ─── Settle a specific agent-merchant pair ────────────────────────────────────
async function settleNanoHandler(request: NextRequest) {
  try {
    // 1. Rate Limiting Check
    const { allowed, response: limitResponse } = await checkRateLimit(request, "nano");
    if (!allowed) return limitResponse;

    // 2. Zod Input Validation Check
    const body = await request.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(NanoSettleSchema, body);
    if (validationError) return validationError;

    const {
      agentSCA,
      merchantSCA,
      webhookUrl,
      forceSettle,  // Skip threshold check and settle anyway
      autoSettle,   // Pass { "autoSettle": true } to settle all pairs at threshold
    } = data;

    // ── Auto-settle ALL pairs mode ────────────────────────────────────────
    if (autoSettle) {
      return autoSettleAll();
    }

    if (!agentSCA || !merchantSCA) {
      return NextResponse.json(
        { success: false, error: "agentSCA and merchantSCA are required." },
        { status: 400 }
      );
    }

    const { total, count } = await getUnsettledBalance(agentSCA, merchantSCA);

    if (total <= 0) {
      return NextResponse.json(
        { success: false, error: "No unsettled nanopayments found." },
        { status: 400 }
      );
    }

    if (!forceSettle && total < NANO_BATCH_THRESHOLD_USDC) {
      return NextResponse.json(
        {
          success: false,
          error: `Batch not ready. ${total.toFixed(6)} USDC pending, threshold is ${NANO_BATCH_THRESHOLD_USDC} USDC.`,
          unsettledBalance: total,
          unsettledCount: count,
          thresholdUSDC: NANO_BATCH_THRESHOLD_USDC,
        },
        { status: 400 }
      );
    }

    const batchRef = `nano_batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const paymentReference = `arc_nano_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // ── Create a PaymentLog for the batch ─────────────────────────────────
    await prisma.paymentLog.create({
      data: {
        reference: paymentReference,
        amount: parseFloat(total.toFixed(6)),
        currency: "USDC",
        chain: "Arc Testnet v1.0 (Nano Batch)",
        senderEmail: agentSCA,
        merchant: merchantSCA,
        status: "PENDING",
        webhookUrl: webhookUrl || null,
      },
    });

    // ── Settle via M2M Local Routing Path ─────────────────────────────────
    const internalPort = process.env.PORT || "10000";
    const baseUrl = `http://127.0.0.1:${internalPort}`;
    
    const settleRes = await fetch(`${baseUrl}/api/payments/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.INTERNAL_API_KEY || "",
      },
      body: JSON.stringify({ reference: paymentReference }),
    });

    const responseText = await settleRes.text();
    let settleData;
    try {
      settleData = JSON.parse(responseText);
    } catch (err) {
      throw new Error(`Internal local route returned non-JSON (${settleRes.status}): ${responseText}`);
    }

    if (!settleData.success) {
      throw new Error(`Settlement failed: ${settleData.error}`);
    }

    // ── Mark all nano payments as settled ─────────────────────────────────
    await markBatchSettled(agentSCA, merchantSCA);

    console.log(`✅ Nano batch settled: ${count} payments, ${total.toFixed(6)} USDC, ref: ${batchRef}`);

    if (webhookUrl) {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "nano.batch_settled",
          batchRef,
          paymentReference,
          agentSCA,
          merchantSCA,
          totalSettled: parseFloat(total.toFixed(6)),
          paymentsCount: count,
          currency: "USDC",
          settledAt: new Date().toISOString(),
        }),
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      batchRef,
      paymentReference,
      totalSettled: parseFloat(total.toFixed(6)),
      paymentsCount: count,
      agentSCA,
      merchantSCA,
      message: `Nano batch settled — ${count} payments totalling ${total.toFixed(6)} USDC.`,
    });
  } catch (error: any) {
    console.error("Nano settle error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// ─── Auto-settle ALL pairs that have reached threshold ────────────────────────
async function autoSettleAll() {
  const pairs = await getUnsettledPairs();
  const results: any[] = []; 

  for (const pair of pairs) {
    const summary = await getBatchSummary(pair.agentSCA, pair.merchantSCA);

    if (!summary.shouldSettle) continue;

    try {
      const batchRef = `nano_auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const paymentReference = `arc_nano_auto_${Date.now().toString(36)}`;

      await prisma.paymentLog.create({
        data: {
          reference: paymentReference,
          amount: parseFloat(summary.total.toFixed(6)),
          currency: "USDC",
          chain: "Arc Testnet v1.0 (Nano Auto-Batch)",
          senderEmail: pair.agentSCA,
          merchant: pair.merchantSCA,
          status: "PENDING",
        },
      });

      // ── Settle via M2M Local Routing Path ─────────────────────────────────
      const internalPort = process.env.PORT || "10000";
      const baseUrl = `http://127.0.0.1:${internalPort}`;
      
      const settleRes = await fetch(`${baseUrl}/api/payments/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.INTERNAL_API_KEY || "",
        },
        body: JSON.stringify({ reference: paymentReference }),
      });

      const responseText = await settleRes.text();
      let settleData;
      try {
        settleData = JSON.parse(responseText);
      } catch (err) {
        throw new Error(`Internal local route returned non-JSON (${settleRes.status}): ${responseText}`);
      }

      if (!settleData.success) {
         throw new Error(`Settlement failed: ${settleData.error}`);
      }

      await markBatchSettled(pair.agentSCA, pair.merchantSCA);
      
      results.push({
        agentSCA: pair.agentSCA,
        merchantSCA: pair.merchantSCA,
        totalSettled: summary.total,
        count: summary.count,
        batchRef,
        success: true,
      });
      
    } catch (err: any) {
      results.push({
        agentSCA: pair.agentSCA,
        merchantSCA: pair.merchantSCA,
        success: false,
        error: err.message,
      });
    }
  }

  return NextResponse.json({
    success: true,
    settledPairs: results.filter((r: any) => r.success).length,
    failedPairs: results.filter((r: any) => !r.success).length,
    results,
    message: `Auto-settled ${results.filter((r: any) => r.success).length} pairs.`,
  });
}

export const POST = withApiKey(settleNanoHandler as any);