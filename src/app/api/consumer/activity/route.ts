// src/app/api/consumer/activity/route.ts
import { NextRequest, NextResponse } from "next/server";
import { resolveConsumerSession } from "@/src/lib/middleware/withConsumerAuth";
import { prisma } from "@/src/lib/prisma";
import { resolveRowCurrency, tokenAddressFor } from "@/src/lib/tokens/resolveCurrency";
import { explorerTxUrl } from "@/lib/config/network";

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
            // Canonical settlement-token identity; legacy rows default to USDC.
            let token: { symbol: "USDC" | "EURC"; address: string; decimals: number };
            try {
                token = resolveRowCurrency({ currency: log.currency, tokenAddress: (log as any).tokenAddress });
            } catch {
                token = { symbol: "USDC", address: tokenAddressFor("USDC"), decimals: 6 };
            }
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
                explorerUrl: log.arcTxHash ? `${explorerTxUrl(log.arcTxHash)}` : null,
                token,
            };
        });

        // ── Flow Swap history (additive read-model, PaymentLog untouched) ──
        // FlowSwapIntent is a dedicated self-custody swap record — never a
        // payment ledger row. Only EXECUTED intents appear here, with the
        // server-verified actuals (actualInput/OutputAmount are set only by
        // POST /api/swap/verify after on-chain proof) and the explorer link
        // from the verified execution tx. The 'swap:' reference prefix keeps
        // keys distinct from payment references (no duplicate entries).
        const swaps = await (prisma as any).flowSwapIntent.findMany({
            where: { ownerWallet: walletAddress, status: "EXECUTED" },
            orderBy: { updatedAt: "desc" },
            take: 20,
        }).catch(() => []);
        const toDisplay = (baseUnits: unknown): string => {
            try {
                const s = BigInt(String(baseUnits)).toString().padStart(7, "0");
                return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "") || "0";
            } catch {
                return String(baseUnits ?? "0");
            }
        };
        const swapActivity = (swaps as any[]).map((s) => ({
            kind: "swap",
            reference: `swap:${s.id}`,
            amount: Number(BigInt(s.actualOutputAmount ?? s.minOutputSwap ?? "0")) / 1e6,
            currency: s.outputSymbol,
            status: "EXECUTED",
            rawStatus: "EXECUTED",
            displayStatus: "EXECUTED",
            isExpired: false,
            expiresAt: null,
            timestamp: s.updatedAt,
            direction: "out",
            counterparty: s.ownerWallet,
            explorerUrl: s.executionTxHash ? `${explorerTxUrl(s.executionTxHash)}` : null,
            token: null,
            inputSymbol: s.inputSymbol,
            outputSymbol: s.outputSymbol,
            inputAmountDisplay: toDisplay(s.actualInputAmount ?? s.inputAmount),
            outputAmountDisplay: toDisplay(s.actualOutputAmount ?? s.minOutputSwap),
        }));

        // ── EXTERNAL Bridge history (additive read-model, PaymentLog untouched) ──
        // FlowBridgeIntent is a dedicated self-custody bridge record — never
        // a payment ledger row. Only COMPLETED intents appear here (the mint
        // was proven on Arc by POST /api/cctp/transfer/external/complete),
        // with the server-verified actual credit and the Arc mint explorer
        // link. The 'bridge:' reference prefix keeps keys distinct from
        // payment references (no duplicate entries).
        const bridges = await (prisma as any).flowBridgeIntent.findMany({
            where: { sourceWallet: walletAddress, status: "COMPLETED" },
            orderBy: { updatedAt: "desc" },
            take: 20,
        }).catch(() => []);
        const bridgeActivity = (bridges as any[]).map((b) => ({
            kind: "bridge",
            reference: `bridge:${b.id}`,
            amount: Number(BigInt(b.actualAmount ?? b.amount ?? "0")) / 1e6,
            currency: "USDC",
            status: "COMPLETED",
            rawStatus: "COMPLETED",
            displayStatus: "COMPLETED",
            isExpired: false,
            expiresAt: null,
            timestamp: b.updatedAt,
            direction: "out",
            counterparty: b.destination,
            explorerUrl: b.mintTxHash ? `${explorerTxUrl(b.mintTxHash)}` : null,
            token: null,
            inputSymbol: "USDC",
            outputSymbol: "USDC",
            inputAmountDisplay: toDisplay(b.amount),
            outputAmountDisplay: toDisplay(b.actualAmount ?? b.amount),
            sourceChain: b.sourceChain,
        }));

        const merged = [...activity, ...swapActivity, ...bridgeActivity].sort(
            (a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        ).slice(0, 20);

        return NextResponse.json({ success: true, activity: merged });
    } catch (error: any) {
        console.error("[consumer/activity]", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
