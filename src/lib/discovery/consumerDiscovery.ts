// src/lib/discovery/consumerDiscovery.ts
//
// Consumer-discovery presentation helpers for the agent marketplace.
//
// These are PURE view-model builders. They never hit the network, never
// touch Prisma/next/server, and never invent data — every number shown to a
// buyer (trust, reputation, volume, price, identifiers) is copied verbatim
// from whatever the existing discovery/card/track-record APIs returned, or
// omitted. They exist so the Agents discovery UI and its tests share one
// source of truth for:
//   - discover query params (only params the /api/agents/discover route
//     actually accepts, and only when set)
//   - per-agent failure isolation (one malformed row must not take down the
//     whole grid)
//   - human-friendly, non-merged identifier labels (registry id, ERC-8004
//     token id, SCA are three different identities)
//   - serviceability-aware action derivation (never offer "Hire" when the
//     backend status says the agent cannot service a job)

export const SERVICEABLE_STATUS = "ACTIVE_AGENT_PROVISIONED";

export const MAX_SKILL_NAME_LEN = 80;

// ── Discovery query building ─────────────────────────────────────────────
// Builds the query string for GET /api/agents/discover. Only parameters the
// route supports are emitted, and only when the caller actually set them —
// empty/absent filters are left off so the backend defaults apply.

export interface DiscoverQueryParams {
  search?: string | null;
  sortBy?: string | null;
  sortOrder?: string | null;
  minTrust?: number | string | null;
  status?: string | null;
  limit?: number | string | null;
  offset?: number | string | null;
}

export const DEFAULT_SORT_BY = "trust";
export const DEFAULT_SORT_ORDER = "desc";

export function buildDiscoverQuery(p: DiscoverQueryParams): string {
  const params = new URLSearchParams();

  const sortBy = p.sortBy || DEFAULT_SORT_BY;
  const sortOrder = (p.sortOrder || DEFAULT_SORT_ORDER).toLowerCase() === "asc" ? "asc" : "desc";
  params.set("sortBy", sortBy);
  params.set("sortOrder", sortOrder);

  const search = typeof p.search === "string" ? p.search.trim() : "";
  if (search) params.set("search", search);

  if (typeof p.status === "string" && p.status.trim()) params.set("status", p.status.trim());

  if (p.minTrust !== null && p.minTrust !== undefined && p.minTrust !== "") {
    const n = Number(p.minTrust);
    if (Number.isFinite(n)) {
      const clamped = Math.min(100, Math.max(0, Math.round(n)));
      params.set("minTrust", String(clamped));
    }
  }

  const limit = Number(p.limit ?? 20);
  if (Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(Math.min(100, Math.round(limit))));
  } else {
    params.set("limit", "20");
  }

  const offset = Number(p.offset ?? 0);
  if (Number.isFinite(offset) && offset > 0) {
    params.set("offset", String(Math.round(offset)));
  }

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ── Serviceability ───────────────────────────────────────────────────────
// An agent can service a hire only when the backend reports it as fully
// provisioned. This is the exact gate every hire route enforces server-side
// (agents/[id]/hire, jobs create, treasury/hire); the UI mirrors it from the
// status the backend already returned — never a client-side invention.

export function agentIsServiceable(status: unknown): boolean {
  return typeof status === "string" && status.toUpperCase() === SERVICEABLE_STATUS;
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE_AGENT_PROVISIONED: "Active",
  PENDING_IDENTITY_CONFIRMATION: "Identity pending",
};

export function humanStatusLabel(status: unknown): string {
  if (typeof status !== "string" || !status) return "Unknown";
  return STATUS_LABELS[status.toUpperCase()] ?? status;
}

// ── Trust & reputation ───────────────────────────────────────────────────
// A trust score is shown ONLY when the backend supplied one. If the payload
// has no numeric score, `present` is false and the UI renders nothing (or an
// explicit "no trust data yet" line) — it never synthesizes a default score.

export interface TrustView {
  present: boolean;
  score: number | null;
  confidence: number | null;
  methodologyVersion: string | null;
}

export function trustView(trust: unknown): TrustView {
  const none: TrustView = { present: false, score: null, confidence: null, methodologyVersion: null };
  if (!trust || typeof trust !== "object") return none;
  const t = trust as Record<string, unknown>;
  const score = typeof t.score === "number" ? t.score : typeof t.score === "string" ? Number(t.score) : NaN;
  if (!Number.isFinite(score) || score < 0 || score > 100) return none;
  const confidence =
    typeof t.confidence === "number" ? t.confidence : typeof t.confidence === "string" ? Number(t.confidence) : NaN;
  return {
    present: true,
    score: Math.round(score),
    confidence: Number.isFinite(confidence) ? Math.round(confidence) : null,
    methodologyVersion: typeof t.methodologyVersion === "string" ? t.methodologyVersion : null,
  };
}

