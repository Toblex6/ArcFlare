"use client";

// src/app/marketplace/page.tsx
// x402 Marketplace: discover published API listings, pay per-request with
// USDC, and (for providers) publish/manage your own listings + usage
// analytics. Payment flow is a direct copy of nano/page.tsx's handlePay —
// same /api/x402/pay call, same request shape — so there's one payment
// client in the app, not two.

import React, { useState, useEffect, useCallback } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";
import AgentDiscovery from "@/components/marketplace/AgentDiscovery";

const API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || "";

// resolveMerchant() fails closed if an x-api-key header is present but
// doesn't match — it will NOT fall back to the dashboard cookie session in
// that case. So only attach the header when we actually have a real key;
// otherwise let the browser's merchant_token cookie do the auth.
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return API_KEY ? { ...extra, "x-api-key": API_KEY } : extra;
}

// ── Types ──────────────────────────────────────────────────────────────
interface Listing {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    categories: string[];
    pricePerRequest: string;
    docsUrl: string | null;
    merchantId: string | null;
    status?: string;
    createdAt: string;
}

interface PayResult {
    success: boolean;
    paidWith?: string;
    amountUSDC?: string;
    transaction?: string;
    resourceData?: {
        paymentStatus?: string;
        upstreamOk?: boolean;
        upstreamStatus?: number | null;
        error?: string | null;
        data?: unknown;
    };
    error?: string;
    // Pre-charge refusal fields (agent listings / suspended listings)
    charged?: boolean;
    suspended?: boolean;
    hireEndpoint?: string;
    cardEndpoint?: string;
}

interface WalletInfo {
    address: string;
    gatewayBalance: string;
    walletBalance: string;
}

interface Analytics {
    listing: { slug: string; name: string; status: string };
    analytics: {
        totalRequests: number;
        successfulPayments: number;
        failedPayments: number;
        totalRevenueUSDC: number;
        successRate: number;
        deliverySuccessRate: number | null;
        upstreamFailures: number;
    };
    recentPayments: Array<{
        reference: string;
        amount: number;
        status: string;
        gatewayReference: string | null;
        upstreamOk: boolean | null;
        upstreamStatus: number | null;
        timestamp: string;
        payer: string;
    }>;
}

// ── Styles — matches nano/page.tsx conventions ───────────────────────────
const styles = {
    page: {
        display: "flex",
        minHeight: "100vh",
        background: "var(--background)",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "var(--text)",
    } as React.CSSProperties,
    main: { flex: 1, padding: "32px", overflowX: "hidden" as const },
    card: {
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 24,
        marginBottom: 20,
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
        marginBottom: 10,
    } as React.CSSProperties,
    label: {
        fontSize: 10,
        color: "var(--text-secondary)",
        textTransform: "uppercase" as const,
        letterSpacing: 1,
        marginBottom: 4,
        display: "block" as const,
    } as React.CSSProperties,
    errorBox: {
        background: "rgba(239,68,68,0.08)",
        border: "1px solid rgba(239,68,68,0.2)",
        borderRadius: 10,
        padding: 12,
        color: "var(--danger)",
        marginBottom: 16,
    } as React.CSSProperties,
    successBox: {
        background: "rgba(16,185,129,0.06)",
        border: "1px solid rgba(16,185,129,0.2)",
        borderRadius: 10,
        padding: 12,
        color: "var(--success)",
        marginBottom: 16,
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
    tag: {
        fontSize: 10,
        color: "var(--text-secondary)",
        background: "var(--surface-secondary)",
        border: "1px solid var(--border)",
        borderRadius: 20,
        padding: "3px 10px",
    } as React.CSSProperties,
    // Agent Card modal — centered popup, mobile friendly
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
        maxWidth: 460,
        maxHeight: "80vh",
        display: "flex",
        flexDirection: "column" as const,
        boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
    } as React.CSSProperties,
    modalHeader: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "14px 16px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
    } as React.CSSProperties,
    modalBody: {
        padding: 16,
        overflowY: "auto" as const,
        fontSize: 12,
        display: "flex",
        flexDirection: "column" as const,
        gap: 10,
    } as React.CSSProperties,
    modalRow: {
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        alignItems: "baseline" as const,
    } as React.CSSProperties,
    modalLabel: {
        fontSize: 10,
        color: "var(--text-secondary)",
        textTransform: "uppercase" as const,
        letterSpacing: 1,
        flexShrink: 0,
    } as React.CSSProperties,
    modalValue: {
        margin: 0,
        textAlign: "right" as const,
        wordBreak: "break-all" as const,
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
    mono: { fontFamily: "monospace", fontSize: 11 } as React.CSSProperties,
};

