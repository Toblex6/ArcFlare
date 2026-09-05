// src/app/api/agent/validation/inbox/route.ts
// Validator Inbox — durable discovery for pending validation requests.
//
// Read-only. Builds the inbox from data that already exists: job-linked
// Erc8183JobValidation rows (created at hire time, hash-stamped at request
// time) joined to their canonical Erc8183Job, plus a best-effort on-chain
// mirror (getValidationStatus, authoritative) per requestHash. No parallel
// validation-request model, no mutations, no second response API.
//
// Validator scoping is mandatory and server-side: the caller NEVER supplies
// a validator address. The inbox derives the caller's controlled-address set
// via getCallerControlledAddresses (the same gate as GET /api/jobs/mine)
// and returns ONLY rows whose validatorSCA is in that set (DB WHERE clause
// + in-memory re-filter via filterInboxForValidator for case drift). An
// empty control set is a 401, never an unscoped dump.
//
// The inbox complements — never replaces — notifyValidator: the
// notification is the push signal, this is the durable pull surface for when
// it is missed. Responding still goes through the hardened
// POST /api/agent/validation (resolveResponseValidator +
// verifyCallerControlsAddress); this route never creates transactions.
//
// Plain non-job ERC-8004 agent validations have no persisted record (see
// src/lib/notifyValidator.ts receiver-gap note) and are NOT listed here —
// documented limitation, surfaced to the UI via `limitations`.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { getCallerControlledAddresses } from '@/lib/wallet/verifyCallerControlsAddress';
import { filterInboxForValidator } from '@/lib/validation/validatorInbox';
import { inboxOnChainReader } from '@/lib/validation/inboxOnChainReader';

async function inboxHandler(request: NextRequest) {
  try {
    // The caller's full controlled-address set — the single ownership gate.
    // No client-provided validator address is accepted, full stop.
    const controlled = await getCallerControlledAddresses(request);
    if (controlled.size === 0) {
      return NextResponse.json(
        { success: false, error: 'Authentication required — connect a wallet that controls a validator address.' },
        { status: 401 }
      );
    }
    const controlledArr = Array.from(controlled);

    const rows: any[] = await (prisma as any).erc8183JobValidation.findMany({
      where: { validatorSCA: { in: controlledArr, mode: 'insensitive' } },
      include: {
        job: {
          select: {
            jobId: true,
            description: true,
            clientSCA: true,
            providerSCA: true,
            status: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    // Defense-in-depth: re-apply scoping in memory (case drift on legacy
    // rows must never leak another validator's queue).
    const scoped = filterInboxForValidator(
      rows.map((r: any) => ({
        requestHash: r.requestHash ?? null,
        validatorSCA: r.validatorSCA ?? null,
        status: r.status ?? null,
        tag: r.tag ?? null,
        required: r.required ?? null,
        createdAt: r.createdAt ?? null,
        updatedAt: r.updatedAt ?? null,
        requestTxHash: r.requestTxHash ?? null,
        responseTxHash: r.responseTxHash ?? null,
        job: r.job
          ? {
              jobId: typeof r.job.jobId === 'bigint' ? r.job.jobId.toString() : r.job.jobId ?? null,
              description: r.job.description ?? null,
              clientSCA: r.job.clientSCA ?? null,
              providerSCA: r.job.providerSCA ?? null,
              status: r.job.status ?? null,
            }
          : null,
      })),
      controlled
    );

    // Per-row best-effort on-chain mirror. One unreadable hash must never
    // hide the rest: each read has its own try/catch and degrades to
    // onChainUnavailable (displayed fail-closed, never actionable).
    const items = await Promise.all(
      scoped.map(async (item) => {
        const hash = typeof item.requestHash === 'string' ? item.requestHash.trim() : '';
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return item;
        try {
          const onChain = await inboxOnChainReader(hash);
          return {
            ...item,
            onChain: {
              pending: onChain.pending,
              passed: onChain.passed,
              response: onChain.response,
              tag: onChain.tag,
            },
          };
        } catch {
          return { ...item, onChainUnavailable: true };
        }
      })
    );

    return NextResponse.json({
      success: true,
      count: items.length,
      items,
      limitations: [
        'Job-linked validation requests only. Plain non-job ERC-8004 agent validations have no persisted record and are discoverable via their request notification / manual requestHash entry.',
      ],
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Same session-capable wrapper as POST/GET /api/agent/validation: a
// logged-in merchant (or consumer) passes the outer gate;
// getCallerControlledAddresses inside still decides WHAT is visible.
export const GET = withApiKeyOrAnySession(inboxHandler);

export const dynamic = 'force-dynamic';
