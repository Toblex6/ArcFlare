import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/ratelimit";
import { parseBody, InitializeSchema } from "@/lib/validation";

export async function POST(req: NextRequest) {
  try {
    // 1. Rate Limiting Check
    const { allowed, response: limitResponse } = await checkRateLimit(req, "payments");
    if (!allowed) return limitResponse as NextResponse;

    // 2. Zod Input Validation
    const body = await req.json().catch(() => ({}));
    const { data, error: validationError } = parseBody(InitializeSchema, body);
    if (validationError) return validationError as NextResponse;

    const { amount, currency, email, agentSCA, webhookUrl } = data;

    // 3. Logic... (keep your existing logic here)
    // ...
    
    return NextResponse.json({ 
       success: true, 
       message: "Payment initialized", 
       // ... other data
    });
    
  } catch (error: any) {
    return NextResponse.json({ success: false, error: "Internal Error" }, { status: 500 });
  }
}