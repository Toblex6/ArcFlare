"use client";

import React, { useState, useRef, useEffect } from "react";
import DashboardSidebar from "@/src/components/DashboardSidebar";

const EXAMPLE_PROMPTS = [
    "How much revenue have I made this month?",
    "Set a budget of 500 USDC for marketing",
    "Remind me to pay rent on the 1st of next month",
    "What bills do I have coming up?",
];

interface ToolResult {
    tool: string;
    result: any;
}

interface ChatMessage {
    role: "user" | "assistant";
    text: string;
    toolsUsed?: string[];
    results?: ToolResult[];
}

const styles = {
    card: {
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 24,
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

const badgeStyle = (color: string): React.CSSProperties => ({
    fontSize: 10,
    padding: "3px 10px",
    borderRadius: 12,
    background: `${color}15`,
    color,
    border: `1px solid ${color}40`,
    fontWeight: 700,
});

const bubbleStyle = (role: "user" | "assistant"): React.CSSProperties => ({
    maxWidth: "80%",
    padding: "12px 16px",
    borderRadius: 16,
    fontSize: 14,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap" as const,
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "var(--primary)" : "var(--surface-secondary)",
    color: role === "user" ? "#0e0b08" : "var(--text)",
    border: role === "assistant" ? "1px solid var(--border)" : "none",
});

export default function MerchantAssistantPage() {
    const [messages, setMessages] = useState<ChatMessage[]>([
        { role: "assistant", text: "Hi! I'm your Money Assistant. I can summarize your revenue, help you set budgets, and track bill reminders. Try asking me something." },
    ]);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const handleSend = async (overrideText?: string) => {
        const text = (overrideText ?? input).trim();
        if (!text || sending) return;

        setMessages((prev) => [...prev, { role: "user", text }]);
        setInput("");
        setSending(true);
        setError(null);

        try {
            const res = await fetch("/api/merchant/assistant", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: text }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || "Assistant call failed");

            setMessages((prev) => [
                ...prev,
                { role: "assistant", text: data.response, toolsUsed: data.toolsUsed, results: data.results },
            ]);
        } catch (e: any) {
            setError(e.message);
            setMessages((prev) => [...prev, { role: "assistant", text: `Something went wrong: ${e.message}` }]);
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="light" style={{ display: "flex", minHeight: "100vh", background: "var(--background)" }}>
            <DashboardSidebar active="Money Assistant" />
            <main style={{ flex: 1, minWidth: 0, padding: "24px", overflowX: "hidden" }}>
                <div style={{ maxWidth: 760, margin: "0 auto" }}>
                    <div style={{ marginBottom: 20 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
                            <h1 style={{ fontSize: "clamp(20px, 4vw, 28px)", fontWeight: 700, margin: 0 }}>
                                Money Assistant
                            </h1>
                            <span style={badgeStyle("var(--primary)")}>Free — no per-call cost</span>
                        </div>
                        <p style={{ color: "var(--text-secondary)", fontSize: "clamp(12px, 1.2vw, 14px)", margin: 0 }}>
                            Your business finance helper — revenue summaries, budgets, and bill reminders in plain language.
                        </p>
                    </div>

                    <div style={{ ...styles.card, display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
                        {/* Chat area */}
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 12,
                                padding: 20,
                                minHeight: 380,
                                maxHeight: 480,
                                overflowY: "auto",
                            }}
                        >
                            {messages.map((m, i) => (
                                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                                    <div style={bubbleStyle(m.role)}>{m.text}</div>
                                </div>
                            ))}
                            <div ref={scrollRef} />
                        </div>

                        {/* Example prompts */}
                        <div style={{ padding: "0 20px 14px", display: "flex", flexWrap: "wrap", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
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
                                        cursor: sending ? "default" : "pointer",
                                        opacity: sending ? 0.5 : 1,
                                    }}
                                    onClick={() => !sending && handleSend(p)}
                                >
                                    {p}
                                </span>
                            ))}
                        </div>

                        {/* Input row */}
                        <div style={{ display: "flex", gap: 8, padding: 16, borderTop: "1px solid var(--border)", background: "var(--surface-secondary)" }}>
                            <input
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && !sending) handleSend();
                                }}
                                placeholder="Ask about your revenue, budgets, or reminders..."
                                disabled={sending}
                                style={{
                                    flex: 1,
                                    padding: "12px 16px",
                                    borderRadius: 12,
                                    border: "1px solid var(--border)",
                                    background: "var(--surface)",
                                    color: "var(--text)",
                                    fontSize: 14,
                                    outline: "none",
                                    fontFamily: "inherit",
                                }}
                            />
                            <button
                                onClick={() => handleSend()}
                                disabled={sending || !input.trim()}
                                style={{
                                    padding: "12px 20px",
                                    borderRadius: 12,
                                    border: "none",
                                    background: sending || !input.trim() ? "rgba(8,145,178,0.3)" : "var(--primary)",
                                    color: sending || !input.trim() ? "var(--text-secondary)" : "#0e0b08",
                                    fontSize: 14,
                                    fontWeight: 700,
                                    cursor: sending || !input.trim() ? "not-allowed" : "pointer",
                                }}
                            >
                                {sending ? "..." : "Send"}
                            </button>
                        </div>
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
                </div>
            </main>
        </div>
    );
}