export function safeNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface ReputationView {
  present: boolean;
  score: number | null;
}

// Legacy `reputation` integer (0..100) stored on AgentRegistry — shown only
// when present; the empty case means "no reputation data supplied".
export function reputationView(reputation: unknown): ReputationView {
  const score = safeNumber(reputation);
  if (score === null || score < 0 || score > 100) return { present: false, score: null };
  return { present: true, score: Math.round(score) };
}

// ── Economics / pricing ──────────────────────────────────────────────────
// Pricing shape from the AgentCard / AgentRegistry JSON: an object that may
// carry pricePerRequest and/or pricePerJob (often strings like "$5.00"). The
// view reports exactly which of the two the backend provided.

export interface PricingView {
  present: boolean;
  perRequest: number | null;
  perJob: number | null;
}

export function parsePricing(pricing: unknown): PricingView {
  const none: PricingView = { present: false, perRequest: null, perJob: null };
  if (!pricing || typeof pricing !== "object") return none;
  const raw = pricing as Record<string, unknown>;
  const parsePrice = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
    if (typeof v === "string") {
      const cleaned = v.replace(/[$,\s]/g, "");
      const n = Number(cleaned);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    return null;
  };
  const perRequest = parsePrice(raw.pricePerRequest);
  const perJob = parsePrice(raw.pricePerJob);
  if (perRequest === null && perJob === null) return none;
  return { present: true, perRequest, perJob };
}

export function formatUsdcPrice(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

// Validated volume arrives as a micro-USDC (6-decimals) string/BigInt-safe
// string from the backend; convert for display only.
export function microUnitsToUsdc(v: unknown): number | null {
  if (typeof v === "bigint") return Number(v) / 1e6;
  const n = safeNumber(v);
  if (n === null) return null;
  try {
    const asBig = BigInt(Math.trunc(n));
    return Number(asBig) / 1e6;
  } catch {
    return n / 1e6;
  }
}

// ── Capabilities / skills ────────────────────────────────────────────────
export interface SkillChip {
  name: string;
  description: string;
}

export function normalizeCapabilities(skills: unknown): SkillChip[] {
  if (!Array.isArray(skills)) return [];
  const out: SkillChip[] = [];
  for (const s of skills) {
    if (typeof s === "string") {
      const name = s.trim();
      if (name) out.push({ name: name.slice(0, MAX_SKILL_NAME_LEN), description: "" });
    } else if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      const desc = typeof o.description === "string" ? o.description.trim() : "";
      if (name) out.push({ name: name.slice(0, MAX_SKILL_NAME_LEN), description: desc.slice(0, 300) });
    }
    if (out.length >= 30) break;
  }
  return out;
}

// ── Human-friendly identifiers ───────────────────────────────────────────
// Registry ID, ERC-8004 token ID and SCA are three distinct agent references
// (see AGENTS.md — never interchangeable). Each is rendered as its own
// labeled row so the UI can never merge them into one ambiguous field.

export type IdentifierKind = "registry" | "token" | "sca";

export interface IdentifierRow {
  key: string;
  label: string;
  value: string;
  kind: IdentifierKind;
}

export interface AgentIdInput {
  id?: unknown;
  tokenId?: unknown;
  scaAddress?: unknown;
}

export function agentIdentifierRows(raw: AgentIdInput): IdentifierRow[] {
  const rows: IdentifierRow[] = [];

  const id = safeNumber(raw.id);
  if (id !== null && Number.isSafeInteger(id) && id > 0) {
    rows.push({ key: "registry", label: "Registry ID", value: `#${id}`, kind: "registry" });
  }

  const tokenId = raw.tokenId !== null && raw.tokenId !== undefined && raw.tokenId !== "" ? String(raw.tokenId).trim() : "";
  if (tokenId) {
    rows.push({ key: "token", label: "ERC-8004 token ID", value: `#${tokenId}`, kind: "token" });
  }

  const sca =
    typeof raw.scaAddress === "string" && raw.scaAddress.startsWith("0x") ? raw.scaAddress : "";
  if (sca) {
    rows.push({ key: "sca", label: "Agent wallet (SCA)", value: sca, kind: "sca" });
  }

  return rows;
}

export function shortAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

