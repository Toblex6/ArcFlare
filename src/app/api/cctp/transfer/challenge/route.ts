// src/app/api/cctp/transfer/challenge/route.ts
//
// RETIRED (consumer wallet restoration): this endpoint continued the Circle
// user-controlled bridge flow (browser-executed approve/burn challenges via
// per-request userTokens). The user-controlled consumer architecture has
// been removed — CIRCLE wallets are Circle developer-controlled (the server
// signs) and EXTERNAL wallets sign in the browser. This route now answers
// 410 Gone so old clients fail loudly instead of hanging on an unknown
// reference.

import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      code: "BRIDGE_CHALLENGE_RETIRED",
      error:
        "Browser-executed bridge challenges are no longer supported. FlareHQ-created wallets bridge automatically; external wallets cannot be bridged from by the server.",
    },
    { status: 410 }
  );
}

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      code: "BRIDGE_CHALLENGE_RETIRED",
      error: "Browser-executed bridge challenges are no longer supported.",
    },
    { status: 410 }
  );
}
