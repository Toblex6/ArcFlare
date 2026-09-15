// src/app/api/consumer/save/confirm/route.ts
//
// RETIRED (consumer wallet restoration): this endpoint confirmed the
// browser-executed savings challenge for Circle USER_CONTROLLED wallets.
// The user-controlled consumer architecture has been removed. This route
// now answers 410 Gone so old clients fail loudly.

import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      code: "SAVE_CONFIRM_RETIRED",
      error: "Manual savings challenges are no longer supported.",
    },
    { status: 410 }
  );
}