// ── Serviceability-aware action ──────────────────────────────────────────
// A buyer sees an actionable "Hire" ONLY when (a) the agent is serviceable
// per the backend status, and (b) the caller actually has a Circle-managed
// wallet to hire from (the real hire route resolves + verifies that wallet
// server-side). Every other state is an honest, disabled alternative.

export type HireSessionKind = "unknown" | "none" | "no-circle" | "ready";

export interface AgentAction {
  kind: "hire" | "signin" | "wallet-required" | "unavailable" | "checking";
  label: string;
  disabled: boolean;
  reason: string;
  serviceable: boolean;
  canHire: boolean;
}

export function deriveAgentAction(status: unknown, session: HireSessionKind): AgentAction {
  const serviceable = agentIsServiceable(status);
  if (!serviceable) {
    return {
      kind: "unavailable",
      label: "Not available for hire",
      disabled: true,
      reason: `This agent is not ready to take jobs right now (${humanStatusLabel(status)}).`,
      serviceable: false,
      canHire: false,
    };
  }
  switch (session) {
    case "ready":
      return {
        kind: "hire",
        label: "Hire for a job",
        disabled: false,
        reason: "",
        serviceable: true,
        canHire: true,
      };
    case "no-circle":
      return {
        kind: "wallet-required",
        label: "Hire for a job",
        disabled: true,
        reason: "Connect a Circle-managed wallet to your business account to hire — jobs are created and funded from your wallet.",
        serviceable: true,
        canHire: false,
      };
    case "unknown":
      return {
        kind: "checking",
        label: "Checking wallet…",
        disabled: true,
        reason: "",
        serviceable: true,
        canHire: false,
      };
    case "none":
    default:
      return {
        kind: "signin",
        label: "Sign in to hire",
        disabled: true,
        reason: "Sign in with your business account to start a job — hiring runs from your verified wallet.",
        serviceable: true,
        canHire: false,
      };
  }
}

// ── Discover-list normalization (per-row isolation) ──────────────────────
export interface DiscoverAgentView {
  ok: boolean;
  index: number;
  id: number | null;
  tokenId: string | null;
  name: string;
  description: string;
  status: string | null;
  serviceable: boolean;
  capabilities: SkillChip[];
  pricing: PricingView;
  reputation: ReputationView;
  trust: TrustView;
  trackRecord: {
    completedJobs: number | null;
    validatedJobs: number | null;
    validationPassRate: number | null;
    validatedVolumeUSDC: number | null;
  } | null;
  cardUrl: string | null;
  hireUrl: string | null;
  trackRecordUrl: string | null;
}

function asString(v: unknown, max = 600): string {
  if (typeof v === "string") return v.slice(0, max);
  if (typeof v === "number") return String(v);
  return "";
}

export function normalizeDiscoverAgent(raw: unknown, index: number): DiscoverAgentView | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;

  const id = safeNumber(row.id);
  const tokenId = row.tokenId !== null && row.tokenId !== undefined ? String(row.tokenId).trim() : "";
  const sca = typeof row.scaAddress === "string" ? row.scaAddress : "";

  // A row we cannot reference at all (no registry id, no token id, no SCA) is
  // malformed — dropping it must never take down the rest of the grid.
  if (id === null && !tokenId && !sca) return null;

  const name = asString(row.name, 120) || (id !== null ? `Agent ${id}` : tokenId ? `Agent #${tokenId}` : "Unnamed agent");

  const pricing = parsePricing(row.pricing);
  let track: DiscoverAgentView["trackRecord"] = null;
  const tr = row.trackRecord as Record<string, unknown> | null | undefined;
  if (tr && typeof tr === "object") {
    const volumeUsdc = microUnitsToUsdc(tr.validatedVolume) ?? microUnitsToUsdc(tr.validatedVolumeUSDC);
    track = {
      completedJobs: safeNumber(tr.completedJobs),
      validatedJobs: safeNumber(tr.validatedJobs),
      validationPassRate:
        typeof tr.validationPassRate === "number" && tr.validationPassRate !== null
          ? Math.min(1, Math.max(0, tr.validationPassRate))
          : null,
      validatedVolumeUSDC: volumeUsdc,
    };
  }

  const status = typeof row.status === "string" ? row.status : null;

  return {
    ok: true,
    index,
    id,
    tokenId: tokenId || null,
    name,
    description: asString(row.description, 400),
    status,
    serviceable: agentIsServiceable(status),
    capabilities: normalizeCapabilities(row.skills ?? row.capabilities),
    pricing,
    reputation: reputationView(row.reputation),
    trust: trustView(row.trust),
    trackRecord: track,
    cardUrl: typeof row.cardUrl === "string" && row.cardUrl ? row.cardUrl : null,
    hireUrl: typeof row.hireUrl === "string" && row.hireUrl ? row.hireUrl : null,
    trackRecordUrl: typeof row.trackRecordUrl === "string" && row.trackRecordUrl ? row.trackRecordUrl : null,
  };
}

