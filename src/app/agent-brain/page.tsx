"use client";

import React, { useState } from "react";
import DashboardSidebar from "@/src/components/DashboardSidebar";

const API_KEY = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY || "";
// Was hardcoded to "https://flarehq.xyz" — meant every local dev call silently
// hit production instead of localhost. Relative path works in both.
const API_BASE = "";

// resolveMerchant() fails closed if x-api-key is present but doesn't match —
// it will NOT fall back to the merchant_token cookie in that case. Only
// attach the header when we actually have a real key; otherwise the
// dashboard cookie session (the correct production path) does the auth.
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return API_KEY ? { ...extra, "x-api-key": API_KEY } : extra;
}

const EXAMPLE_PROMPTS = [
    "Pay 0.1 USDC to 0x954ebd124aedf03b784fcf2cb067de98f04bfa3a as a test A2A payment",
    "Create a job to hire 0x954ebd124aedf03b784fcf2cb067de98f04bfa3a for 5 USDC to write a summary, evaluate it myself",
    "Check the reputation score for agent token 847277",
    "Fetch the current price of ETH from a public API",
];

interface ToolResult {
    tool: string;
    result: any;
}

interface BrainResponse {
    success: boolean;
    response: string;
    toolsUsed: string[];
    results: ToolResult[];
    sessionId: string;
    agent: {
        tokenId: string;
        address: string;
        standard: string;
        network: string;
    };
    error?: string;
}

const styles = {
    card: {
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 24,
        marginBottom: 20,
    } as React.CSSProperties,
    input: {
        width: "100%",
        padding: "12px 14px",
        background: "var(--surface-secondary)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        color: "var(--text)",
        fontSize: 14,
        outline: "none",
        boxSizing: "border-box" as const,
        fontFamily: "inherit",
    } as React.CSSProperties,
    label: {
        fontSize: 11,
        color: "var(--text-secondary)",
        textTransform: "uppercase" as const,
        letterSpacing: 1,
        marginBottom: 6,
        display: "block" as const,
    } as React.CSSProperties,
};

const btnStyle = (disabled: boolean): React.CSSProperties => ({
    padding: "12px 24px",
    background: disabled ? "rgba(8,145,178,0.3)" : "var(--primary)",
    color: disabled ? "var(--text-secondary)" : "#0e0b08",
    border: "none",
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 14,
    cursor: disabled ? "not-allowed" : "pointer",
});

const badgeStyle = (color: string): React.CSSProperties => ({
    fontSize: 10,
    padding: "3px 10px",
    borderRadius: 12,
    background: `${color}15`,
    color,
    border: `1px solid ${color}40`,
    fontWeight: 700,
});

const ERC8004_TOOLS = new Set(["record_agent_reputation"]);
const ERC8183_TOOLS = new Set([
    "create_agent_job",
    "submit_job_deliverable",
    "complete_or_reject_job",
]);

function standardBadgeFor(toolName: string): { label: string; color: string } | null {
    if (ERC8004_TOOLS.has(toolName)) return { label: "ERC-8004", color: "#10b981" };
    if (ERC8183_TOOLS.has(toolName)) return { label: "ERC-8183", color: "#8b5cf6" };
    return null;
}

