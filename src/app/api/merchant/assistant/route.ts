// src/app/api/merchant/assistant/route.ts
// FlareHQ Merchant Money Assistant — natural-language business finance helper.
// NOT x402-gated: the merchant is already authenticated via merchant_token,
// this is their own dashboard feature, not agent-to-agent commerce.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/ratelimit";
import { jwtVerify } from "jose";
import { tryJwtSecret } from "@/src/lib/auth/secrets";

const JWT_SECRET = tryJwtSecret('MERCHANT_JWT_SECRET');
const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

async function getMerchantFromCookie(req: NextRequest) {
    const token = req.cookies.get("merchant_token")?.value;
    if (!token || !JWT_SECRET) return null;
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const merchantId = payload.merchantId as string;
    return prisma.merchant.findUnique({ where: { id: merchantId } });
}

// ── TOOL DEFINITIONS ────────────────────────────────────────────────────────
const ASSISTANT_TOOLS = [
    {
        name: "get_spending_summary",
        description:
            "Get a summary of the merchant's payment activity over a time period — total volume, transaction count, success rate. Use for questions like 'how much did I make this week' or 'show my revenue'.",
        input_schema: {
            type: "object",
            properties: {
                days: { type: "number", description: "How many days back to look. Default 30." },
            },
            required: [],
        },
    },
    {
        name: "set_budget",
        description:
            "Set or update a monthly spending budget for a category. Use when the merchant says something like 'set a budget of 500 for marketing' or 'I want to limit payroll to 2000 a month'.",
        input_schema: {
            type: "object",
            properties: {
                category: { type: "string", description: "Budget category, e.g. payroll, marketing, supplies" },
                monthlyLimit: { type: "number" },
            },
            required: ["category", "monthlyLimit"],
        },
    },
    {
        name: "check_budgets",
        description:
            "List all budgets the merchant has set, with their limits. Use for 'what are my budgets' or 'show my spending limits'.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "create_reminder",
        description:
            "Create a bill or payment reminder. Use for 'remind me to pay rent on the 1st' or 'I need to pay my supplier 200 USDC next Friday'.",
        input_schema: {
            type: "object",
            properties: {
                description: { type: "string" },
                amount: { type: "number", description: "Optional amount if this is a payment reminder" },
                dueDate: { type: "string", description: "ISO date string for when this is due" },
                recurring: { type: "boolean", description: "True if this repeats" },
                intervalDays: { type: "number", description: "If recurring, how many days between occurrences" },
            },
            required: ["description", "dueDate"],
        },
    },
    {
        name: "list_reminders",
        description:
            "List upcoming, uncompleted reminders. Use for 'what bills do I have coming up' or 'show my reminders'.",
        input_schema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "complete_reminder",
        description: "Mark a reminder as done/paid. Requires the reminder's description to match against.",
        input_schema: {
            type: "object",
            properties: {
                description: { type: "string", description: "Description text to match against existing reminders" },
            },
            required: ["description"],
        },
    },
];

const GROQ_TOOLS = ASSISTANT_TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// ── TOOL EXECUTORS — every query/write scoped to merchantId ──────────────────
async function executeTool(name: string, input: any, merchant: any): Promise<any> {
    switch (name) {
        case "get_spending_summary": {
            const days = input.days || 30;
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            const payments = await prisma.paymentLog.findMany({
                where: { merchant: merchant.businessName, timestamp: { gte: since } },
            });
            const successful = payments.filter((p) => p.status === "SUCCESS");
            const totalVolume = successful.reduce((sum, p) => sum + p.amount, 0);
            return {
                success: true,
                periodDays: days,
                totalTransactions: payments.length,
                successfulTransactions: successful.length,
                totalVolume: parseFloat(totalVolume.toFixed(4)),
                currency: "USDC",
            };
        }

        case "set_budget": {
            const existing = await (prisma as any).merchantBudget.findFirst({
                where: { merchantId: merchant.id, category: input.category },
            });
            const budget = existing
                ? await (prisma as any).merchantBudget.update({
                    where: { id: existing.id },
                    data: { monthlyLimit: input.monthlyLimit },
                })
                : await (prisma as any).merchantBudget.create({
                    data: { merchantId: merchant.id, category: input.category, monthlyLimit: input.monthlyLimit },
                });
            return { success: true, category: budget.category, monthlyLimit: budget.monthlyLimit };
        }

        case "check_budgets": {
            const budgets = await (prisma as any).merchantBudget.findMany({ where: { merchantId: merchant.id } });
            return { success: true, budgets: budgets.map((b: any) => ({ category: b.category, monthlyLimit: b.monthlyLimit })) };
        }

        case "create_reminder": {
            const reminder = await (prisma as any).merchantReminder.create({
                data: {
                    merchantId: merchant.id,
                    description: input.description,
                    amount: input.amount || null,
                    dueDate: new Date(input.dueDate),
                    recurring: !!input.recurring,
                    intervalDays: input.intervalDays || null,
                },
            });
            return { success: true, description: reminder.description, dueDate: reminder.dueDate };
        }

        case "list_reminders": {
            const reminders = await (prisma as any).merchantReminder.findMany({
                where: { merchantId: merchant.id, completed: false },
                orderBy: { dueDate: "asc" },
            });
            return {
                success: true,
                reminders: reminders.map((r: any) => ({
                    description: r.description,
                    amount: r.amount,
                    dueDate: r.dueDate,
                    recurring: r.recurring,
                })),
            };
        }

        case "complete_reminder": {
            const match = await (prisma as any).merchantReminder.findFirst({
                where: { merchantId: merchant.id, completed: false, description: { contains: input.description, mode: "insensitive" } },
            });
            if (!match) return { error: "No matching uncompleted reminder found." };
            await (prisma as any).merchantReminder.update({ where: { id: match.id }, data: { completed: true } });
            return { success: true, description: match.description };
        }

        default:
            return { error: `Unknown tool: ${name}` };
    }
}

