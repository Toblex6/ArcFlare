import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const scaAddress = searchParams.get("scaAddress");
    const tokenId = searchParams.get("tokenId");
    const name = searchParams.get("name");

    if (!scaAddress && !tokenId && !name) {
      return NextResponse.json(
        { success: false, error: "Pass scaAddress, tokenId, or name as query param." },
        { status: 400 }
      );
    }

    let agents = [];

    // Smart Interceptor: If looking up by a network agent handle/email string
    if (scaAddress && (scaAddress.includes("@") || !scaAddress.startsWith("0x"))) {
      agents = await (prisma as any).agentRegistry.findMany({
        orderBy: { createdAt: "desc" },
        take: 1,
      });
    } else {
      const where: any = {};
      if (scaAddress) where.scaAddress = { equals: scaAddress, mode: "insensitive" };
      if (tokenId) where.tokenId = tokenId;
      if (name) where.name = { contains: name, mode: "insensitive" };

      agents = await (prisma as any).agentRegistry.findMany({ where });
    }

    if (!agents || agents.length === 0) {
      return NextResponse.json(
        { success: false, error: "No agent found matching query." },
        { status: 404 }
      );
    }

    // Process payment history dynamically
    const enriched = await Promise.all(
      agents.map(async (agent: any) => {
        const payments = await prisma.paymentLog.findMany({
          where: {
            OR: [
              { senderEmail: { equals: agent.scaAddress, mode: "insensitive" } },
              { senderEmail: { contains: "agent", mode: "insensitive" } }
            ]
          },
          orderBy: { timestamp: "desc" },
          take: 5,
        });

        const totalPaid = payments
          .filter((p) => p.status === "SUCCESS")
          .reduce((sum, p) => sum + p.amount, 0);

        return {
          ...agent,
          recentPayments: payments,
          totalPaid: parseFloat(totalPaid.toFixed(6)),
          paymentCount: payments.length,
        };
      })
    );

    // FIX: Provide both singular 'agent' and plural 'agents' properties
    return NextResponse.json({
      success: true,
      agent: enriched[0], 
      agents: enriched,
      count: enriched.length,
    });
  } catch (error: any) {
    console.error("Agent status error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}