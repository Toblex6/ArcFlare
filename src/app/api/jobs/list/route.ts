import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const clientAddress = searchParams.get('clientAddress');
    const providerAddress = searchParams.get('providerAddress');

    const where: any = {};
    if (status) where.status = status;
    if (clientAddress) where.clientSCA = clientAddress;
    if (providerAddress) where.providerSCA = providerAddress;

    const jobs = await prisma.erc8183Job.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      success: true,
      jobs: jobs.map((j) => ({
        id: j.id,
        jobId: j.jobId.toString(),
        clientSCA: j.clientSCA,
        providerSCA: j.providerSCA,
        description: j.description,
        budget: j.budget.toString(),
        status: j.status,
        createdAt: j.createdAt,
      })),
      count: jobs.length,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