const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: "8px 16px",
    borderRadius: 8,
    fontSize: 12,
    cursor: "pointer",
    border: `1px solid ${active ? "var(--primary)" : "var(--border)"}`,
    background: active ? "rgba(200,151,90,0.1)" : "transparent",
    color: active ? "var(--primary)" : "var(--text-secondary)",
    fontWeight: active ? 700 : 400,
});

const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: "5px 12px",
    borderRadius: 20,
    fontSize: 11,
    cursor: "pointer",
    border: `1px solid ${active ? "var(--primary)" : "var(--border)"}`,
    background: active ? "rgba(200,151,90,0.1)" : "transparent",
    color: active ? "var(--primary)" : "var(--text-secondary)",
    fontWeight: active ? 700 : 500,
});

const btnStyle = (disabled = false): React.CSSProperties => ({
    padding: "10px 20px",
    background: disabled ? "rgba(200,151,90,0.3)" : "var(--primary)",
    color: disabled ? "rgba(14,11,8,0.5)" : "var(--background)",
    border: "none",
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
});

const badgeStyle = (status?: string): React.CSSProperties => {
    const base = { padding: "2px 10px", borderRadius: 12, fontSize: 10, fontWeight: 700 };
    if (status === "PUBLISHED") return { ...base, background: "rgba(16,185,129,0.12)", color: "var(--success)" };
    if (status === "DRAFT") return { ...base, background: "rgba(245,158,11,0.12)", color: "var(--warning)" };
    return { ...base, background: "rgba(239,68,68,0.12)", color: "var(--danger)" };
};

