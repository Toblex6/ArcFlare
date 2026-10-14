import { NextResponse } from 'next/server';

// DISABLED (410 Gone) — this legacy route is intentionally retired and must
// not be revived without review. Reasons:
//
// 1. No verified callers: the merchant dashboard UI uses /api/merchant/me +
//    /api/payments/all + /api/merchant/platform-fees; docs advertise
//    /api/payments/all, not this path. (Local-source evidence only —
//    external clients may still hold the URL, hence 410 with a pointer
//    instead of silent deletion.)
// 2. Unsafe as written: `include: { payments: true }` has no backing Prisma
//    relation (Merchant declares no `payments` field) so every call 500s;
//    auth was x-api-key-only with no active/verified/sessionVersion check;
//    it echoed the FULL apiKey secret in the response body.
//
// Replacement: GET /api/merchant/me (cookie-authed profile + masked key hint
// + recent payments) and GET /api/payments/all (full payment history).
export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error:
        'This endpoint is retired (410 Gone). Use GET /api/merchant/me for the profile and GET /api/payments/all for payment history.',
    },
    { status: 410 }
  );
}
