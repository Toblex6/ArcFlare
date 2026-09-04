// src/app/api/jobs/mine/route.ts
// Role-aware "my jobs" retrieval for BOTH entry paths.
//
// A directly-hired provider does not need the client to manually send a hidden
// database id — they can discover their canonical Erc8183Job(s) through this
// endpoint, which is strictly scoped by the caller's own controlled-address
// set (getCallerControlledAddresses). A provider only ever sees jobs where
// their identity is the providerSCA; a client only jobs where they are the
// clientSCA; an unrelated merchant sees neither.
//
// Read-only. No mutations. Uses the same canonical Erc8183Job record that the
// accept/fund/submit/complete lifecycle operates against — no second database.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCallerControlledAddresses } from '@/lib/wallet/verifyCallerControlsAddress';

const ROLES = ['provider', 'client', 'all'] as const;
type Role = (typeof ROLES)[number];

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawRole = searchParams.get('role') || 'all';
    const role: Role | null = (ROLES as readonly string[]).includes(rawRole) ? (rawRole as Role) : null;
    if (role === null) {
      return NextResponse.json(
        { success: false, error: `role must be one of: ${ROLES.join(', ')}` },
        { status: 400 }
      );
    }

    // The caller's full controlled-address set — the single ownership gate.
    const controlled = await getCallerControlledAddresses(req);
    if (controlled.size === 0) {
      return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }
    const controlledArr = Array.from(controlled);

    const where: any = {};
    if (role === 'provider') {
      where.providerSCA = { in: controlledArr, mode: 'insensitive' };
    } else if (role === 'client') {
      where.clientSCA = { in: controlledArr, mode: 'insensitive' };
    } else {
      where.OR = [
        { providerSCA: { in: controlledArr, mode: 'insensitive' } },
        { clientSCA: { in: controlledArr, mode: 'insensitive' } },
      ];
    }

    const jobs = await prisma.erc8183Job.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const serialized = jobs.map((j: any) => {
      const provider = String(j.providerSCA || '').toLowerCase();
      const client = String(j.clientSCA || '').toLowerCase();
      return {
        id: j.id,
        jobId: j.jobId.toString(),
        clientSCA: j.clientSCA,
        providerSCA: j.providerSCA,
        evaluatorSCA: j.evaluatorSCA,
        description: j.description,
        budget: j.budget.toString(),
        status: j.status,
        deliverableHash: j.deliverableHash ?? null,
        reasonHash: j.reasonHash ?? null,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        expiredAt: j.expiredAt,
        isProvider: controlled.has(provider),
        isClient: controlled.has(client),
      };
    });

    return NextResponse.json({ success: true, role, count: serialized.length, jobs: serialized });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';