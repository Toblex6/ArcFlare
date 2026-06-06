import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Prevent internal Next.js build-time prerendering issues
export const dynamic = "force-dynamic";

//const prisma = new PrismaClient();

// Canonical Factory address for dynamic on-demand deployments
const ARCFLARE_FACTORY_ADDRESS = "0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F";

/**
 * POST /api/escrow
 * Creates a localized tracking instance for an escrow payment interaction
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { reference, merchantAddress, agentId, amount } = body;

    // 1. Strict validation of parameters
    if (!reference || !merchantAddress || !amount) {
      return NextResponse.json(
        { error: "Missing required parameters: reference, merchantAddress, and amount are mandatory." },
        { status: 400 }
      );
    }

    console.log(`[ArcFlare API] Processing Escrow Provisioning for Ref: ${reference}`);

    // 2. Persistent storage layer write utilizing Prisma
    // This leverages the unique index constraint successfully pushed to Render Postgres
    const newEscrowRecord = await prisma.escrow.create({
      data: {
        reference: reference,
        merchantAddress: merchantAddress,
        agentId: agentId ? String(agentId) : null,
        amount: String(amount), // Kept as string to preserve high-precision 6-decimal token counts safely
        status: "PENDING",       // Global state tracks: PENDING -> DEPLOYED -> DEPOSITED -> SETTLED
        factoryUsed: ARCFLARE_FACTORY_ADDRESS,
      },
    });

    // 3. Return the payload to the calling client or Agentic workflow loop
    return NextResponse.json(
      {
        success: true,
        message: "Escrow tracking matrix initialized successfully.",
        data: {
          id: newEscrowRecord.id,
          reference: newEscrowRecord.reference,
          status: newEscrowRecord.status,
          ArcFlareFactory: ARCFLARE_FACTORY_ADDRESS
        }
      },
      { status: 201 }
    );

  } catch (error: any) {
    console.error("[ArcFlare API Error] Failed to process escrow initialization:", error);
    
    // Graceful error classification for unique reference collisions
    if (error.code === "P2002") {
      return NextResponse.json(
        { error: "Conflict: An escrow allocation with this exact reference already exists." },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: "Internal Server Error", details: error.message },
      { status: 500 }
    );
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * GET /api/escrow
 * Retrieves or filters active tracking entries from your database instance
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const reference = searchParams.get("reference");

    if (reference) {
      const entry = await prisma.escrow.findUnique({
        where: { reference: reference },
      });

      if (!entry) {
        return NextResponse.json({ error: "Escrow record not found." }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: entry }, { status: 200 });
    }

    // Return a subset of the latest global allocations if no specific reference is flagged
    const recentEscrows = await prisma.escrow.findMany({
      take: 10,
      orderBy: { id: "desc" },
    });

    return NextResponse.json({ success: true, data: recentEscrows }, { status: 200 });

  } catch (error: any) {
    console.error("[ArcFlare API Error] Query failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  } finally {
    await prisma.$disconnect();
  }
}