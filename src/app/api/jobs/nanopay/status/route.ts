import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getNanopaymentStreamStatus } from "@/lib/jobs/nanopaymentSplit";

async function statusHandler(req: NextRequest) {
  try {
    const body = await req.json();
    const { jobId } = body as { jobId?: string };

    if (!jobId) {
      return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
    }

    const status = await getNanopaymentStreamStatus(jobId);
    return NextResponse.json({ success: true, status });
  } catch (error: any) {
    console.error("Nanopay status error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export const POST = statusHandler;