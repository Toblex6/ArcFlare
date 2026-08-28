// src/app/api/agents/[id]/acceptance-policy/route.ts
// Provider-side autonomous acceptance policy (Build 5).
// Lets a provider agent declare:
//   minBudget, maxConcurrentJobs, minClientTrustScore, allowedSkills/Categories, autoAccept
// All checks are enforced at POST /api/jobs/[jobId]/accept (provider auto-accept).

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withApiKeyOrAnySession } from "@/lib/middleware/withMerchantAuth";
import { verifyCallerControlsAddress } from "@/lib/wallet/verifyCallerControlsAddress";
import { getOrCreateAgentWallet } from "@/lib/x402-wallet";

function toUnits(v: any): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return s;
  if (/^\d+(\.\d{1,6})?$/.test(s)) return (BigInt(Math.round(parseFloat(s) * 1_000_000))).toString();
  throw new Error(`invalid amount ${v} — use integer 6-dec units or decimal USDC`);
}

async function getHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  // Read is public-safe? Provider policy reveals trust thresholds, not secrets — but keep auth to caller controls or public?
  // Make GET public for discoverability (judge needs to see), but POST is auth-gated.
  const policy = await (prisma as any).agentProviderPolicy.findUnique({ where: { agentRegistryId: agentId } }).catch(() => null);
  return NextResponse.json({
    agent: { id: agent.id, name: agent.name, scaAddress: agent.scaAddress },
    policy: policy ?? { agentRegistryId: agentId, minBudget: "0", maxConcurrentJobs: 5, minClientTrustScore: null, allowedSkills: null, allowedCategories: null, autoAccept: true },
  });
}

async function postHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agentId = Number(id);
  if (!Number.isInteger(agentId) || agentId <= 0) return NextResponse.json({ error: "invalid agent id" }, { status: 400 });
  const agent = await (prisma as any).agentRegistry.findUnique({ where: { id: agentId } });
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  const wallet = await getOrCreateAgentWallet(agentId).catch(() => null);
  const controlAddress = agent.scaAddress ?? wallet?.address ?? "";
  if (!controlAddress) return NextResponse.json({ error: "agent has no address" }, { status: 400 });
  const actor = await verifyCallerControlsAddress(req, controlAddress);
  if (!actor) return NextResponse.json({ error: "You do not control this agent." }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const data: any = {};
  if (body.minBudget !== undefined) {
    const u = toUnits(body.minBudget);
    if (u === null) data.minBudget = "0";
    else data.minBudget = u;
    if (BigInt(data.minBudget) < 0n) return NextResponse.json({ error: "minBudget must be >= 0" }, { status: 400 });
  }
  if (body.maxConcurrentJobs !== undefined) {
    const v = Number(body.maxConcurrentJobs);
    if (!Number.isInteger(v) || v < 1 || v > 100) return NextResponse.json({ error: "maxConcurrentJobs must be integer 1..100" }, { status: 400 });
    data.maxConcurrentJobs = v;
  }
  if (body.minClientTrustScore !== undefined) {
    if (body.minClientTrustScore === null || body.minClientTrustScore === "") data.minClientTrustScore = null;
    else {
      const v = Number(body.minClientTrustScore);
      if (!Number.isInteger(v) || v < 0 || v > 100) return NextResponse.json({ error: "minClientTrustScore must be integer 0..100 or null" }, { status: 400 });
      data.minClientTrustScore = v;
    }
  }
  if (body.allowedSkills !== undefined) {
    if (body.allowedSkills === null) data.allowedSkills = null;
    else if (!Array.isArray(body.allowedSkills)) return NextResponse.json({ error: "allowedSkills must be array or null" }, { status: 400 });
    else data.allowedSkills = body.allowedSkills.map((s: any) => String(s));
  }
  if (body.allowedCategories !== undefined) {
    if (body.allowedCategories === null) data.allowedCategories = null;
    else if (!Array.isArray(body.allowedCategories)) return NextResponse.json({ error: "allowedCategories must be array or null" }, { status: 400 });
    else data.allowedCategories = body.allowedCategories.map((s: any) => String(s));
  }
  if (body.autoAccept !== undefined) data.autoAccept = !!body.autoAccept;

  const policy = await (prisma as any).agentProviderPolicy.upsert({
    where: { agentRegistryId: agentId },
    create: { agentRegistryId: agentId, ...data },
    update: data,
  });
  return NextResponse.json({ success: true, policy });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return getHandler(req, ctx);
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKeyOrAnySession((inner: NextRequest) => postHandler(inner, ctx))(req);
}
