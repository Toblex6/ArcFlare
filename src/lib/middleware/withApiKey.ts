import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Middleware wrapper to protect API endpoints using x-api-key auth.
 */
export function withApiKey(handler: (req: NextRequest, context?: any) => Promise<NextResponse>) {
  return async (req: NextRequest, context?: any) => {
    try {
      // 💡 GET requests bypass the key check (e.g., for dashboard loading)
      if (req.method === "GET") {
        return await handler(req, context);
      }

      const nextUrl = new URL(req.url);
      const apiKey =
        req.headers.get("x-api-key") ??
        nextUrl.searchParams.get("apiKey");

      if (!apiKey) {
        return NextResponse.json(
          { success: false, error: "Missing API key. Pass x-api-key header or apiKey query param." },
          { status: 401 }
        );
      }

      // Query database for matching active API key token
      const record = await prisma.apiKey.findUnique({
        where: { key: apiKey },
      });

      if (!record || !record.active) {
        return NextResponse.json(
          { success: false, error: "Invalid or revoked API key." },
          { status: 403 }
        );
      }

      // Bump usage counter (Fire and forget)
      prisma.apiKey
        .update({
          where: { key: apiKey },
          data: { 
            usageCount: { increment: 1 }, 
            lastUsedAt: new Date() 
          },
        })
        .catch((e: Error) => console.error("Metrics increment failed:", e.message));

      return await handler(req, context);

    } catch (error: any) {
      console.error("Authentication Gateway Error:", error);
      return NextResponse.json(
        { success: false, error: "Internal Authentication System Error" },
        { status: 500 }
      );
    }
  };
}