// src/app/api/agent/status/route.ts
// Returns agent wallet details from AgentRegistry by SCA address or API key.
// Used by agents to fetch their own wallet before making payments.

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

    const where: any = {};
    if (scaAddress) where.scaAddress = scaAddress;
    if (tokenId) where.tokenId = tokenId;
    if (name) where.name = { contains: name };

    const agents = await (prisma as any).agentRegistry.findMany({ where });

    if (!agents || agents.length === 0) {
      return NextResponse.json(
        { success: false, error: "No agent found matching query." },
        { status: 404 }
      );
    }

    // For each agent, get their payment history
    const enriched = await Promise.all(
      agents.map(async (agent: any) => {
        const payments = await prisma.paymentLog.findMany({
          where: { senderEmail: agent.scaAddress },
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

    return NextResponse.json({
      success: true,
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