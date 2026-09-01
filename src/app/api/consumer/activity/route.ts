// src/app/api/consumer/activity/route.ts
import { NextRequest, NextResponse } from "next/server";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { prisma } from "@/src/lib/prisma";

export async function GET(req: NextRequest) {
    try {
        const walletAddress = await resolveConsumerSession(req);
        if (!walletAddress) {
            return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
        }

        const logs = await prisma.paymentLog.findMany({
            where: {
                OR: [
                    { senderEmail: walletAddress },
                    { merchantSCA: walletAddress },
                ],
            },
            orderBy: { timestamp: "desc" },
            take: 20,
        });

        const now = Date.now();
        const activity = logs.map((log) => {
            const isExpired =
                log.status === "PENDING" && (log as any).expiresAt != null && now > new Date((log as any).expiresAt).getTime();
            const displayStatus = isExpired ? "EXPIRED" : log.status;
            return {
                reference: log.reference,
                amount: log.amount,
                currency: log.currency,
                status: displayStatus,
                rawStatus: log.status,
                displayStatus,
                isExpired,
                expiresAt: (log as any).expiresAt ?? null,
                timestamp: log.timestamp,
                direction: log.senderEmail === walletAddress ? "out" : "in",
                counterparty:
                    log.senderEmail === walletAddress ? log.merchantSCA || log.merchant : log.senderEmail,
                explorerUrl: log.arcTxHash ? `https://testnet.arcscan.app/tx/${log.arcTxHash}` : null,
            };
        });

        return NextResponse.json({ success: true, activity });
    } catch (error: any) {
        console.error("[consumer/activity]", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
