// src/components/marketplace/AgentDiscovery.tsx
//
// Consumer discovery experience for the agent marketplace (marketplace page,
// "Agents" tab). Journey: browse discoverable agents → inspect one → read its
// trust / reputation / economics / serviceability → start the right action.
//
// Everything rendered comes from EXISTING APIs through the pure view-model
// helpers in src/lib/discovery/consumerDiscovery.ts:
//   - browse / search / filter / sort → GET /api/agents/discover
//   - inspect → GET /api/agents/[id]/card
//   - hire → POST /api/agents/[id]/hire (the canonical agent hire route)
//   - session/wallet → GET /api/merchant/wallet
// No new backend, no client-invented trust scores, no second hiring backend.
// A malformed discover row or failed card fetch degrades only that card/detail.

"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AgentCardView,
  DiscoverAgentView,
  HireSessionKind,
  SERVICEABLE_STATUS,
  agentIdentifierRows,
  buildAgentCardView,
  buildDiscoverQuery,
  deriveAgentAction,
  formatUsdcPrice,
  humanStatusLabel,
  normalizeDiscoverPayload,
  shortAddress,
} from "@/lib/discovery/consumerDiscovery";

const STYLE = {
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  } as React.CSSProperties,
  input: {
    width: "100%",
    padding: "10px 14px",
    background: "var(--surface-secondary)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--text)",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,
  label: {
    fontSize: 10,
    color: "var(--text-secondary)",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginBottom: 4,
    display: "block" as const,
  } as React.CSSProperties,
  tag: {
    fontSize: 10,
    color: "var(--text-secondary)",
    background: "var(--surface-secondary)",
    border: "1px solid var(--border)",
    borderRadius: 20,
    padding: "3px 10px",
  } as React.CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: 16,
  } as React.CSSProperties,
  listingCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: 18,
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  } as React.CSSProperties,
  modalBackdrop: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: 16,
  } as React.CSSProperties,
  modalCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    width: "100%",
    maxWidth: 560,
    maxHeight: "88vh",
    display: "flex",
    flexDirection: "column" as const,
    boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  } as React.CSSProperties,
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 18px",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
    gap: 10,
  } as React.CSSProperties,
  modalBody: {
    padding: 18,
    overflowY: "auto" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: 14,
  } as React.CSSProperties,
  modalClose: {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 8,
    width: 30,
    height: 30,
    fontSize: 15,
    lineHeight: 1,
    cursor: "pointer",
    color: "var(--text-secondary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    padding: 0,
  } as React.CSSProperties,
  errorBox: {
    background: "rgba(239,68,68,0.08)",
    border: "1px solid rgba(239,68,68,0.2)",
    borderRadius: 10,
    padding: 12,
    color: "var(--danger)",
  } as React.CSSProperties,
  successBox: {
    background: "rgba(16,185,129,0.06)",
    border: "1px solid rgba(16,185,129,0.2)",
    borderRadius: 10,
    padding: 12,
    color: "var(--success)",
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text-secondary)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    margin: "0 0 8px",
  } as React.CSSProperties,
  mono: { fontFamily: "monospace", fontSize: 11, wordBreak: "break-all" as const } as React.CSSProperties,
  subPanel: {
    background: "var(--surface-secondary)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: 12,
  } as React.CSSProperties,
};

function trustColor(score: number): string {
  if (score >= 70) return "var(--success)";
  if (score >= 40) return "var(--warning)";
  return "var(--danger)";
}

function badge(active: boolean): React.CSSProperties {
  const base: React.CSSProperties = { padding: "2px 10px", borderRadius: 12, fontSize: 10, fontWeight: 700 };
  return active
    ? { ...base, background: "rgba(16,185,129,0.12)", color: "var(--success)" }
    : { ...base, background: "rgba(239,68,68,0.12)", color: "var(--danger)" };
}

