// src/lib/consumer/discoveryHelpers.ts
// Small, pure helpers for the consumer discovery track.
// One malformed agent must never break the whole page — isolate via try/catch.
// Trust/reputation are display-only: never recalculated, never client-controlled.

export interface DiscoveryFilters {
  search?: string;
  skill?: string;
  minTrust?: number | null;
  sortBy?: string;
  sortOrder?: string;
  limit?: number;
  offset?: number;
  category?: string;
}

export function buildDiscoveryParams(filters: DiscoveryFilters): string {
  const p = new URLSearchParams();
  if (filters.search?.trim()) p.set("search", filters.search.trim());
  if (filters.skill?.trim()) p.set("skill", filters.skill.trim());
  if (filters.category?.trim()) p.set("category", filters.category.trim());
  if (filters.minTrust !== null && filters.minTrust !== undefined && !Number.isNaN(filters.minTrust)) {
    p.set("minTrust", String(filters.minTrust));
  }
  if (filters.sortBy) p.set("sortBy", filters.sortBy);
  if (filters.sortOrder) p.set("sortOrder", filters.sortOrder);
  if (filters.limit !== undefined) p.set("limit", String(filters.limit));
  if (filters.offset !== undefined) p.set("offset", String(filters.offset));
  return p.toString();
}

// Serviceability is derived from backend-supplied status only.
// ACTIVE_AGENT_PROVISIONED => serviceable; anything else => not serviceable.
// Do NOT invent serviceability from frontend guesses.
export function isServiceable(status: unknown): boolean {
  return status === "ACTIVE_AGENT_PROVISIONED";
}

export function serviceabilityLabel(status: unknown): { label: string; tone: "ok" | "warn" | "unknown" } {
  if (status === "ACTIVE_AGENT_PROVISIONED") return { label: "Available now", tone: "ok" };
  if (typeof status === "string" && status.length > 0) return { label: String(status), tone: "warn" };
  return { label: "Unavailable", tone: "unknown" };
}

// Human-friendly identifier labels — never merge these three into one ambiguous field.
export function getIdentifierLabels(agent: any): { registryId: string | null; tokenId: string | null; scaAddress: string | null } {
  const registryId = agent?.id !== undefined && agent?.id !== null ? String(agent.id) : (agent?.agentId !== undefined ? String(agent.agentId) : null);
  // Discover lists use `id` + `tokenId`; card uses `agentId`/`identity.tokenId`.
  const tokenId = agent?.tokenId ?? agent?.erc8004TokenId ?? agent?.identity?.tokenId ?? null;
  const scaAddress = agent?.scaAddress ?? agent?.wallet?.scaAddress ?? agent?.identity?.scaAddress ?? null;
  return {
    registryId: registryId ? String(registryId) : null,
    tokenId: tokenId ? String(tokenId) : null,
    scaAddress: scaAddress ? String(scaAddress) : null,
  };
}

export function formatScaShort(sca: string | null): string {
  if (!sca || typeof sca !== "string") return "—";
  if (sca.length <= 12) return sca;
  return `${sca.slice(0, 6)}…${sca.slice(-4)}`;
}

// Trust is display-only. Do not recalculate; do not show if backend didn't supply it.
export function formatTrust(trust: any): string | null {
  if (!trust || typeof trust !== "object") return null;
  if (typeof trust.score !== "number") return null;
  const conf = typeof trust.confidence === "number" ? ` · confidence ${trust.confidence}` : "";
  return `Trust ${trust.score}/100${conf}`;
}

export function formatPricing(pricing: any): string | null {
  if (!pricing || typeof pricing !== "object") return null;
  const raw = pricing.pricePerRequest ?? pricing.pricePerJob ?? pricing.price ?? null;
  if (!raw) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

export function normalizeAgentRecord(raw: any): any | null {
  try {
    if (!raw || typeof raw !== "object") return null;
    // Required: either id or name present; otherwise treat as malformed (but don't throw).
    const hasId = raw.id !== undefined || raw.agentId !== undefined;
    const hasName = typeof raw.name === "string" && raw.name.trim().length > 0;
    if (!hasId && !hasName) return null;
    // Accept raw as-is if plausible; extra validation not needed — just ensure it won't crash rendering.
    return raw;
  } catch {
    return null;
  }
}

// Filter out malformed records; one bad agent never hides the rest.
export function isolateValidAgents(list: any[]): any[] {
  if (!Array.isArray(list)) return [];
  const out: any[] = [];
  for (const item of list) {
    const n = normalizeAgentRecord(item);
    if (n) out.push(n);
  }
  return out;
}

// Serviceability-aware action label — never show "Hire" when it would fail validation.
export function getAppropriateAction(agent: any, walletConnected: boolean): { label: string; disabled: boolean; hint: string } {
  if (!isServiceable(agent?.status)) {
    return { label: "Not serviceable", disabled: true, hint: "This agent is not currently serviceable — hiring would fail validation." };
  }
  if (!walletConnected) {
    return { label: "Connect wallet to hire", disabled: true, hint: "Connect a wallet before hiring." };
  }
  return { label: "Hire", disabled: false, hint: "Start a job with this agent via the existing hiring route." };
}
