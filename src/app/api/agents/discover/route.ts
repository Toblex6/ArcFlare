// src/app/api/agents/discover/route.ts
//
// Agent Discovery — public search/discovery endpoint for agent-native marketplace.
// Supports filtering by capability, price, reputation, status.
// Reuses existing AgentRegistry + reputation data; no new models.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Query parameters
    const skill = searchParams.get("skill");                    // capability/skill filter
    const minReputation = searchParams.get("minReputation");    // minimum reputation score
    const maxPricePerRequest = searchParams.get("maxPricePerRequest"); // max price per request (USDC)
    const minPricePerRequest = searchParams.get("minPricePerRequest"); // min price per request
    const status = searchParams.get("status");                  // agent status filter
    const category = searchParams.get("category");              // category/skill category
    const search = searchParams.get("search");                  // free-text search (name/description)
    const sortBy = searchParams.get("sortBy") || "reputation";  // sort: reputation | price | createdAt | trust
    const sortOrder = searchParams.get("sortOrder") || "desc";  // asc | desc
    const minTrust = searchParams.get("minTrust") ? Number(searchParams.get("minTrust")) : null;
    const limit = Math.min(Number(searchParams.get("limit") || "20"), 100);
    const offset = Number(searchParams.get("offset") || "0");
    const mine = searchParams.get("mine") === "1";              // scope to the caller's own agents

    // Build where clause — keep DB filters to indexed/scalar fields only;
    // JSON fields (skills, pricing) are filtered in-memory below to avoid
    // Prisma Json path dialect differences across providers.
    const where: any = {
      status: "ACTIVE_AGENT_PROVISIONED", // only discoverable agents
    };

    // Merchant-scoped listing (?mine=1): only agents the authenticated
    // merchant owns. No other tenant's agents are ever returned — the scope
    // is derived from the session, never from a caller-supplied id.
    if (mine) {
      const merchant = await resolveMerchant(request).catch(() => null);
      if (!merchant?.id) {
        return NextResponse.json({ error: "authentication required for mine=1" }, { status: 401 });
      }
      where.merchantId = merchant.id;
    }

    // Reputation filter (scalar, DB-side)
    if (minReputation) {
      const minRep = Number(minReputation);
      if (!Number.isNaN(minRep)) {
        where.reputation = { gte: minRep };
      }
    }

    // Status override (if caller wants non-ACTIVE discoverability, e.g. admin)
    if (status) {
      where.status = status;
    }

    // Free-text search (name/description) — DB-side
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    // Sorting — trust requires in-memory post-process (computed via trustScore); DB order is fallback
    let orderBy: any = { reputation: "desc" };
    if (sortBy === "price") {
      orderBy = { reputation: sortOrder };
    } else if (sortBy === "createdAt") {
      orderBy = { createdAt: sortOrder };
    } else if (sortBy === "trust") {
      orderBy = { reputation: sortOrder }; // placeholder — real sort after trust enrichment
    } else {
      orderBy = { reputation: sortOrder };
    }

    // Query agents — fetch a window larger than limit to allow in-memory JSON filtering
    // We fetch limit + offset + buffer, then filter, then paginate in-memory for JSON fields.
    // For pure scalar filters (reputation/status/search) the DB already pruned, so this is cheap.
    const fetchTake = limit + offset + 50;
    const agents = await (prisma as any).agentRegistry.findMany({
      where,
      orderBy,
      take: fetchTake,
      select: {
        id: true,
        name: true,
        tokenId: true,
        scaAddress: true,
        circleWalletId: true,
        ownerNode: true,
        metadataURI: true,
        status: true,
        description: true,
        skills: true,
        pricing: true,
        reputation: true,
        lastActiveAt: true,
        createdAt: true,
        merchantId: true,
      },
    });

    // In-memory JSON filtering for skills/category/price (avoids Prisma Json path dialect issues)
    let filtered = agents;
    if (skill) {
      const needle = skill.toLowerCase();
      filtered = filtered.filter((a: any) => {
        const skills = a.skills;
        if (!skills) return false;
        const arr = Array.isArray(skills) ? skills : [skills];
        return arr.some((s: any) => {
          const v = typeof s === "string" ? s : s?.name ?? s?.description ?? JSON.stringify(s);
          return String(v).toLowerCase().includes(needle);
        });
      });
    }
    if (category) {
      const needle = category.toLowerCase();
      filtered = filtered.filter((a: any) => {
        const skills = a.skills;
        if (!skills) return false;
        const arr = Array.isArray(skills) ? skills : [skills];
        return arr.some((s: any) => String(typeof s === "string" ? s : s?.name ?? "").toLowerCase().includes(needle));
      });
    }
    if (maxPricePerRequest || minPricePerRequest) {
      const maxP = maxPricePerRequest ? Number(maxPricePerRequest) : Infinity;
      const minP = minPricePerRequest ? Number(minPricePerRequest) : -Infinity;
      filtered = filtered.filter((a: any) => {
        const raw = a.pricing?.pricePerRequest ?? a.pricing?.pricePerJob ?? null;
        if (!raw) return false;
        const p = Number(String(raw).replace("$", ""));
        if (Number.isNaN(p)) return false;
        return p >= minP && p <= maxP;
      });
    }

    // Enrich filtered with trust scores (computed lazily — only for the filtered set, bounded by fetchTake)
    // For sortBy=trust we need trust before paging; for minTrust filter we need it before paging too.
    let trustMap = new Map<number, any>();
    const needsTrust = sortBy === "trust" || minTrust !== null || true; // always enrich (cheap for small window, required for response)
    if (needsTrust && filtered.length > 0) {
      try {
        const { computeTrustScore } = await import("@/lib/trust/trustScore");
        const results = await Promise.all(filtered.map(async (a: any) => {
          try { const t = await computeTrustScore(a.id); return { id: a.id, t }; } catch { return { id: a.id, t: { score: 50, confidence: 10, methodologyVersion: "1.0" } as any }; }
        }));
        for (const r of results) trustMap.set(r.id, r.t);
      } catch {}
    }

    // Apply minTrust filter (post trust compute, before sort/page)
    if (minTrust !== null && !Number.isNaN(minTrust)) {
      filtered = filtered.filter((a: any) => {
        const t = trustMap.get(a.id);
        return t ? t.score >= minTrust : false;
      });
    }

    // Post-process sorting
    if (sortBy === "price") {
      filtered.sort((a: any, b: any) => {
        const priceA = a.pricing?.pricePerRequest
          ? Number(String(a.pricing.pricePerRequest).replace("$", ""))
          : a.pricing?.pricePerJob ? Number(String(a.pricing.pricePerJob).replace("$", "")) : Infinity;
        const priceB = b.pricing?.pricePerRequest
          ? Number(String(b.pricing.pricePerRequest).replace("$", ""))
          : b.pricing?.pricePerJob ? Number(String(b.pricing.pricePerJob).replace("$", "")) : Infinity;
        return sortOrder === "asc" ? priceA - priceB : priceB - priceA;
      });
    } else if (sortBy === "createdAt") {
      filtered.sort((a: any, b: any) => {
        const da = new Date(a.createdAt).getTime();
        const db = new Date(b.createdAt).getTime();
        return sortOrder === "asc" ? da - db : db - da;
      });
    } else if (sortBy === "trust") {
      filtered.sort((a: any, b: any) => {
        const ta = trustMap.get(a.id)?.score ?? 50;
        const tb = trustMap.get(b.id)?.score ?? 50;
        return sortOrder === "asc" ? ta - tb : tb - ta;
      });
    }
    // reputation already sorted DB-side, but re-sort in-memory if we filtered
    else if (skill || category || maxPricePerRequest || minPricePerRequest || minTrust !== null) {
      filtered.sort((a: any, b: any) => (sortOrder === "asc" ? a.reputation - b.reputation : b.reputation - a.reputation));
    }

    const paged = filtered.slice(offset, offset + limit);
    const hasMore = filtered.length > offset + limit;
    let results = paged;

    // Enrich with AgentCard URLs and trust info (public-safe)
    const enriched = results.map((agent: any) => {
      const t = trustMap.get(agent.id) || null;
      return {
        id: agent.id,
        tokenId: agent.tokenId,
        name: agent.name,
        description: agent.description,
        skills: agent.skills ?? [],
        pricing: agent.pricing ?? {},
        reputation: agent.reputation ?? 50,
        trust: t ? { score: t.score, confidence: t.confidence, methodologyVersion: t.methodologyVersion } : null,
        trackRecord: t ? { completedJobs: t.signals.completedJobs, validatedJobs: t.signals.validatedJobs, validationPassRate: t.signals.validationPassRate, validatedVolume: t.signals.validatedVolume } : null,
        status: agent.status,
        lastActiveAt: agent.lastActiveAt,
        createdAt: agent.createdAt,
        cardUrl: `/api/agents/${agent.id}/card`,
        hireUrl: `/api/agents/${agent.id}/hire`,
        trackRecordUrl: `/api/agents/${agent.id}/track-record`,
      };
    });

    return NextResponse.json({
      success: true,
      agents: enriched,
      pagination: {
        limit,
        offset,
        hasMore,
      },
      filters: {
        skill,
        minReputation,
        minTrust,
        maxPricePerRequest,
        minPricePerRequest,
        status,
        category,
        search,
        sortBy,
        sortOrder,
      },
    });
  } catch (error: any) {
    console.error("Agent discover error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}