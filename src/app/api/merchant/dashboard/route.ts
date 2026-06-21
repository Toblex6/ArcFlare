import { NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';

export async function GET(req: Request) {
  // Simple auth check: expecting the API key in headers
  const apiKey = req.headers.get('x-api-key');
  if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const merchant = await (prisma as any).merchant.findUnique({
    where: { apiKey },
    include: { payments: true }, // This fetches all their payments
  });

  if (!merchant) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    businessName: merchant.businessName,
    apiKey: merchant.apiKey,
    payments: merchant.payments,
  });
}