export default function MarketplacePage() {
    const [tab, setTab] = useState<"discover" | "publish" | "mine" | "agents">("discover");

    // ── Discover state ──
    const [listings, setListings] = useState<Listing[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // ── Pay state (per-slug, keyed so multiple cards don't collide) ──
    const [wallet, setWallet] = useState<WalletInfo | null>(null);
    const [walletLoading, setWalletLoading] = useState(true);
    const [payingSlug, setPayingSlug] = useState<string | null>(null);
    const [payResultBySlug, setPayResultBySlug] = useState<Record<string, PayResult>>({});

    // ── Publish state ──
    const [pName, setPName] = useState("");
    const [pDescription, setPDescription] = useState("");
    const [pCategories, setPCategories] = useState("");
    const [pPrice, setPPrice] = useState("$0.01");
    const [pDocsUrl, setPDocsUrl] = useState("");
    const [pTargetUrl, setPTargetUrl] = useState("");
    const [publishing, setPublishing] = useState(false);
    const [publishResult, setPublishResult] = useState<any>(null);
    const [publishError, setPublishError] = useState<string | null>(null);

    // ── My listings state ──
    const [mine, setMine] = useState<Listing[]>([]);
    const [mineLoading, setMineLoading] = useState(false);
    const [statusUpdating, setStatusUpdating] = useState<string | null>(null);
    const [analyticsBySlug, setAnalyticsBySlug] = useState<Record<string, Analytics>>({});
    const [analyticsOpenSlug, setAnalyticsOpenSlug] = useState<string | null>(null);

    // ── Agent economy state (Build 4) ──
    // Agent discovery (browse → inspect → hire) now lives in
    // <AgentDiscovery /> (src/components/marketplace/AgentDiscovery.tsx),
    // which drives /api/agents/discover, the public agent card route and the
    // canonical hire route through the consumerDiscovery view-model helpers.

    // ── Fetch discovery listings ──
    const fetchListings = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (search) params.set("search", search);
            if (category) params.set("category", category);
            const res = await fetch(`/api/x402/marketplace?${params.toString()}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            setListings(data.listings);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [search, category]);

    useEffect(() => {
        if (tab === "discover") fetchListings();
    }, [tab, fetchListings]);

    const fetchMine = useCallback(async () => {
        setMineLoading(true);
        try {
            const res = await fetch("/api/x402/marketplace/mine", {
                headers: authHeaders(),
            });
            const data = await res.json();
            if (data.success) setMine(data.listings);
        } catch {
            // fall through — table just shows empty
        } finally {
            setMineLoading(false);
        }
    }, []);

    useEffect(() => {
        if (tab === "mine") fetchMine();
    }, [tab, fetchMine]);

    const fetchWallet = useCallback(async () => {
        setWalletLoading(true);
        try {
            const res = await fetch("/api/x402/eoa-wallet/me", { headers: authHeaders() });
            const data = await res.json();
            if (data.success) setWallet({ address: data.address, gatewayBalance: data.gatewayBalance, walletBalance: data.walletBalance });
        } catch {
            // Pay button will surface the real error if this failed silently
        } finally {
            setWalletLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchWallet();
    }, [fetchWallet]);

    const allCategories = Array.from(new Set(listings.flatMap((l) => l.categories)));

    // ── Pay with USDC — the caller's own wallet is resolved server-side from
    // their merchant identity, same as everywhere else in this file. Nothing
    // typed in the UI selects which wallet pays anymore. ──
    const handlePay = async (slug: string) => {
        setPayingSlug(slug);
        try {
            const res = await fetch("/api/x402/pay", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({
                    resourceUrl: `${window.location.origin}/api/x402/marketplace/pay/${slug}`,
                }),
            });
            const data = await res.json();
            setPayResultBySlug((prev) => ({ ...prev, [slug]: data }));
            if (data.success) fetchWallet(); // balance just changed
        } catch (e: any) {
            setPayResultBySlug((prev) => ({ ...prev, [slug]: { success: false, error: e.message } }));
        } finally {
            setPayingSlug(null);
        }
    };

    // ── Publish a new listing ──
    const handlePublish = async () => {
        setPublishing(true);
        setPublishError(null);
        setPublishResult(null);
        try {
            const res = await fetch("/api/x402/marketplace", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({
                    name: pName,
                    description: pDescription || undefined,
                    categories: pCategories.split(",").map((c) => c.trim()).filter(Boolean),
                    pricePerRequest: pPrice,
                    docsUrl: pDocsUrl || undefined,
                    targetUrl: pTargetUrl,
                }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            setPublishResult(data);
            setPName("");
            setPDescription("");
            setPCategories("");
            setPPrice("$0.01");
            setPDocsUrl("");
            setPTargetUrl("");
        } catch (e: any) {
            setPublishError(e.message);
        } finally {
            setPublishing(false);
        }
    };

    // ── Toggle publish status on an existing listing ──
    const toggleStatus = async (slug: string, nextStatus: string) => {
        setStatusUpdating(slug);
        try {
            const res = await fetch(`/api/x402/marketplace/${slug}`, {
                method: "PATCH",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ status: nextStatus }),
            });
            const data = await res.json();
            if (data.success) fetchMine();
        } finally {
            setStatusUpdating(null);
        }
    };

    const toggleAnalytics = async (slug: string) => {
        if (analyticsOpenSlug === slug) {
            setAnalyticsOpenSlug(null);
            return;
        }
        if (!analyticsBySlug[slug]) {
            try {
                const res = await fetch(`/api/x402/marketplace/${slug}/analytics`, {
                    headers: authHeaders(),
                });
                const data = await res.json();
                if (data.success) setAnalyticsBySlug((prev) => ({ ...prev, [slug]: data }));
            } catch {
                // leave panel closed on failure
                return;
            }
        }
        setAnalyticsOpenSlug(slug);
    };

    return (
        <div className="light" style={styles.page}>
            <DashboardSidebar active="Marketplace" />

            <main style={styles.main}>
                <div style={{ marginBottom: 28 }}>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: "0 0 4px" }}>
                        x402 Marketplace
                    </h1>
                    <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: 0 }}>
                        Discover and monetize APIs secured with x402. Pay per request in USDC — no accounts, no subscriptions.
                    </p>
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
                    <button style={tabStyle(tab === "discover")} onClick={() => setTab("discover")}>
                        🔍 Discover
                    </button>
                    <button style={tabStyle(tab === "agents")} onClick={() => setTab("agents")}>
                        🤖 Agents
                    </button>
                    <button style={tabStyle(tab === "publish")} onClick={() => setTab("publish")}>
                        📤 Publish an API
                    </button>
                    <button style={tabStyle(tab === "mine")} onClick={() => setTab("mine")}>
                        📋 My Listings
                    </button>
                </div>

                {/* ══════════════════════════════════════════════════════ */}
                {/* DISCOVER                                                */}
                {/* ══════════════════════════════════════════════════════ */}
                {tab === "discover" && (
                    <>
                        {error && <div style={styles.errorBox}>❌ {error}</div>}

                        <div style={{ ...styles.card, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 8 }}>
                            <div>
                                <span style={styles.label}>Your x402 Wallet</span>
                                {walletLoading ? (
                                    <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>Loading...</p>
                                ) : wallet ? (
                                    <p style={{ margin: 0, fontFamily: "monospace", fontSize: 12 }}>
                                        {wallet.address} — <span style={{ color: "var(--primary)", fontWeight: 700 }}>{wallet.gatewayBalance} USDC</span> available
                                    </p>
                                ) : (
                                    <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>Couldn't load your wallet — log in and retry.</p>
                                )}
                            </div>
                            <button style={btnStyle(false)} onClick={fetchWallet}>Refresh Balance</button>
                        </div>

                        <div style={styles.card}>
                            <input
                                style={styles.input}
                                placeholder="Search listings by name or description..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && fetchListings()}
                            />
                            {allCategories.length > 0 && (
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, marginTop: 4 }}>
                                    <span style={chipStyle(category === null)} onClick={() => setCategory(null)}>
                                        All
                                    </span>
                                    {allCategories.map((c) => (
                                        <span key={c} style={chipStyle(category === c)} onClick={() => setCategory(c)}>
                                            {c}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>

                        {loading ? (
                            <p style={{ color: "var(--text-secondary)" }}>Loading listings...</p>
                        ) : listings.length === 0 ? (
                            <div style={styles.card}>
                                <p style={{ color: "var(--text-secondary)", margin: 0 }}>
                                    No published listings yet. Be the first — head to the "Publish an API" tab.
                                </p>
                            </div>
                        ) : (
                            <div style={styles.grid}>
                                {listings.map((listing) => {
                                    const payResult = payResultBySlug[listing.slug];
                                    return (
                                        <div key={listing.id} style={styles.listingCard}>
                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                                                <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{listing.name}</h3>
                                                <span style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--primary)", fontSize: 14 }}>
                                                    {listing.pricePerRequest}
                                                </span>
                                            </div>

                                            {listing.description && (
                                                <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: 0 }}>{listing.description}</p>
                                            )}

                                            {listing.categories.length > 0 && (
                                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                                                    {listing.categories.map((c) => (
                                                        <span key={c} style={styles.tag}>{c}</span>
                                                    ))}
                                                </div>
                                            )}

                                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-secondary)" }}>
                                                <span>Provider: {listing.merchantId ? `${listing.merchantId.slice(0, 8)}...` : "Unknown"}</span>
                                                {listing.docsUrl && (
                                                    <a href={listing.docsUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary)" }}>
                                                        Docs →
                                                    </a>
                                                )}
                                            </div>

                                            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}>
                                                <button
                                                    style={{ ...btnStyle(payingSlug === listing.slug), width: "100%" }}
                                                    disabled={payingSlug === listing.slug}
                                                    onClick={() => handlePay(listing.slug)}
                                                >
                                                    {payingSlug === listing.slug ? "Paying..." : `Pay ${listing.pricePerRequest} with USDC`}
                                                </button>
                                                {payResult && (() => {
                                                    // Three distinct states, not just success/fail:
                                                    const paymentFailed = !payResult.success;
                                                    const paymentOkUpstreamFailed = payResult.success && payResult.resourceData?.upstreamOk === false;
                                                    const fullySucceeded = payResult.success && payResult.resourceData?.upstreamOk !== false;

                                                    if (paymentFailed) {
                                                        // Agent listings and suspended listings get
                                                        // actionable copy — no charge ever happened.
                                                        if (payResult.hireEndpoint) {
                                                            return (
                                                                <div style={{ ...styles.errorBox, marginTop: 8, marginBottom: 0, background: "rgba(59,130,246,0.08)", borderColor: "rgba(59,130,246,0.3)" }}>
                                                                    <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 12, color: "#3b82f6" }}>
                                                                        🤖 This is an agent listing — hire it instead
                                                                    </p>
                                                                    <p style={{ margin: 0, fontSize: 11, color: "var(--text-secondary)" }}>
                                                                        Agent listings are hired for a job (with budget + acceptance criteria),
                                                                        not paid per request. No payment was attempted.
                                                                        {payResult.cardEndpoint ? " View the agent's card via its card endpoint." : ""}
                                                                    </p>
                                                                </div>
                                                            );
                                                        }
                                                        const notCharged = payResult.charged === false;
                                                        return (
                                                            <div style={{ ...styles.errorBox, marginTop: 8, marginBottom: 0 }}>
                                                                <p style={{ margin: 0, fontSize: 12 }}>
                                                                    ❌ Payment failed: {payResult.error}
                                                                    {notCharged ? " (You were not charged.)" : ""}
                                                                </p>
                                                            </div>
                                                        );
                                                    }
                                                    if (paymentOkUpstreamFailed) {
                                                        return (
                                                            <div style={{ ...styles.errorBox, marginTop: 8, marginBottom: 0, background: "rgba(245,158,11,0.08)", borderColor: "rgba(245,158,11,0.25)" }}>
                                                                <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 12, color: "var(--warning)" }}>
                                                                    ⚠️ Paid {payResult.amountUSDC} USDC, but the provider's API failed
                                                                </p>
                                                                <p style={{ margin: 0, fontSize: 11, color: "var(--text-secondary)" }}>
                                                                    {payResult.resourceData?.error || `Upstream returned ${payResult.resourceData?.upstreamStatus}.`} This is a provider-side issue — your payment still went through.
                                                                </p>
                                                            </div>
                                                        );
                                                    }
                                                    return (
                                                        <div style={{ ...styles.successBox, marginTop: 8, marginBottom: 0 }}>
                                                            <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 12 }}>✅ Paid {payResult.amountUSDC} USDC — delivered</p>
                                                            <p style={{ margin: 0, fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace" }}>
                                                                Settlement ref: {payResult.transaction?.slice(0, 18)}...
                                                                <br />
                                                                <span style={{ fontFamily: "inherit" }}>
                                                                    Gateway batches this onchain periodically — not yet a resolvable tx hash.
                                                                </span>
                                                            </p>
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}
                {tab === "agents" && <AgentDiscovery />}

                {/* ══════════════════════════════════════════════════════ */}
                {/* PUBLISH                                                 */}
                {/* ══════════════════════════════════════════════════════ */}
                {tab === "publish" && (
                    <div style={styles.card}>
                        <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 4px" }}>Publish a new API listing</h3>
                        <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "0 0 16px" }}>
                            Listings start as a draft. Publish it from "My Listings" once you've confirmed it works.
                        </p>

                        <span style={styles.label}>API Name</span>
                        <input style={styles.input} value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Weather Lookup API" />

                        <span style={styles.label}>Description</span>
                        <input style={styles.input} value={pDescription} onChange={(e) => setPDescription(e.target.value)} placeholder="Current weather by city" />

                        <span style={styles.label}>Categories (comma-separated)</span>
                        <input style={styles.input} value={pCategories} onChange={(e) => setPCategories(e.target.value)} placeholder="weather, data" />

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <div>
                                <span style={styles.label}>Price per request</span>
                                <input style={styles.input} value={pPrice} onChange={(e) => setPPrice(e.target.value)} placeholder="$0.01" />
                            </div>
                            <div>
                                <span style={styles.label}>Docs URL (optional)</span>
                                <input style={styles.input} value={pDocsUrl} onChange={(e) => setPDocsUrl(e.target.value)} placeholder="https://..." />
                            </div>
                        </div>

                        <span style={styles.label}>Target URL (your upstream API — where paid requests get proxied)</span>
                        <input style={styles.input} value={pTargetUrl} onChange={(e) => setPTargetUrl(e.target.value)} placeholder="https://your-api.com/endpoint" />

                        <button style={btnStyle(publishing || !pName || !pPrice || !pTargetUrl)} disabled={publishing || !pName || !pPrice || !pTargetUrl} onClick={handlePublish}>
                            {publishing ? "Creating..." : "Create Draft Listing"}
                        </button>

                        {publishError && <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>❌ {publishError}</p>}
                        {publishResult && (
                            <div style={{ ...styles.successBox, marginTop: 14 }}>
                                <p style={{ margin: "0 0 4px", fontWeight: 700 }}>✅ Draft created: {publishResult.listing.slug}</p>
                                <p style={{ margin: 0, fontSize: 12 }}>{publishResult.message}</p>
                            </div>
                        )}
                    </div>
                )}

                {/* ══════════════════════════════════════════════════════ */}
                {/* MY LISTINGS                                             */}
                {/* ══════════════════════════════════════════════════════ */}
                {tab === "mine" && (
                    <>
                        {mineLoading ? (
                            <p style={{ color: "var(--text-secondary)" }}>Loading your listings...</p>
                        ) : mine.length === 0 ? (
                            <div style={styles.card}>
                                <p style={{ color: "var(--text-secondary)", margin: 0 }}>
                                    You haven't published any listings yet.
                                </p>
                            </div>
                        ) : (
                            mine.map((listing) => (
                                <div key={listing.id} style={styles.card}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{listing.name}</h3>
                                            <span style={badgeStyle(listing.status)}>{listing.status}</span>
                                        </div>
                                        <span style={{ fontFamily: "monospace", color: "var(--primary)", fontWeight: 700 }}>
                                            {listing.pricePerRequest}
                                        </span>
                                    </div>
                                    <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "0 0 12px" }}>
                                        /api/x402/marketplace/pay/{listing.slug}
                                    </p>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                                        {listing.status !== "PUBLISHED" && (
                                            <button style={btnStyle(statusUpdating === listing.slug)} disabled={statusUpdating === listing.slug} onClick={() => toggleStatus(listing.slug, "PUBLISHED")}>
                                                Publish
                                            </button>
                                        )}
                                        {listing.status === "PUBLISHED" && (
                                            <button style={btnStyle(statusUpdating === listing.slug)} disabled={statusUpdating === listing.slug} onClick={() => toggleStatus(listing.slug, "SUSPENDED")}>
                                                Suspend
                                            </button>
                                        )}
                                        <button style={btnStyle(false)} onClick={() => toggleAnalytics(listing.slug)}>
                                            {analyticsOpenSlug === listing.slug ? "Hide Analytics" : "View Analytics"}
                                        </button>
                                    </div>

                                    {analyticsOpenSlug === listing.slug && analyticsBySlug[listing.slug] && (
                                        <div style={{ marginTop: 14, background: "var(--surface-secondary)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
                                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
                                                <div>
                                                    <p style={styles.label}>Requests</p>
                                                    <p style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>{analyticsBySlug[listing.slug].analytics.totalRequests}</p>
                                                </div>
                                                <div>
                                                    <p style={styles.label}>Success Rate</p>
                                                    <p style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>{analyticsBySlug[listing.slug].analytics.successRate}%</p>
                                                </div>
                                                <div>
                                                    <p style={styles.label}>Revenue</p>
                                                    <p style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>{analyticsBySlug[listing.slug].analytics.totalRevenueUSDC} USDC</p>
                                                </div>
                                                <div>
                                                    <p style={styles.label}>Failed</p>
                                                    <p style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>{analyticsBySlug[listing.slug].analytics.failedPayments}</p>
                                                </div>
                                            </div>
                                            {analyticsBySlug[listing.slug].recentPayments.length > 0 && (
                                                <div style={{ overflowX: "auto" as const }}>
                                                    <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12, fontFamily: "monospace" }}>
                                                        <thead>
                                                            <tr>
                                                                <th style={{ textAlign: "left" as const, padding: "6px 8px 6px 0", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>Reference</th>
                                                                <th style={{ textAlign: "left" as const, padding: "6px 8px 6px 0", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>Amount</th>
                                                                <th style={{ textAlign: "left" as const, padding: "6px 8px 6px 0", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>Payer</th>
                                                                <th style={{ textAlign: "left" as const, padding: "6px 8px 6px 0", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>Status</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {analyticsBySlug[listing.slug].recentPayments.map((p) => (
                                                                <tr key={p.reference}>
                                                                    <td style={{ padding: "6px 8px 6px 0" }}>{p.reference.slice(0, 16)}...</td>
                                                                    <td style={{ padding: "6px 8px 6px 0" }}>{p.amount} USDC</td>
                                                                    <td style={{ padding: "6px 8px 6px 0" }}>{p.payer.slice(0, 10)}...</td>
                                                                    <td style={{ padding: "6px 8px 6px 0" }}>
                                                                        <span style={badgeStyle(p.status === "SUCCESS" ? "PUBLISHED" : "SUSPENDED")}>{p.status}</span>
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
