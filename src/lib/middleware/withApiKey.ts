// src/lib/middleware/withApiKey.ts
// Internal-service-key gate: the x-api-key (header or query param) must
// match an ACTIVE row in the ApiKey table. There is no method-level bypass —
// GET is gated exactly like every other verb, so protected read endpoints
// are not silently public.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export function withApiKey(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      // Extract API key from header or query param
      const nextUrl = new URL(req.url);
      const apiKey = req.headers.get("x-api-key") ?? nextUrl.searchParams.get("apiKey");

      if (!apiKey) {
        return NextResponse.json(
          { success: false, error: "Missing API key." },
          { status: 401 }
        );
      }

      // Validate API key in database — inactive/deactivated keys must not authenticate
      const apiKeyRecord = await (prisma as any).apiKey.findUnique({
        where: { key: apiKey },
      });

      if (!apiKeyRecord || !apiKeyRecord.active) {
        return NextResponse.json(
          { success: false, error: "Invalid or deactivated API key." },
          { status: 403 }
        );
      }

      // Attach the API key record to the request for downstream use
      (req as any).apiKey = apiKeyRecord;

      // Proceed to the actual handler
      return await handler(req);
    } catch (error: any) {
      console.error("Auth System Error:", error);
      return NextResponse.json(
        { success: false, error: "Internal Auth Error" },
        { status: 500 }
      );
    }
  };
}