export interface DiscoverListResult {
  ok: boolean;
  error: string | null;
  agents: DiscoverAgentView[];
  malformed: number;
  totalInPayload: number;
  hasMore: boolean;
}

export function normalizeDiscoverPayload(payload: unknown): DiscoverListResult {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Discovery response was empty.", agents: [], malformed: 0, totalInPayload: 0, hasMore: false };
  }
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.agents)) {
    const err = typeof body.error === "string" ? body.error : "Discovery is unavailable right now.";
    return { ok: false, error: err, agents: [], malformed: 0, totalInPayload: 0, hasMore: false };
  }
  const agents: DiscoverAgentView[] = [];
  let malformed = 0;
  body.agents.forEach((row: unknown, i: number) => {
    const view = normalizeDiscoverAgent(row, i);
    if (view) agents.push(view);
    else malformed += 1;
  });
  const pagination = (body.pagination ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    error: null,
    agents,
    malformed,
    totalInPayload: body.agents.length,
    hasMore: pagination.hasMore === true,
  };
}

// ── AgentCard normalization ──────────────────────────────────────────────
// The public card route enriches the AgentCard with trust/trackRecord/reputation
// summary (best-effort). The UI only renders fields actually present.

export interface CardTrackRecordView {
  present: boolean;
  completedJobs: number | null;
  validatedJobs: number | null;
  validationPassRate: number | null;
  totalJobs: number | null;
  failedJobs: number | null;
  validatedVolumeUSDC: number | null;
  reputationCount: number | null;
  uniqueValidators: number | null;
  lastActivityAt: string | null;
}

export function cardTrackRecordView(tr: unknown): CardTrackRecordView {
  if (!tr || typeof tr !== "object") {
    return {
      present: false,
      completedJobs: null,
      validatedJobs: null,
      validationPassRate: null,
      totalJobs: null,
      failedJobs: null,
      validatedVolumeUSDC: null,
      reputationCount: null,
      uniqueValidators: null,
      lastActivityAt: null,
    };
  }
  const t = tr as Record<string, unknown>;
  let vol: number | null = null;
  if (t.validatedVolumeUSDC !== undefined && t.validatedVolumeUSDC !== null) {
    vol = safeNumber(t.validatedVolumeUSDC);
  } else if (t.validatedVolume !== undefined && t.validatedVolume !== null) {
    vol = microUnitsToUsdc(t.validatedVolume);
  }
  return {
    present: true,
    completedJobs: safeNumber(t.completedJobs),
    validatedJobs: safeNumber(t.validatedJobs),
    validationPassRate:
      typeof t.validationPassRate === "number" && Number.isFinite(t.validationPassRate)
        ? Math.min(1, Math.max(0, t.validationPassRate))
        : null,
    totalJobs: safeNumber(t.totalJobs),
    failedJobs: safeNumber(t.failedJobs),
    validatedVolumeUSDC: vol,
    reputationCount: safeNumber(t.reputationCount),
    uniqueValidators: safeNumber(t.uniqueValidators),
    lastActivityAt: typeof t.lastActivityAt === "string" ? t.lastActivityAt : null,
  };
}

export interface TrustBreakdownRow {
  key: string;
  label: string;
  value: number;
}

const BREAKDOWN_LABELS: Record<string, string> = {
  jobPerformance: "Job performance",
  validationPerformance: "Validation performance",
  reputation: "Reputation",
  paymentReliability: "Payment reliability",
  economicEvidence: "Economic evidence",
};

export function trustBreakdownView(breakdown: unknown): TrustBreakdownRow[] {
  if (!breakdown || typeof breakdown !== "object") return [];
  const rows: TrustBreakdownRow[] = [];
  for (const [key, raw] of Object.entries(breakdown as Record<string, unknown>)) {
    const value = safeNumber(raw);
    if (value === null) continue;
    rows.push({ key, label: BREAKDOWN_LABELS[key] ?? key, value });
  }
  return rows;
}

export interface OnChainReputationView {
  present: boolean;
  readOk: boolean;
  score: number | null;
  count: number | null;
}

