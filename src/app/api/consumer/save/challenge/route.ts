// src/app/api/consumer/save/challenge/route.ts
//
// RETIRED (consumer wallet restoration): this endpoint minted the
// per-cycle USDC transfer challenge for Circle USER_CONTROLLED wallets
// (browser-executed via the Circle Web SDK). The user-controlled consumer
// architecture has been removed — CIRCLE developer-controlled wallets keep
// the automatic /api/payments/scheduled path, and EXTERNAL wallets cannot
// be debited server-side. This route now answers 410 Gone so old clients
// fail loudly.

import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      code: "SAVE_CHALLENGE_RETIRED",
      error:
        "Manual savings challenges are no longer supported. FlareHQ-created wallets save automatically — set up the plan in the Save form.",
    },
    { status: 410 }
  );
}
