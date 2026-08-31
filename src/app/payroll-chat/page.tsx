"use client";

// consumer-app/src/app/payroll-chat/page.tsx
// Chat-style payroll interface inside Flow, inspired by Lumma Agent
// Payroll's UX. Parses natural language with payrollChatParser.ts and
// executes against FlareHQ's EXISTING /api/payroll/run and
// /api/payments/scheduled routes — no new backend primitives.

import React, { useState, useRef, useEffect } from "react";
import { parsePayrollCommand, EXAMPLE_COMMANDS, FREQUENCY_TO_DAYS, Frequency, ParsedIntent } from "@/lib/payrollChatParser";

const ARCFLARE_BASE = process.env.NEXT_PUBLIC_ARCFLARE_API_BASE || "https://flarehq.xyz";
const ARCFLARE_API_KEY = process.env.NEXT_PUBLIC_ARCFLARE_API_KEY || "";

interface Contractor {
  name: string;
  address: string;
  amount: number;
  frequency: Frequency;
  /** Exact interval in days — set for "every N weeks/months" phrasings. */
  intervalDays?: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export default function PayrollChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: "Hi! I'm your payroll assistant. Try: \"Add flare 0xAbC123... as a contractor at 2 USDC monthly\"" },
  ]);
  const [input, setInput] = useState("");
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [schedule, setSchedule] = useState<Frequency | null>(null);
  const [scheduleIntervalDays, setScheduleIntervalDays] = useState<number | null>(null);
  const [vaultAddress, setVaultAddress] = useState("");
  const [vaultWalletId, setVaultWalletId] = useState("");
  const [receipts, setReceipts] = useState<any[]>([]);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const addMessage = (role: "user" | "assistant", text: string) => {
    setMessages((prev) => [...prev, { role, text }]);
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    const userText = input.trim();
    addMessage("user", userText);
    setInput("");
    setSending(true);

    // Check for API key early
    if (!ARCFLARE_API_KEY) {
      addMessage("assistant", "⚠️ API key not configured. Add NEXT_PUBLIC_ARCFLARE_API_KEY to your .env.local");
      setSending(false);
      return;
    }

    // ── Primary path: LLM-backed intent parsing (api/merchant/payroll-assistant).
    // Falls back to the local regex parser on any LLM failure/timeout so the
    // currently-working exact-phrase commands keep functioning during outages.
    let intent: ParsedIntent | null = null;
    let llmReply: string | null = null;
    try {
      const res = await fetch("/api/merchant/payroll-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ARCFLARE_API_KEY },
        body: JSON.stringify({ message: userText, contractors, schedule, vaultAddress }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          llmReply = data.reply ?? null;
          intent = data.intent ?? null;
        }
      }
    } catch {
      // LLM unavailable — fall through to the regex parser.
    }

    if (llmReply && !intent) {
      // Pure conversational reply (e.g. "hi") — no state change to apply.
      addMessage("assistant", llmReply);
      setSending(false);
      return;
    }
    if (!intent) {
      intent = parsePayrollCommand(userText);
    }

    try {
      switch (intent.type) {
        case "add_contractor": {
          setContractors((prev) => [...prev, { name: intent.name, address: intent.address, amount: intent.amount, frequency: intent.frequency, intervalDays: intent.intervalDays }]);
          const cadence = intent.intervalDays && intent.intervalDays !== FREQUENCY_TO_DAYS[intent.frequency]
            ? `every ${intent.intervalDays} days`
            : intent.frequency;
          if (!llmReply) addMessage("assistant", `Got it. Added ${intent.name} (${intent.address.slice(0, 10)}...) at ${intent.amount} USDC, paid ${cadence}. They'll be included in your next payroll run.`);
          break;
        }

        case "list_contractors": {
          if (contractors.length === 0) {
            addMessage("assistant", "No contractors added yet.");
          } else {
            const list = contractors.map((c, i) => `${i+1}. ${c.name} (${c.address.slice(0, 10)}...) — ${c.amount} USDC ${c.frequency}`).join("\n");
            addMessage("assistant", `📋 Current contractors:\n${list}`);
          }
          break;
        }

        case "clear_contractors": {
          setContractors([]);
          addMessage("assistant", "🧹 Removed all contractors from the list.");
          break;
        }

        case "check_balance": {
          if (!vaultAddress) {
            addMessage("assistant", "I don't have your vault wallet address yet. Set it in the field above first.");
            break;
          }
          // Real balance — same on-chain lookup the Telegram /balance command
          // uses (getUsdcBalance), served by the payroll-assistant route.
          try {
            const res = await fetch(`/api/merchant/payroll-assistant?vaultAddress=${encodeURIComponent(vaultAddress)}`, {
              headers: { "x-api-key": ARCFLARE_API_KEY },
              signal: AbortSignal.timeout(15000),
            });
            const data = await res.json();
            if (data.success) {
              addMessage("assistant", `💰 Your vault balance: $${Number(data.balance).toFixed(2)} USDC`);
            } else {
              addMessage("assistant", `Couldn't fetch your balance right now: ${data.error}`);
            }
          } catch {
            addMessage("assistant", "Couldn't fetch your balance right now. Try again shortly.");
          }
          break;
        }

        case "remove_contractor": {
          setContractors((prev) => prev.filter((c) => c.name.toLowerCase() !== intent.name.toLowerCase()));
          if (!llmReply) {
            addMessage("assistant", `Removed ${intent.name} from your contractor list (if they were on it).`);
          }
          break;
        }

        case "set_schedule": {
          setSchedule(intent.frequency);
          setScheduleIntervalDays(intent.intervalDays ?? null);
          const cadence = intent.intervalDays && intent.intervalDays !== FREQUENCY_TO_DAYS[intent.frequency]
            ? `every ${intent.intervalDays} days`
            : intent.frequency;
          addMessage("assistant", `Payroll schedule set to run ${cadence}. I'll create a recurring schedule for each contractor when you run payroll.`);
          break;
        }

        case "run_payroll": {
          if (contractors.length === 0) {
            addMessage("assistant", "You haven't added anyone yet. Try: \"Add Manny 0xAbC123... as a contractor at 2 USDC monthly\"");
            break;
          }
          if (!vaultAddress || !vaultWalletId) {
            addMessage("assistant", "I need your vault wallet address and Circle wallet ID before running payroll. Fill those in below first.");
            break;
          }

          addMessage("assistant", `Running payroll for ${contractors.length} contractor(s)... please confirm the amounts below before I proceed.`);
          addMessage("assistant", contractors.map((c) => `• ${c.name}: ${c.amount} USDC`).join("\n"));

          // ── Calls FlareHQ's EXISTING /api/payroll/run route ──────────────────
          const res = await fetch(`${ARCFLARE_BASE}/api/payroll/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": ARCFLARE_API_KEY },
            body: JSON.stringify({
              payerSCA: vaultAddress,
              payerWalletId: vaultWalletId,
              recipients: contractors.map((c) => ({ recipientSCA: c.address, amount: c.amount, label: c.name })),
            }),
          });
          const data = await res.json();

          if (!data.success) {
            addMessage("assistant", `❌ Payroll run failed: ${data.error}`);
            break;
          }

          addMessage("assistant", `✅ Payroll complete — ${data.successCount}/${data.recipientCount} payments succeeded, totalling ${data.totalAmount} USDC. Batch ref: ${data.batchRef}`);
          setReceipts((prev) => [...prev, ...data.results]);

          // ── If a schedule was set, also register recurring payments ──────────
          if (schedule) {
            let scheduledCount = 0;
            for (const c of contractors) {
              try {
                const schedRes = await fetch(`${ARCFLARE_BASE}/api/payments/scheduled`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-api-key": ARCFLARE_API_KEY },
                  body: JSON.stringify({
                    payerSCA: vaultAddress,
                    receiverSCA: c.address,
                    amount: c.amount,
                    intervalDays: c.intervalDays ?? scheduleIntervalDays ?? FREQUENCY_TO_DAYS[schedule],
                    description: `${c.name} — ${c.intervalDays ? `every ${c.intervalDays} days` : schedule} payroll`,
                    startImmediately: false,
                  }),
                });
                if (schedRes.ok) scheduledCount++;
              } catch (e) { /* ignore individual errors */ }
            }
            if (scheduledCount > 0) {
              addMessage("assistant", `Also registered recurring ${schedule} payments for ${scheduledCount} contractor(s) — they'll run automatically going forward.`);
            }
          }
          break;
        }

        case "show_receipts": {
          if (receipts.length === 0) {
            addMessage("assistant", "No payroll receipts yet. Run payroll first.");
            break;
          }
          const summary = receipts
            .map((r) => `• ${r.label || r.recipientSCA.slice(0, 10)}: ${r.status === "SUCCESS" ? `✅ ${r.amount} USDC — ${r.txHash?.slice(0, 12)}...` : "❌ Failed"}`)
            .join("\n");
          addMessage("assistant", `Here are your receipts:\n${summary}`);
          break;
        }

        case "unrecognized": {
          addMessage(
            "assistant",
            `I didn't quite catch that. Try one of these:\n${EXAMPLE_COMMANDS.map((e) => `• ${e}`).join("\n")}`
          );
          break;
        }
      }
    } catch (e: any) {
      addMessage("assistant", `Something went wrong: ${e.message}`);
    } finally {
      setSending(false);
    }
  };

  // ── Styles ──────────────────────────────────────────────────────────────
  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: "#FBF8F3",
    color: "#1C1B19",
    fontFamily: "'Inter', system-ui, sans-serif",
    maxWidth: 560,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
  };

  const headerStyle: React.CSSProperties = {
    padding: "20px 24px",
    borderBottom: "1px solid #E5DDC9",
  };

  const titleStyle: React.CSSProperties = {
    fontFamily: "'Fraunces', serif",
    fontSize: 20,
    fontWeight: 600,
    margin: 0,
  };

  const subStyle: React.CSSProperties = {
    fontSize: 12,
    color: "#8A8275",
    margin: "4px 0 0",
  };

  const setupBoxStyle: React.CSSProperties = {
    padding: "14px 24px",
    background: "#FFFFFF",
    borderBottom: "1px solid #E5DDC9",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  };

  const setupInputStyle: React.CSSProperties = {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #E5DDC9",
    fontSize: 13,
    fontFamily: "monospace",
    outline: "none",
  };

  const chatAreaStyle: React.CSSProperties = {
    flex: 1,
    padding: "20px 24px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 14,
    minHeight: 360,
    maxHeight: 480,
  };

  // Bubble style helper – returns a style object based on role
  const bubbleStyle = (role: "user" | "assistant"): React.CSSProperties => ({
    maxWidth: "85%",
    padding: "12px 16px",
    borderRadius: 16,
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "#1C1B19" : "#FFFFFF",
    color: role === "user" ? "#FBF8F3" : "#1C1B19",
    border: role === "assistant" ? "1px solid #E5DDC9" : "none",
  });

  const inputRowStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    padding: "16px 24px",
    borderTop: "1px solid #E5DDC9",
    background: "#FFFFFF",
  };

  const chatInputStyle: React.CSSProperties = {
    flex: 1,
    padding: "12px 16px",
    borderRadius: 12,
    border: "1px solid #E5DDC9",
    fontSize: 14,
    outline: "none",
    fontFamily: "inherit",
  };

  const sendBtnStyle: React.CSSProperties = {
    padding: "12px 20px",
    borderRadius: 12,
    border: "none",
    background: "#5C7A5C",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  };

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Payroll Assistant</h1>
        <p style={subStyle}>Chat your payroll — powered by FlareHQ's payroll & scheduled payments</p>
      </header>

      <div style={setupBoxStyle}>
        <input
          style={setupInputStyle}
          placeholder="Your vault wallet address (0x...)"
          value={vaultAddress}
          onChange={(e) => setVaultAddress(e.target.value)}
        />
        <input
          style={setupInputStyle}
          placeholder="Circle wallet ID for the vault"
          value={vaultWalletId}
          onChange={(e) => setVaultWalletId(e.target.value)}
        />
      </div>

      <div style={chatAreaStyle}>
        {messages.map((m, i) => (
          <div key={i} style={bubbleStyle(m.role)}>
            {m.text}
          </div>
        ))}
        <div ref={scrollRef} />
      </div>

      <div style={inputRowStyle}>
        <input
          style={chatInputStyle}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !sending) handleSend();
          }}
          placeholder="Type a payroll command..."
          disabled={sending}
        />
        <button style={sendBtnStyle} onClick={handleSend} disabled={sending}>
          {sending ? "..." : "Send"}
        </button>
      </div>
    </main>
  );
}