export function onChainReputationView(summary: unknown): OnChainReputationView {
  if (!summary || typeof summary !== "object") {
    return { present: false, readOk: false, score: null, count: null };
  }
  const s = summary as Record<string, unknown>;
  const score = safeNumber(s.reputationScore);
  return {
    present: true,
    readOk: s.readOk === true,
    score,
    count: safeNumber(s.reputationCount),
  };
}

export interface AgentCardView {
  ok: boolean;
  name: string;
  description: string;
  capabilities: SkillChip[];
  status: string | null;
  serviceable: boolean;
  pricing: PricingView;
  currency: string | null;
  trust: TrustView;
  trustBreakdown: TrustBreakdownRow[];
  trackRecord: CardTrackRecordView;
  reputationOnChain: OnChainReputationView;
  dbReputation: ReputationView;
  identifiers: IdentifierRow[];
  supportedTokens: string[];
  hireEndpoint: string | null;
  trackRecordUrl: string | null;
}

export function buildAgentCardView(row: DiscoverAgentView | null, cardPayload: unknown): AgentCardView | null {
  if (!cardPayload || typeof cardPayload !== "object") return null;
  const body = cardPayload as Record<string, unknown>;
  const card = (body.success && body.agentCard ? body.agentCard : body) as Record<string, unknown> | null;
  if (!card || typeof card !== "object") return null;

  const cardName = asString(card.name, 120);
  const identity =
    card.identity && typeof card.identity === "object" ? (card.identity as Record<string, unknown>) : null;
  const wallet =
    card.wallet && typeof card.wallet === "object" ? (card.wallet as Record<string, unknown>) : null;
  const cardTokenId = card.erc8004TokenId ?? card.agentId;
  const scaField =
    typeof identity?.scaAddress === "string" ? identity.scaAddress : typeof wallet?.scaAddress === "string" ? wallet.scaAddress : "";

  // A card payload that references no agent at all (no name, no token id, no
  // wallet/identity) is malformed — refuse it so the detail view can show a
  // clean error instead of rendering an empty card. Anchoring is card-only:
  // a backing discover row is NOT enough, because an unanchored card means the
  // card fetch itself returned junk, which the UI must surface.
  const anchored = !!(cardName || cardTokenId || scaField);
  if (!anchored) return null;

  const name = cardName || row?.name || "";
  const tokenIdField = cardTokenId ?? row?.tokenId;
  const idFields = {
    id: row?.id,
    tokenId: tokenIdField,
    scaAddress: scaField || undefined,
  };

  const pricing = parsePricing(card.pricing);
  const trust = trustView(card.trust);
  const reputationSummary =
    card.reputationSummary && typeof card.reputationSummary === "object"
      ? onChainReputationView((card.reputationSummary as Record<string, unknown>).onChain)
      : { present: false, readOk: false, score: null, count: null };

  const cardReputation =
    card.reputation && typeof card.reputation === "object" ? (card.reputation as Record<string, unknown>) : null;
  let dbRep = reputationView(cardReputation?.score);
  if (!dbRep.present) dbRep = reputationView((card.reputationSummary as Record<string, unknown> | undefined)?.dbReputation);

  const cardTrust =
    card.trust && typeof card.trust === "object" ? (card.trust as Record<string, unknown>) : null;

  const supportedTokens = Array.isArray(card.supportedTokens)
    ? card.supportedTokens.map((t: unknown) => String(t)).filter(Boolean).slice(0, 8)
    : [];

  const hiring = card.hiring && typeof card.hiring === "object" ? (card.hiring as Record<string, unknown>) : null;
  const hireEndpoint =
    typeof hiring?.hireEndpoint === "string" && hiring.hireEndpoint ? hiring.hireEndpoint : row?.hireUrl ?? null;

  return {
    ok: true,
    name,
    description: asString(card.description, 800) || row?.description || "",
    capabilities: normalizeCapabilities(card.capabilities ?? card.skills ?? row?.capabilities),
    status: typeof card.status === "string" ? card.status : row?.status ?? null,
    serviceable: agentIsServiceable(card.status ?? row?.status),
    pricing,
    currency: typeof card.currency === "string" ? card.currency : null,
    trust,
    trustBreakdown: trustBreakdownView(cardTrust?.breakdown),
    trackRecord: cardTrackRecordView(card.trackRecord),
    reputationOnChain: reputationSummary,
    dbReputation: dbRep,
    identifiers: agentIdentifierRows(idFields),
    supportedTokens,
    hireEndpoint,
    trackRecordUrl: typeof card.trackRecordUrl === "string" ? card.trackRecordUrl : row?.trackRecordUrl ?? null,
  };
}
