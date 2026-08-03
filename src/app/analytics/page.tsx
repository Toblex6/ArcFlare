"use client";

// src/app/analytics/page.tsx
// Merchant-facing analytics dashboard. Consumes /api/merchant/analytics —
// every number here is real (PaymentLog/Escrow/ApiListing), nothing fabricated.

import React, { useState, useEffect } from "react";
import DashboardSidebar from "@/components/DashboardSidebar";

const API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || "";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return API_KEY ? { ...extra, "x-api-key": API_KEY } : extra;
}

interface AnalyticsData {
    revenue: {
        totalRevenueUSDC: number;
        successfulPayments: number;
        failedPayments: number;
        pendingPayments: number;
        totalPayments: number;
        successRate: number;
    };
    paymentLinks: {
        totalLinks: number;
        successfulLinks: number;
        conversionRate: number;
    };
    escrow: {
        totalEscrows: number;
        totalValueUSDC: number;
        byStatus: Record<string, number>;
    };
    x402Marketplace: {
        totalListings: number;
        publishedListings: number;
        totalRequests: number;
        revenueUSDC: number;
    };
    aiAgents: {
        totalAgentPayments: number;
        agentSpendUSDC: number;
    };
    notTracked: Record<string, string>;
}

const styles = {
    page: { display: "flex", minHeight: "100vh", background: "var(--background)", color: "var(--text)" } as React.CSSProperties,
    main: { flex: 1, padding: "32px" } as React.CSSProperties,
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 } as React.CSSProperties,
    card: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 20 } as React.CSSProperties,
    sectionCard: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 24, marginBottom: 20 } as React.CSSProperties,
    statLabel: { fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 6 },
    statValue: { fontSize: 26, fontWeight: 700, margin: 0 },
    statSub: { fontSize: 11, color: "var(--text-secondary)", marginTop: 4 },
    sectionTitle: { fontSize: 14, fontWeight: 700, margin: "0 0 14px" },
    notTrackedBox: {
        background: "rgba(245,158,11,0.06)",
        border: "1px solid rgba(245,158,11,0.2)",
        borderRadius: 10,
        padding: 14,
        fontSize: 12,
        color: "var(--text-secondary)",
    } as React.CSSProperties,
};

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div style={styles.card}>
            <div style={styles.statLabel}>{label}</div>
            <p style={styles.statValue}>{value}</p>
            {sub && <div style={styles.statSub}>{sub}</div>}
        </div>
    );
}

export default function AnalyticsPage() {
    const [data, setData] = useState<AnalyticsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch("/api/merchant/analytics", { headers: authHeaders() })
            .then((r) => r.json())
            .then((json) => {
                if (!json.success) throw new Error(json.error || "Failed to load analytics.");
                setData(json);
            })
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    return (
        <div style={styles.page}>
            <DashboardSidebar active="Analytics" />
            <main style={styles.main}>
                <div style={{ marginBottom: 28 }}>
                    <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Analytics</h1>
                    <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: 0 }}>
                        Revenue, escrow, x402 marketplace, and agent activity — sourced directly from your real payment records.
                    </p>
                </div>

                {loading && <p style={{ color: "var(--text-secondary)" }}>Loading analytics...</p>}
                {error && <div style={{ ...styles.notTrackedBox, borderColor: "rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.08)", color: "var(--danger)" }}>❌ {error}</div>}

                {data && (
                    <>
                        {/* ── Revenue ── */}
                        <div style={styles.sectionCard}>
                            <h3 style={styles.sectionTitle}>Revenue</h3>
                            <div style={styles.grid}>
                                <StatCard label="Total Revenue" value={`${data.revenue.totalRevenueUSDC} USDC`} />
                                <StatCard label="Success Rate" value={`${data.revenue.successRate}%`} sub={`${data.revenue.successfulPayments} of ${data.revenue.totalPayments} payments`} />
                                <StatCard label="Failed Payments" value={String(data.revenue.failedPayments)} />
                                <StatCard label="Pending Payments" value={String(data.revenue.pendingPayments)} />
                            </div>
                        </div>

                        {/* ── Payment Links ── */}
                        <div style={styles.sectionCard}>
                            <h3 style={styles.sectionTitle}>Payment Link Performance</h3>
                            <div style={styles.grid}>
                                <StatCard label="Links Created" value={String(data.paymentLinks.totalLinks)} />
                                <StatCard label="Links Paid" value={String(data.paymentLinks.successfulLinks)} />
                                <StatCard label="Conversion Rate" value={`${data.paymentLinks.conversionRate}%`} />
                            </div>
                        </div>

                        {/* ── Escrow ── */}
                        <div style={styles.sectionCard}>
                            <h3 style={styles.sectionTitle}>Escrow</h3>
                            <div style={styles.grid}>
                                <StatCard label="Total Escrows" value={String(data.escrow.totalEscrows)} />
                                <StatCard label="Total Value Held" value={`${data.escrow.totalValueUSDC} USDC`} />
                                {Object.entries(data.escrow.byStatus).map(([status, count]) => (
                                    <StatCard key={status} label={status} value={String(count)} />
                                ))}
                            </div>
                        </div>

                        {/* ── x402 Marketplace ── */}
                        <div style={styles.sectionCard}>
                            <h3 style={styles.sectionTitle}>x402 Marketplace</h3>
                            <div style={styles.grid}>
                                <StatCard label="Listings" value={String(data.x402Marketplace.totalListings)} sub={`${data.x402Marketplace.publishedListings} published`} />
                                <StatCard label="Total Requests" value={String(data.x402Marketplace.totalRequests)} />
                                <StatCard label="Marketplace Revenue" value={`${data.x402Marketplace.revenueUSDC} USDC`} />
                            </div>
                        </div>

                        {/* ── AI Agents ── */}
                        <div style={styles.sectionCard}>
                            <h3 style={styles.sectionTitle}>AI Agent Activity</h3>
                            <div style={styles.grid}>
                                <StatCard label="Agent Payments" value={String(data.aiAgents.totalAgentPayments)} />
                                <StatCard label="Agent Spend" value={`${data.aiAgents.agentSpendUSDC} USDC`} />
                            </div>
                        </div>

                        {/* ── Not tracked yet, shown honestly ── */}
                        <div style={styles.sectionCard}>
                            <h3 style={styles.sectionTitle}>Not Yet Tracked</h3>
                            <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "0 0 12px" }}>
                                These aren't shown as zero or estimated — they genuinely aren't tracked in the database yet.
                            </p>
                            {Object.entries(data.notTracked).map(([key, reason]) => (
                                <div key={key} style={{ ...styles.notTrackedBox, marginBottom: 8 }}>
                                    <strong style={{ textTransform: "capitalize" as const }}>{key.replace(/([A-Z])/g, " $1")}</strong>: {reason}
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}