// ── Route Handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
    try {
        const { allowed, response: limitResponse } = await checkRateLimit(req, "default");
        if (!allowed) return limitResponse;

        const merchant = await getMerchantFromCookie(req);
        if (!merchant) {
            return NextResponse.json({ success: false, error: "Not authenticated." }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const { message } = body;
        if (!message) {
            return NextResponse.json({ success: false, error: "message is required" }, { status: 400 });
        }

        const system = `You are FlareHQ's Money Assistant for merchants — a business finance helper for ${merchant.businessName}.
Today's date: ${new Date().toISOString().slice(0, 10)}.

You can:
- Summarize their payment activity/revenue — use get_spending_summary
- Set and check monthly budgets by category — use set_budget, check_budgets
- Create and manage bill/payment reminders — use create_reminder, list_reminders, complete_reminder

IMPORTANT:
- Convert relative dates ("next Friday", "the 1st") to actual ISO dates based on today's date before calling create_reminder.
- Be concise and business-focused. Always report actual numbers from tool results, never estimate.
- If a tool result has an error, explain it plainly and suggest what to do next — don't retry blindly.`;

        const messages: any[] = [
            { role: "system", content: system },
            { role: "user", content: message },
        ];

        let loop = true;
        let iters = 0;
        const toolsUsed: string[] = [];
        const results: any[] = [];

        while (loop && iters < 4) {
            iters++;
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                    max_tokens: 512,
                    temperature: 0.1,
                    messages,
                    tools: GROQ_TOOLS,
                    tool_choice: "auto",
                }),
            });

            if (!res.ok) {
                // Honest failure: the old path returned HTTP 200 with a
                // chatty "I ran into a problem" success body, which made
                // upstream outages (e.g. a dead Groq model) invisible.
                const detail = await res.text().catch(() => "");
                console.error(`[assistant] Groq error ${res.status}:`, detail);
                return NextResponse.json(
                    {
                        success: false,
                        error: `Assistant backend error (${res.status}). Check GROQ_MODEL / GROQ_API_KEY configuration and try again.`,
                        toolsUsed,
                        results,
                    },
                    { status: 502 }
                );
            }

            const data = await res.json();
            const choice = data.choices?.[0];
            if (!choice) {
                return NextResponse.json({ success: true, response: "I didn't get a usable response — please try again.", toolsUsed, results });
            }

            const msg = choice.message;
            const toolCalls = msg.tool_calls || [];

            if (toolCalls.length === 0) {
                return NextResponse.json({ success: true, response: msg.content || "Done.", toolsUsed, results });
            }

            messages.push({ role: "assistant", content: msg.content || null, tool_calls: toolCalls });

            for (const tc of toolCalls) {
                const name = tc.function.name;
                let args: any = {};
                try { args = JSON.parse(tc.function.arguments || "{}"); } catch { }

                toolsUsed.push(name);
                let result: any;
                try {
                    result = await executeTool(name, args, merchant);
                } catch (e: any) {
                    result = { error: e?.message || "Tool execution failed." };
                }
                results.push({ tool: name, result });
                messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
            }
        }

        return NextResponse.json({ success: true, response: "I've completed that.", toolsUsed, results });
    } catch (error: any) {
        console.error("[assistant] Error:", error);
        return NextResponse.json({ success: false, error: "Internal server error." }, { status: 500 });
    }
}