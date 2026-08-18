// src/app/api/payroll/fund/route.ts
//
// Thin wrapper: validates the request body shape, then delegates to
// fundPayrollViaX402() in src/lib/payroll/payrollExecution.ts — the single
// implementation of the payroll funding flow (402 challenge → verify →
// caller-control → spend-limit pre-flight → settle → seller sweep →
// on-chain record → fundBatchFor). See that file for the full order of
// operations and the spend-limit/race-recovery wiring.

import { NextRequest, NextResponse } from "next/server";
import { parseUnits } from "ethers";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { fundPayrollViaX402, type PayrollRecipient } from "@/lib/payroll/payrollExecution";

const MAX_RECIPIENTS = 200; // mirrors the on-chain cap in ArcFlarePayroll._createBatch

interface RawRecipient {
  address: string;
  amount: string | number;
}

function parseRecipients(raw: unknown): PayrollRecipient[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("a non-empty recipients array is required");
  }
  if (raw.length > MAX_RECIPIENTS) {
    throw new Error(`payroll batch too large — max ${MAX_RECIPIENTS} recipients per batch`);
  }

  return (raw as RawRecipient[]).map((r) => {
    if (!r || typeof r.address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(r.address)) {
      throw new Error("each recipient needs a valid address");
    }
    const amount = typeof r.amount === "string" || typeof r.amount === "number" ? String(r.amount) : "";
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || parseFloat(amount) <= 0) {
      throw new Error(`invalid recipient amount: ${r.amount} — use a decimal USDC amount like "0.01"`);
    }
    return { address: r.address, amount: parseUnits(amount, 6) };
  });
}

async function fundPayrollHandler(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    let recipients: PayrollRecipient[];
    try {
      recipients = parseRecipients(body.recipients);
    } catch (validationError: any) {
      return NextResponse.json({ error: validationError.message }, { status: 400 });
    }

    return fundPayrollViaX402(req, recipients, body.token);
  } catch (error: any) {
    console.error("[payroll/fund] error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrAnySession(fundPayrollHandler);