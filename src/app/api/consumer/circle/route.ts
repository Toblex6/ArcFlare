// src/app/api/consumer/circle/route.ts
//
// RETIRED (consumer wallet restoration): this endpoint proxied the Circle
// user-controlled wallet onboarding (Google social login + email OTP device
// tokens, initialize, wallets, refresh). The user-controlled consumer
// architecture has been removed — consumers sign in with a verified email
// code (POST/PUT /api/consumer/email-auth, Circle developer-controlled SCA)
// or connect an external wallet (POST /api/consumer/session). This route
// now answers 410 Gone so old clients fail loudly instead of hanging in
// the retired onboarding ceremony.

import { NextResponse } from "next/server";

function retired() {
  return NextResponse.json(
    {
      success: false,
      code: "CIRCLE_USER_CONTROLLED_RETIRED",
      error:
        "Circle user-controlled sign-in is no longer supported. Sign in with an email code or connect an external wallet instead.",
    },
    { status: 410 }
  );
}

export async function POST() {
  return retired();
}

export async function GET() {
  return retired();
}