function btnStyle(disabled = false): React.CSSProperties {
  return {
    padding: "10px 18px",
    background: disabled ? "rgba(200,151,90,0.3)" : "var(--primary)",
    color: disabled ? "rgba(14,11,8,0.5)" : "var(--background)",
    border: "none",
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function detailTrustOf(card: AgentCardView | null, row: DiscoverAgentView | null) {
  if (card?.trust.present) return card.trust;
  if (row?.trust.present) return row.trust;
  return null;
}

interface HireWallet {
  walletProvider: string | null;
  walletAddress: string | null;
  circleWalletId: string | null;
}

interface HireSuccess {
  success: boolean;
  jobId?: string;
  status?: string;
  agent?: { name?: string; tokenId?: string };
}

export default function AgentDiscovery() {
  // ── Browse / filter state ──
  const [agents, setAgents] = useState<DiscoverAgentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [malformedCount, setMalformedCount] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("trust");
  const [minTrust, setMinTrust] = useState("");

  // ── Inspect / detail state ──
  const [detailRow, setDetailRow] = useState<DiscoverAgentView | null>(null);
  const [detailCard, setDetailCard] = useState<AgentCardView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [hireOpen, setHireOpen] = useState(false);

  // ── Hire-sheet state ──
  const [hireDescription, setHireDescription] = useState("");
  const [hireRequirements, setHireRequirements] = useState("");
  const [hireBudget, setHireBudget] = useState("");
  const [hireSubmitting, setHireSubmitting] = useState(false);
  const [hireResult, setHireResult] = useState<HireSuccess | null>(null);
  const [hireError, setHireError] = useState<string | null>(null);

  // ── Wallet / session state (which caller may hire) ──
  const [hireWallet, setHireWallet] = useState<HireWallet | null>(null);
  const [walletChecked, setWalletChecked] = useState(false);

  const session: HireSessionKind = useMemo(() => {
    if (!walletChecked) return "unknown";
    if (!hireWallet) return "none"; // /api/merchant/wallet 401 → not signed in
    const circle = hireWallet.walletProvider?.toUpperCase() === "CIRCLE" && !!hireWallet.circleWalletId;
    return circle ? "ready" : "no-circle";
  }, [walletChecked, hireWallet]);

  const fetchAgents = useCallback(async (q: { search: string; sortBy: string; minTrust: string }) => {
    setLoading(true);
    setError(null);
    try {
      const qs = buildDiscoverQuery({
        search: q.search.trim() || undefined,
        sortBy: q.sortBy || undefined,
        minTrust: q.minTrust || undefined,
        limit: 30,
      });
      const res = await fetch(`/api/agents/discover${qs}`);
      const payload = await res.json().catch(() => null);
      const result = normalizeDiscoverPayload(payload);
      if (!result.ok) {
        setAgents([]);
        setError(result.error || "Discovery is unavailable right now.");
      } else {
        setAgents(result.agents);
        setMalformedCount(result.malformed);
      }
    } catch (e: any) {
      setAgents([]);
      setError(e?.message || "Could not load agents. Please retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Resolve the caller's hire wallet via the existing merchant-wallet route.
  // No session → 401 → hireWallet stays null and the action reads "Sign in".
  useEffect(() => {
    let cancelled = false;
    fetch("/api/merchant/wallet")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d?.success && d.wallet) {
          setHireWallet({
            walletProvider: d.wallet.walletProvider || null,
            walletAddress: d.wallet.walletAddress || null,
            circleWalletId: d.wallet.circleWalletId || null,
          });
        } else {
          setHireWallet(null);
        }
      })
      .catch(() => {
        if (!cancelled) setHireWallet(null);
      })
      .finally(() => {
        if (!cancelled) setWalletChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetchAgents({ search: "", sortBy: "trust", minTrust: "" });
  }, [fetchAgents]);

  const resetHire = () => {
    setHireOpen(false);
    setHireDescription("");
    setHireRequirements("");
    setHireBudget("");
    setHireResult(null);
    setHireError(null);
    setHireSubmitting(false);
  };

  const openDetail = async (row: DiscoverAgentView) => {
    setDetailRow(row);
    setDetailCard(null);
    setDetailError(null);
    resetHire();
    setDetailLoading(true);
    const url = row.cardUrl || (row.id !== null ? `/api/agents/${row.id}/card` : null);
    try {
      if (!url) throw new Error("This agent has no inspectable card.");
      const res = await fetch(url);
      const payload = await res.json().catch(() => null);
      const card = buildAgentCardView(row, payload);
      if (!card) throw new Error("This agent's details could not be read right now.");
      setDetailCard(card);
    } catch (e: any) {
      setDetailError(e?.message || "Could not load this agent's details.");
      setDetailCard(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetailRow(null);
    setDetailCard(null);
    setDetailError(null);
    resetHire();
  };

  const submitHire = async () => {
    if (!detailRow || !detailCard || !hireWallet?.circleWalletId) return;
    setHireSubmitting(true);
    setHireError(null);
    setHireResult(null);
    try {
      const requirements = hireRequirements
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const budget = Number(hireBudget);
      if (!hireDescription.trim()) throw new Error("Describe what the agent should do.");
      if (requirements.length === 0) throw new Error("List at least one acceptance criterion.");
      if (requirements.length > 50) throw new Error("Keep acceptance criteria under 50 lines.");
      if (!Number.isFinite(budget) || budget <= 0) throw new Error("Enter a budget in USDC greater than 0.");

      const endpoint = detailCard.hireEndpoint || `/api/agents/${detailRow.id}/hire`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientWalletId: hireWallet.circleWalletId,
          description: hireDescription.trim(),
          criteria: { requirements, deadlineUnix: Math.floor(Date.now() / 1000) + 7 * 86400 },
          budget,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Hire failed (HTTP ${res.status}).`);
      }
      setHireResult({ success: true, jobId: data.jobId, status: data.status, agent: data.agent });
    } catch (e: any) {
      setHireError(e?.message || "Could not start this job right now.");
    } finally {
      setHireSubmitting(false);
    }
  };

  const runSearch = () => {
    setSearch(searchInput);
    fetchAgents({ search: searchInput, sortBy, minTrust });
  };

  const filtersActive = search.trim() !== "" || sortBy !== "trust" || minTrust !== "";

  const detailName = detailCard?.name || detailRow?.name || "";
  const detailServiceable = detailCard ? detailCard.serviceable : detailRow?.serviceable ?? false;
  const detailStatus = detailCard?.status || detailRow?.status || null;
  const identifiers =
    detailCard && detailCard.identifiers.length > 0
      ? detailCard.identifiers
      : detailRow
        ? agentIdentifierRows({ id: detailRow.id, tokenId: detailRow.tokenId })
        : [];

  // ── Card grid ──
  const renderAgentCard = (row: DiscoverAgentView) => {
    const pricingLabel =
      row.pricing.perRequest !== null
        ? `${formatUsdcPrice(row.pricing.perRequest)} / request`
        : row.pricing.perJob !== null
          ? `${formatUsdcPrice(row.pricing.perJob)} / job`
          : null;
    return (
      <div key={row.id ?? row.tokenId ?? row.index} style={STYLE.listingCard}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{row.name}</h3>
          <span style={badge(row.serviceable)}>{row.serviceable ? "Active" : "Unavailable"}</span>
        </div>

        {row.description && (
          <p style={{ color: "var(--text-secondary)", fontSize: 11, margin: 0 }}>{row.description.slice(0, 140)}</p>
        )}

        {row.capabilities.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
            {row.capabilities.slice(0, 4).map((c, i) => (
              <span key={`${c.name}-${i}`} style={STYLE.tag}>{c.name}</span>
            ))}
            {row.capabilities.length > 4 && <span style={STYLE.tag}>+{row.capabilities.length - 4}</span>}
          </div>
        )}

        {pricingLabel && <div style={{ fontSize: 11, color: "var(--primary)", fontWeight: 700 }}>{pricingLabel}</div>}

        <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 2 }}>
          {row.trust.present && (
            <span>
              Trust <strong style={{ color: trustColor(row.trust.score!) }}>{row.trust.score}</strong>
              {row.trust.confidence !== null ? ` · conf ${row.trust.confidence}` : ""}
            </span>
          )}
          {!row.trust.present && row.reputation.present && <span>Reputation {row.reputation.score}</span>}
          {row.trackRecord && row.trackRecord.completedJobs !== null && (
            <span>{row.trackRecord.completedJobs} completed job(s)</span>
          )}
          {row.trackRecord && row.trackRecord.validatedVolumeUSDC !== null && (
            <span>{formatUsdcPrice(row.trackRecord.validatedVolumeUSDC)} validated volume</span>
          )}
        </div>

        <div style={{ marginTop: "auto" }}>
          <button style={{ ...btnStyle(false), flex: 1, padding: "8px 12px" }} onClick={() => openDetail(row)}>
            Inspect agent
          </button>
        </div>
      </div>
    );
  };

  // ── Detail sections ──
  const renderIdentifiers = () => (
    <div style={STYLE.subPanel}>
      <p style={STYLE.sectionTitle}>Identity & references</p>
      {identifiers.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>No identity references available.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {identifiers.map((id) => (
            <div key={id.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 10, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.5, flexShrink: 0 }}>
                {id.label}
              </span>
              <span style={{ ...STYLE.mono, fontSize: 11 }}>
                {id.kind === "sca" ? shortAddress(id.value) : id.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderTrust = () => {
    const trust = detailTrustOf(detailCard, detailRow);
    const card = detailCard;
    const hasOnChain = card?.reputationOnChain.present && card.reputationOnChain.readOk;
    const hasTrack = card?.trackRecord.present;
    if (!trust && !hasOnChain && !hasTrack) {
      return (
        <div style={STYLE.subPanel}>
          <p style={STYLE.sectionTitle}>Trust & track record</p>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
            No trust data available yet — this is a fresh agent with no verified work on record.
          </p>
        </div>
      );
    }
    return (
      <div style={STYLE.subPanel}>
        <p style={STYLE.sectionTitle}>Trust & track record</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {trust && (
              <span style={{ fontSize: 22, fontWeight: 800, color: trustColor(trust.score!) }}>
                {trust.score}
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)" }}>/100 trust</span>
              </span>
            )}
            {hasTrack && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {card.trackRecord.completedJobs !== null ? `${card.trackRecord.completedJobs} completed` : ""}
                {card.trackRecord.validatedJobs !== null ? ` · ${card.trackRecord.validatedJobs} validated` : ""}
                {card.trackRecord.validationPassRate !== null
                  ? ` · ${Math.round(card.trackRecord.validationPassRate * 100)}% pass`
                  : ""}
                {card.trackRecord.validatedVolumeUSDC !== null
                  ? ` · ${formatUsdcPrice(card.trackRecord.validatedVolumeUSDC)} validated vol`
                  : ""}
              </span>
            )}
          </div>
          {trust && trust.confidence !== null && (
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-secondary)" }}>
              Confidence {trust.confidence}/100 · methodology v{trust.methodologyVersion ?? "1.0"}
            </p>
          )}
          {hasOnChain && (
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-secondary)" }}>
              On-chain reputation: score {card.reputationOnChain.score ?? "—"} · {card.reputationOnChain.count ?? 0} record(s)
            </p>
          )}
          {card?.trustBreakdown && card.trustBreakdown.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {card.trustBreakdown.map((b) => (
                <div key={b.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <span style={{ color: "var(--text-secondary)" }}>{b.label}</span>
                  <span style={{ color: "var(--text)" }}>{b.value}/100</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderPricing = () => {
    const pricing = detailCard?.pricing.present ? detailCard.pricing : detailRow?.pricing.present ? detailRow!.pricing : null;
    return (
      <div style={STYLE.subPanel}>
        <p style={STYLE.sectionTitle}>Economics & pricing</p>
        {pricing?.present ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            {pricing.perRequest !== null && (
              <p style={{ margin: 0 }}>
                <strong>{formatUsdcPrice(pricing.perRequest)}</strong>
                <span style={{ color: "var(--text-secondary)", fontSize: 11 }}> per request</span>
              </p>
            )}
            {pricing.perJob !== null && (
              <p style={{ margin: 0 }}>
                <strong>{formatUsdcPrice(pricing.perJob)}</strong>
                <span style={{ color: "var(--text-secondary)", fontSize: 11 }}> per job</span>
              </p>
            )}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
            No fixed price listed — set a budget in USDC when you hire. Paid in USDC
            {detailCard?.currency ? ` (${detailCard.currency})` : ""}.
          </p>
        )}
      </div>
    );
  };

  const renderDetailBody = () => {
    if (detailLoading) {
      return (
        <div style={STYLE.modalBody}>
          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading agent details…</p>
        </div>
      );
    }
    const cardFailed = !detailCard && !!detailError;
    const capabilities = detailCard?.capabilities ?? detailRow?.capabilities ?? [];
    return (
      <div style={STYLE.modalBody}>
        {cardFailed && (
          <div style={STYLE.errorBox}>
            {detailError}
            <button
              style={{ ...btnStyle(false), marginTop: 8, padding: "6px 12px", fontSize: 12 }}
              onClick={() => openDetail(detailRow!)}
            >
              Retry
            </button>
          </div>
        )}

        {(detailCard?.description || detailRow?.description) && (
          <div>
            <p style={STYLE.sectionTitle}>What this agent does</p>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {detailCard?.description || detailRow?.description}
            </p>
          </div>
        )}

        {capabilities.length > 0 && (
          <div>
            <p style={STYLE.sectionTitle}>Capabilities</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
              {capabilities.map((c, i) => (
                <span key={`${c.name}-${i}`} style={{ ...STYLE.tag, fontSize: 11, padding: "4px 12px" }} title={c.description || undefined}>
                  {c.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {renderTrust()}
        {renderPricing()}
        {renderIdentifiers()}

        {detailRow?.trackRecordUrl && (
          <a href={detailRow.trackRecordUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--primary)", textDecoration: "none" }}>
            View verifiable track record →
          </a>
        )}

        {/* Serviceability-aware action */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={badge(detailServiceable)}>{detailServiceable ? "Ready to take jobs" : "Not serviceable"}</span>
            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              Status: {humanStatusLabel(detailStatus)}
            </span>
          </div>
          {(() => {
            const action = deriveAgentAction(detailStatus, session);
            if (cardFailed) return null;
            return (
              <>
                {action.reason && (
                  <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-secondary)" }}>{action.reason}</p>
                )}
                <button style={btnStyle(action.disabled)} disabled={action.disabled} onClick={() => setHireOpen(true)}>
                  {action.label}
                </button>
                {action.kind === "signin" && (
                  <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--text-secondary)" }}>
                    <a href="/merchant/login" style={{ color: "var(--primary)" }}>Business login</a> · jobs are funded from your wallet in escrow.
                  </p>
                )}
              </>
            );
          })()}
        </div>
      </div>
    );
  };

  // ── Hire sheet ──
  const renderHireSheet = () => {
    if (hireResult?.success) {
      return (
        <div style={STYLE.modalBody}>
          <div style={STYLE.successBox}>
            <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 13 }}>Job opened on Arc Testnet</p>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
              {hireResult.agent?.name ? `${hireResult.agent.name} · ` : ""}Job {hireResult.jobId} · status {hireResult.status}
            </p>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            This job is escrowed — funds only move when the work passes. Continue in{" "}
            <a href="/jobs" style={{ color: "var(--primary)" }}>Jobs</a> to fund it and manage the job.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btnStyle(false)} onClick={() => { setHireOpen(false); setHireResult(null); }}>Close</button>
          </div>
        </div>
      );
    }
    return (
      <div style={STYLE.modalBody}>
        <p style={STYLE.sectionTitle}>Hire {detailName} for a job</p>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
          Creates an escrowed job on Arc Testnet from your business wallet. The provider is only paid when the acceptance criteria pass.
        </p>
        <div>
          <span style={STYLE.label}>What needs doing?</span>
          <textarea
            style={{ ...STYLE.input, minHeight: 60, resize: "vertical" as const, fontFamily: "inherit" }}
            value={hireDescription}
            onChange={(e) => setHireDescription(e.target.value)}
            placeholder="e.g. Audit the escrow contract's release path and report findings."
          />
        </div>
        <div>
          <span style={STYLE.label}>Acceptance criteria (one per line)</span>
          <textarea
            style={{ ...STYLE.input, minHeight: 80, resize: "vertical" as const, fontFamily: "inherit" }}
            value={hireRequirements}
            onChange={(e) => setHireRequirements(e.target.value)}
            placeholder={"Deliver a written findings report\nInclude a PoC for each finding\nReply within 5 days"}
          />
        </div>
        <div>
          <span style={STYLE.label}>Budget (USDC)</span>
          <input
            style={STYLE.input}
            type="number"
            min="0"
            step="0.01"
            value={hireBudget}
            onChange={(e) => setHireBudget(e.target.value)}
            placeholder="0.00"
          />
        </div>
        {hireError && <div style={STYLE.errorBox}>❌ {hireError}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            style={btnStyle(hireSubmitting || !hireDescription.trim() || !hireBudget.trim() || !hireRequirements.trim())}
            disabled={hireSubmitting || !hireDescription.trim() || !hireBudget.trim() || !hireRequirements.trim()}
            onClick={submitHire}
          >
            {hireSubmitting ? "Creating escrowed job…" : "Create escrowed job"}
          </button>
          <button style={btnStyle(hireSubmitting)} disabled={hireSubmitting} onClick={() => setHireOpen(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Session / wallet strip */}
      <div style={STYLE.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 8 }}>
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>Discover agents you can hire</p>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-secondary)" }}>
              {session === "ready" && hireWallet?.walletAddress
                ? `Hiring from ${shortAddress(hireWallet.walletAddress)} (your business wallet)`
                : session === "no-circle"
                  ? "Your business account needs a Circle-managed wallet to hire."
                  : session === "none"
                    ? "Browse freely — sign in to hire an agent."
                    : "Checking your wallet…"}
            </p>
          </div>
          <a
            href="/merchant/login"
            style={{ fontSize: 12, color: "var(--primary)", textDecoration: "none", fontWeight: 600 }}
          >
            {session === "ready" ? "Switch account" : session === "none" ? "Sign in →" : ""}
          </a>
        </div>
      </div>

      {/* Filters */}
      <div style={STYLE.card}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center" }}>
          <input
            style={{ ...STYLE.input, flex: 1, margin: 0 }}
            placeholder="Search by name, description or capability…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            aria-label="Search agents"
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{ padding: "9px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface-secondary)", color: "var(--text)", fontSize: 12 }}
            aria-label="Sort agents"
          >
            <option value="trust">Sort: Trust ↓</option>
            <option value="reputation">Sort: Reputation ↓</option>
            <option value="createdAt">Sort: Newest</option>
            <option value="price">Sort: Price</option>
          </select>
          <select
            value={minTrust}
            onChange={(e) => setMinTrust(e.target.value)}
            style={{ padding: "9px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface-secondary)", color: "var(--text)", fontSize: 12 }}
            aria-label="Minimum trust filter"
          >
            <option value="">Min trust: Any</option>
            <option value="60">Min trust: 60+</option>
            <option value="75">Min trust: 75+</option>
            <option value="90">Min trust: 90+</option>
          </select>
          <button style={btnStyle(loading)} disabled={loading} onClick={runSearch}>
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--text-secondary)" }}>
          Only agents with on-chain status <span style={{ fontFamily: "monospace" }}>{SERVICEABLE_STATUS}</span> are listed.
          Trust scores are computed server-side — never by this page.
        </p>
      </div>

      {error && (
        <div style={{ ...STYLE.card, ...STYLE.errorBox }}>
          <p style={{ margin: "0 0 8px", fontSize: 13 }}>❌ {error}</p>
          <button style={{ ...btnStyle(false), padding: "6px 12px", fontSize: 12 }} disabled={loading} onClick={() => fetchAgents({ search, sortBy, minTrust })}>
            Retry
          </button>
        </div>
      )}

      {!error && loading && agents.length === 0 && (
        <div style={STYLE.card}>
          <p style={{ color: "var(--text-secondary)", margin: 0 }}>Loading agents…</p>
        </div>
      )}

      {/* Empty state */}
      {!error && !loading && agents.length === 0 && (
        <div style={STYLE.card}>
          <p style={{ fontSize: 24, margin: "0 0 8px", textAlign: "center" }}>🤖</p>
          {filtersActive ? (
            <>
              <p style={{ margin: "0 0 4px", fontSize: 13, textAlign: "center" }}>No agents match your search.</p>
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
                Try clearing the search or lowering the minimum trust filter.
              </p>
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 4px", fontSize: 13, textAlign: "center" }}>No discoverable agents yet.</p>
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
                Fully provisioned ERC-8004 agents appear here once deployed.
              </p>
            </>
          )}
        </div>
      )}

      {/* Grid */}
      {!error && agents.length > 0 && (
        <>
          {malformedCount > 0 && (
            <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "0 0 8px" }}>
              {malformedCount} agent record(s) couldn't be displayed and were skipped.
            </p>
          )}
          <div style={STYLE.grid}>{agents.map((row) => renderAgentCard(row))}</div>
        </>
      )}

      {/* Detail / hire modal */}
      {detailRow && (
        <div style={STYLE.modalBackdrop} onClick={closeDetail}>
          <div style={STYLE.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={STYLE.modalHeader}>
              <h3 style={{ margin: 0, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                {hireOpen ? `Hire ${detailName}` : detailName}
              </h3>
              <button style={STYLE.modalClose} aria-label="Close" onClick={hireOpen ? () => setHireOpen(false) : closeDetail}>✕</button>
            </div>
            {hireOpen ? renderHireSheet() : renderDetailBody()}
          </div>
        </div>
      )}
    </>
  );
}
