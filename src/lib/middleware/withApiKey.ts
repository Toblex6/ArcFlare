// src/lib/middleware/withApiKey.ts
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export function withApiKey(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      // Allow GET requests to bypass API key check (e.g., public endpoints)
      if (req.method === "GET") {
        return await handler(req);
      }

      // Extract API key from header or query param
      const nextUrl = new URL(req.url);
      const apiKey = req.headers.get("x-api-key") ?? nextUrl.searchParams.get("apiKey");

      if (!apiKey) {
        return NextResponse.json(
          { success: false, error: "Missing API key." },
          { status: 401 }
        );
      }

      // Validate API key in database
      const apiKeyRecord = await (prisma as any).apiKey.findUnique({
        where: { key: apiKey },
      });

      if (!apiKeyRecord) {
        return NextResponse.json(
          { success: false, error: "Invalid API key." },
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