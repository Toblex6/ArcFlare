// src/app/api/consumer/circle/route.ts
//
// Thin server proxy for Circle user-controlled wallet onboarding
// (Google social login + email OTP). The browser's Web SDK cannot call
// Circle directly (it needs CIRCLE_API_KEY + the configured App ID), so it
// calls here with one `action` per Circle step:
//
//   POST { action: "social-token", deviceId }
//     → { deviceToken, deviceEncryptionKey } (then the SDK performs Google login)
//   POST { action: "email-token", deviceId, email }
//     → { deviceToken, deviceEncryptionKey, otpToken } (then the SDK verifies the OTP)
//   POST { action: "initialize", userToken }
//     → { challengeId } (then the SDK executes the challenge to create the wallet)
//       Circle code 155106 (CIRCLE_155106) = returning user, already
//       initialized — the client must call "wallets" instead, NOT retry.
//   POST { action: "wallets", userToken }
//     → { wallets: [{ id, address, blockchain, state }] } (authoritative list)
//   POST { action: "refresh", userToken, refreshToken }
//     → { userToken, refreshToken } (session extension before expiry)
//
// The userToken lives in browser memory only and is forwarded per call — it
// is never persisted, never logged, and never set as a cookie here. The
// FlareHQ consumer session is issued separately by POST
// /api/consumer/session { circleAuth } after server-side verification.

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/src/lib/ratelimit";
import {
  createEmailDeviceToken,
  createSocialDeviceToken,
  initializeUserControlledUser,
  listUserControlledWallets,
  refreshUserControlledToken,
} from "@/src/lib/circle/userControlled";

type Action = "social-token" | "email-token" | "initialize" | "wallets" | "refresh";

function fail(error: unknown) {
  const status =
    typeof (error as any)?.status === "number" ? (error as any).status : 500;
  const code = typeof (error as any)?.code === "string" ? (error as any).code : undefined;
  const message =
    status === 500 || status === 502 || status === 503
      ? "Circle wallet service is unavailable right now. Try again."
      : String((error as any)?.message ?? "Request failed.");
  if (status === 500) console.error("[consumer/circle]", error);
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, "session");
    if (!allowed) return limitResponse as NextResponse;

    const body = await req.json().catch(() => ({}));
    const action = body?.action as Action;

    switch (action) {
      case "social-token": {
        if (typeof body?.deviceId !== "string" || !body.deviceId.trim()) {
          return NextResponse.json(
            { success: false, error: "deviceId from the Circle Web SDK is required." },
            { status: 400 }
          );
        }
        const tokens = await createSocialDeviceToken(body.deviceId);
        return NextResponse.json({ success: true, ...tokens });
      }

      case "email-token": {
        if (typeof body?.deviceId !== "string" || !body.deviceId.trim()) {
          return NextResponse.json(
            { success: false, error: "deviceId from the Circle Web SDK is required." },
            { status: 400 }
          );
        }
        if (typeof body?.email !== "string" || !body.email.trim()) {
          return NextResponse.json(
            { success: false, error: "A valid email address is required." },
            { status: 400 }
          );
        }
        const tokens = await createEmailDeviceToken(body.deviceId, body.email);
        return NextResponse.json({ success: true, ...tokens });
      }

      case "initialize": {
        if (typeof body?.userToken !== "string" || !body.userToken.trim()) {
          return NextResponse.json(
            { success: false, error: "Circle authentication is required — complete Google/email login first." },
            { status: 401 }
          );
        }
        const result = await initializeUserControlledUser(body.userToken);
        return NextResponse.json({ success: true, ...result });
      }

      case "wallets": {
        if (typeof body?.userToken !== "string" || !body.userToken.trim()) {
          return NextResponse.json(
            { success: false, error: "Circle authentication is required — complete Google/email login first." },
            { status: 401 }
          );
        }
        const wallets = await listUserControlledWallets(body.userToken);
        return NextResponse.json({ success: true, wallets });
      }

      case "refresh": {
        if (typeof body?.userToken !== "string" || !body.userToken.trim()) {
          return NextResponse.json(
            { success: false, error: "Circle authentication is required." },
            { status: 401 }
          );
        }
        if (typeof body?.refreshToken !== "string" || !body.refreshToken.trim()) {
          return NextResponse.json(
            { success: false, error: "refreshToken is required." },
            { status: 400 }
          );
        }
        const tokens = await refreshUserControlledToken(body.userToken, body.refreshToken);
        return NextResponse.json({ success: true, ...tokens });
      }

      default:
        return NextResponse.json(
          {
            success: false,
            error: 'Unknown action. Expected one of: "social-token", "email-token", "initialize", "wallets", "refresh".',
          },
          { status: 400 }
        );
    }
  } catch (error: unknown) {
    return fail(error);
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    status: "ready",
    message: "Circle user-controlled wallet proxy (Google social login + email OTP).",
  });
}
