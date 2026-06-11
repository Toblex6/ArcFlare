import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function POST(req: Request) {
  const secret = req.headers.get("x-admin-secret");
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await prisma.paymentLog.updateMany({
    where: {
      status: {
        notIn: ["SUCCESS", "REDEEMED_AND_MINTED", "FAILED"],
      },
    },
    data: { status: "FAILED" },
  });

  return NextResponse.json({ updated: result.count });
}