export default function AgentBrainPage() {
    const [message, setMessage] = useState("");
    const [eoaAddress, setEoaAddress] = useState("");
    const [sessionId, setSessionId] = useState("session-" + Date.now());
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<BrainResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    const callBrain = async () => {
        if (!message.trim() || !eoaAddress.trim()) {
            setError("Message and EOA wallet address are required.");
            return;
        }
        setLoading(true);
        setError(null);
        setResult(null);

        try {
            const res = await fetch(`${API_BASE}/api/x402/pay`, {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({
                    resourceUrl: `${window.location.origin}/api/agent/brain`,
                    eoaAddress,
                    body: JSON.stringify({ message, sessionId }),
                }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || "Brain call failed");
            setResult(data.resourceData || data);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="light" style={{ display: "flex", minHeight: "100vh", background: "var(--background)" }}>
            <DashboardSidebar active="AI Agent" />
            <main style={{ flex: 1, minWidth: 0, padding: "24px", overflowX: "hidden" }}>
                <div style={{ maxWidth: 900, margin: "0 auto" }}>
                    <div style={{ marginBottom: 28 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
                            <h1 style={{ fontSize: "clamp(20px, 4vw, 28px)", fontWeight: 700, margin: 0 }}>
                                FlareHQ Agent Brain
                            </h1>
                            <span style={badgeStyle("#10b981")}>ERC-8004</span>
                            <span style={badgeStyle("#8b5cf6")}>ERC-8183</span>
                            <span style={badgeStyle("var(--primary)")}>x402 Paid</span>
                        </div>
                        <p style={{ color: "var(--text-secondary)", fontSize: "clamp(12px, 1.2vw, 14px)", margin: 0 }}>
                            Autonomous agent-to-agent commerce — A2A payments, ERC-8183 escrow jobs, payroll,
                            subscriptions, cross-chain routing, and ERC-8004 reputation, all driven by natural language.
                        </p>
                    </div>

                    <div style={styles.card}>
                        <h3 style={{ fontSize: "clamp(16px, 1.5vw, 20px)", fontWeight: 700, margin: "0 0 20px" }}>
                            Talk to the Brain
                        </h3>
                        <p style={{ color: "var(--text-secondary)", fontSize: "clamp(12px, 1.2vw, 14px)", margin: "0 0 20px" }}>
                            This costs $0.002 USDC per call, paid via x402 from your EOA Gateway balance.
                        </p>

                        <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
                            <div>
                                <span style={styles.label}>Your EOA Wallet Address (needs Gateway balance)</span>
                                <input
                                    style={styles.input}
                                    value={eoaAddress}
                                    onChange={(e) => setEoaAddress(e.target.value)}
                                    placeholder="0x..."
                                />
                            </div>
                            <div>
                                <span style={styles.label}>Message</span>
                                <textarea
                                    style={{ ...styles.input, height: 90, resize: "vertical" as const }}
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    placeholder="e.g. Pay 0.1 USDC to 0x954eb... as a test A2A payment"
                                />
                            </div>
                            <div>
                                <span style={styles.label}>Session ID (keeps memory across calls)</span>
                                <input
                                    style={styles.input}
                                    value={sessionId}
                                    onChange={(e) => setSessionId(e.target.value)}
                                />
                            </div>

                            <div>
                                <span style={styles.label}>Try an example</span>
                                <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
                                    {EXAMPLE_PROMPTS.map((p) => (
                                        <span
                                            key={p}
                                            style={{
                                                fontSize: 11,
                                                padding: "6px 12px",
                                                borderRadius: 20,
                                                background: "rgba(8,145,178,0.08)",
                                                border: "1px solid rgba(8,145,178,0.2)",
                                                color: "var(--primary)",
                                                cursor: "pointer",
                                            }}
                                            onClick={() => setMessage(p)}
                                        >
                                            {p.length > 60 ? p.slice(0, 60) + "..." : p}
                                        </span>
                                    ))}
                                </div>
                            </div>

                            <button
                                style={btnStyle(loading || !message || !eoaAddress)}
                                disabled={loading || !message || !eoaAddress}
                                onClick={callBrain}
                            >
                                {loading ? "Brain thinking..." : "⚡ Call Brain ($0.002 USDC)"}
                            </button>
                        </div>

                        {error && (
                            <div
                                style={{
                                    marginTop: 16,
                                    background: "rgba(239,68,68,0.08)",
                                    border: "1px solid rgba(239,68,68,0.2)",
                                    borderRadius: 12,
                                    padding: 16,
                                }}
                            >
                                <p style={{ color: "var(--danger)", fontSize: 13, margin: 0 }}>❌ {error}</p>
                            </div>
                        )}

                        {result && (
                            <div
                                style={{
                                    marginTop: 16,
                                    background: "rgba(16,185,129,0.06)",
                                    border: "1px solid rgba(16,185,129,0.2)",
                                    borderRadius: 12,
                                    padding: 20,
                                }}
                            >
                                <div
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        flexWrap: "wrap",
                                        gap: 8,
                                        marginBottom: 14,
                                    }}
                                >
                                    <p style={{ color: "var(--success)", fontWeight: 700, fontSize: "clamp(14px, 1.2vw, 18px)", margin: 0 }}>
                                        ✅ Brain Response
                                    </p>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                        <span style={badgeStyle("#10b981")}>
                                            ERC-8004 #{result.agent?.tokenId}
                                        </span>
                                        <span style={badgeStyle("var(--primary)")}>{result.agent?.network}</span>
                                    </div>
                                </div>

                                {/* Agent identity strip */}
                                <div
                                    style={{
                                        display: "grid",
                                        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                                        gap: 12,
                                        marginBottom: 16,
                                    }}
                                >
                                    {[
                                        { label: "Agent Address", value: result.agent?.address },
                                        { label: "Standard", value: result.agent?.standard },
                                        { label: "Session", value: result.sessionId },
                                    ].map((row) => (
                                        <div key={row.label} style={{ background: "var(--surface-secondary)", borderRadius: 10, padding: 12 }}>
                                            <p style={{ fontSize: 9, color: "var(--text-secondary)", textTransform: "uppercase" as const, letterSpacing: 1, margin: "0 0 4px" }}>
                                                {row.label}
                                            </p>
                                            <p style={{ fontSize: 12, color: "var(--primary)", fontFamily: "monospace", margin: 0, wordBreak: "break-all" as const }}>
                                                {row.value || "—"}
                                            </p>
                                        </div>
                                    ))}
                                </div>

                                {/* Final text summary from the brain */}
                                <div
                                    style={{
                                        background: "var(--surface-secondary)",
                                        borderRadius: 10,
                                        padding: 16,
                                        fontSize: "clamp(13px, 1vw, 15px)",
                                        lineHeight: 1.7,
                                        color: "var(--text)",
                                        whiteSpace: "pre-wrap" as const,
                                    }}
                                >
                                    {result.response}
                                </div>

                                {/* Clean ArcScan explorer links (if present) without showing raw tool traces/JSON */}
                                {result.results && result.results.some((r) => r.result?.explorerUrl) && (
                                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                                        {result.results
                                            .filter((r) => r.result?.explorerUrl)
                                            .map((r, i) => (
                                                <a
                                                    key={i}
                                                    href={r.result.explorerUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    style={{
                                                        display: "inline-block",
                                                        fontSize: 13,
                                                        fontWeight: 600,
                                                        color: "var(--primary)",
                                                    }}
                                                >
                                                    View transaction on ArcScan →
                                                </a>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}