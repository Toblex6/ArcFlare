// src/app/api/merchant/wallet/sign-requests/route.ts
// Lists this merchant's pending WalletSignatureRequest rows — the frontend
// polls this to show "you have N actions waiting for your signature."

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";

export async function GET(req: NextRequest) {
  const merchant = await resolveMerchant(req);
  if (!merchant) {
    return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
  }

  const requests = await (prisma as any).walletSignatureRequest.findMany({
    where: { merchantId: merchant.id, status: "PENDING", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ success: true, count: requests.length, requests });
}
