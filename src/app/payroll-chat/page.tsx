"use client";

// src/app/payroll-chat/page.tsx
// Chat-style payroll interface. The page DETECTS who opened it:
//   - consumer (Flow session cookie)  -> rendered inside Flow's shell
//     (same theme/header/bottom-nav as /consumer), vault = the session
//     wallet, payroll executes via Flow's send path (initialize + settle)
//     per contractor, recurring via /api/payments/scheduled.
//   - merchant (merchant_token cookie) -> merchant-styled shell, vault =
//     the merchant's own wallet, payroll executes via /api/payroll/run
//     (the server resolves the merchant's signing wallet).
//   - anonymous                        -> sign-in prompt.
//
// Natural language: PRIMARY path is the LLM route
// (/api/merchant/payroll-assistant, merchant OR consumer auth). The regex
// parser in payrollChatParser.ts stays as the offline fallback.

import React, { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { parsePayrollCommand, EXAMPLE_COMMANDS, FREQUENCY_TO_DAYS, Frequency, ParsedIntent } from "@/lib/payrollChatParser";
import { friendlyWalletError } from "@/lib/wallet/walletErrors";

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

interface Receipt {
  label: string;
  amount: number;
  status: string;
  txHash?: string;
  explorerUrl?: string;
}

type Identity =
  | { kind: "consumer"; walletAddress: string }
  | { kind: "merchant"; walletAddress: string | null; businessName: string }
  | { kind: "none" }
  | { kind: "checking" };

const NAV_ITEMS: { view: string; label: string; icon: string }[] = [
  { view: "home", label: "Home", icon: "🏠" },
  { view: "send", label: "Send", icon: "💸" },
  { view: "save", label: "Save", icon: "🐷" },
  { view: "request", label: "Request", icon: "📥" },
  { view: "crosschain", label: "Bridge", icon: "🌉" },
];

// ── Flow look (same tokens as /consumer) ──────────────────────────────────
const FONT_IMPORT = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');
  .flow-app {
    --flow-bg: #FFFFFF;
    --flow-text: #1C1B19;
    --flow-text-muted: #5C5850;
    --flow-text-faint: #8a7560;
    --flow-surface: #FBF8F3;
    --flow-surface-2: #EDE6D8;
    --flow-border: #E5DDC9;
  }
  .flow-app[data-theme="dark"] {
    --flow-bg: #0e0b08;
    --flow-text: #f0ece6;
    --flow-text-muted: #a89985;
    --flow-text-faint: #8a7560;
    --flow-surface: #1a1410;
    --flow-surface-2: #241c14;
    --flow-border: #2d2015;
  }
  @media (min-width: 720px) {
    .flow-app { max-width: 720px !important; padding: 0 24px !important; }
  }
  @media (min-width: 1080px) {
    .flow-app { max-width: 1040px !important; padding: 0 40px !important; }
  }
`;

export default function PayrollChatPage() {
  const router = useRouter();
  const [identity, setIdentity] = useState<Identity>({ kind: "checking" });
  const [darkMode, setDarkMode] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: "Hi! I'm your payroll assistant. Try: \"Add flare 0xAbC123... as a contractor at 2 USDC monthly\" — or just say hi." },
  ]);
  const [input, setInput] = useState("");
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [schedule, setSchedule] = useState<Frequency | null>(null);
  const [scheduleIntervalDays, setScheduleIntervalDays] = useState<number | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("flow-theme");
    if (saved === "dark") setDarkMode(true);
  }, []);
  useEffect(() => {
    localStorage.setItem("flow-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Who is opening this page? ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Consumer session first (Flow users land here from the bottom nav).
      try {
        const res = await fetch("/api/consumer/session");
        const data = await res.json();
        if (!cancelled && data.success && data.account?.walletAddress) {
          setIdentity({ kind: "consumer", walletAddress: data.account.walletAddress });
          return;
        }
      } catch { /* fall through */ }
      // Merchant dashboard session.
      try {
        const res = await fetch("/api/merchant/me");
        const data = await res.json();
        if (!cancelled && data.success && data.merchant) {
          setIdentity({ kind: "merchant", walletAddress: data.merchant.walletAddress || null, businessName: data.merchant.businessName });
          return;
        }
      } catch { /* fall through */ }
      if (!cancelled) setIdentity({ kind: "none" });
    })();
    return () => { cancelled = true; };
  }, []);

  const addMessage = (role: "user" | "assistant", text: string) => {
    setMessages((prev) => [...prev, { role, text }]);
  };

  // ── Vault: whose wallet payroll pays from ───────────────────────────────
  const vaultAddress =
    identity.kind === "consumer" ? identity.walletAddress : identity.kind === "merchant" ? identity.walletAddress || "" : "";

  // ── Payroll execution ────────────────────────────────────────────────────
  const runConsumerPayroll = async (): Promise<{ ok: boolean; results: Receipt[]; summary: string }> => {
    // Flow's own send path, once per contractor: initialize → settle. This
    // is the ONLY money-moving path a consumer session can drive, and it
    // debits the caller's own Circle-custodied wallet via /settle Path B.
    const results: Receipt[] = [];
    let okCount = 0;
    let total = 0;
    for (const c of contractors) {
      try {
        const initRes = await fetch("/api/payments/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: c.amount,
            currency: "USDC",
            merchant: c.address,
            payoutAddress: c.address,
            direction: "send",
          }),
        });
        const initData = await initRes.json();
        if (!initData.success) throw new Error(initData.error || "Could not start payment.");

        const settleRes = await fetch("/api/payments/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: initData.reference }),
        });
        const settleData = await settleRes.json();
        if (!settleData.success) throw new Error(settleData.error || "Could not complete payment.");

        okCount++;
        total += c.amount;
        results.push({ label: c.name, amount: c.amount, status: "SUCCESS", txHash: settleData.arcTxHash, explorerUrl: settleData.explorerUrl });
      } catch (e: any) {
        results.push({ label: c.name, amount: c.amount, status: `FAILED — ${e.message}` });
      }
    }
    return {
      ok: okCount === contractors.length,
      results,
      summary: `✅ Payroll complete — ${okCount}/${contractors.length} payments succeeded, totalling ${total.toFixed(2)} USDC.`,
    };
  };

  const runMerchantPayroll = async (): Promise<{ ok: boolean; results: Receipt[]; summary: string }> => {
    // The merchant batch route resolves the paying wallet server-side from
    // the merchant's own credentials — payerSCA in the body is ignored.
    const res = await fetch("/api/payroll/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipients: contractors.map((c) => ({ recipientSCA: c.address, amount: c.amount, label: c.name })),
        description: "Payroll via chat",
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Payroll run failed.");
    const results: Receipt[] = (data.results || []).map((r: any) => ({
      label: r.label || (r.recipientSCA || "").slice(0, 10),
      amount: Number(r.amount) || 0,
      status: r.status === "SUCCESS" ? "SUCCESS" : `FAILED — ${r.error || r.status}`,
      txHash: r.txHash,
    }));
    return {
      ok: data.status !== "FAILED",
      results,
      summary: `✅ Payroll complete — ${data.successCount}/${data.recipientCount} payments succeeded, totalling ${data.totalAmount} USDC. Batch ref: ${data.batchRef}`,
    };
  };

  const registerSchedules = async (payerSCA: string): Promise<number> => {
    let scheduledCount = 0;
    for (const c of contractors) {
      try {
        const schedRes = await fetch("/api/payments/scheduled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payerSCA,
            receiverSCA: c.address,
            amount: c.amount,
            intervalDays: c.intervalDays ?? scheduleIntervalDays ?? FREQUENCY_TO_DAYS[schedule!],
            description: `${c.name} — ${c.intervalDays ? `every ${c.intervalDays} days` : schedule} payroll`,
            startImmediately: false,
          }),
        });
        if (schedRes.ok) scheduledCount++;
      } catch { /* ignore individual errors */ }
    }
    return scheduledCount;
  };

  // ── Chat send ────────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!input.trim()) return;
    const userText = input.trim();
    addMessage("user", userText);
    setInput("");
    setSending(true);

    // Primary path: LLM-backed intent parsing (merchant OR consumer auth).
    // Falls back to the local regex parser on any LLM failure so the
    // exact-phrase commands keep working during outages. Recent chat history
    // travels along so multi-turn flows (partial add, then the missing
    // cadence) complete instead of restarting.
    let intent: ParsedIntent | null = null;
    let llmReply: string | null = null;
    try {
      const res = await fetch("/api/merchant/payroll-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userText,
          contractors,
          schedule,
          vaultAddress,
          history: messages.slice(-12).map((m) => ({ role: m.role, text: m.text })),
        }),
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
            const list = contractors.map((c, i) => `${i + 1}. ${c.name} (${c.address.slice(0, 10)}...) — ${c.amount} USDC ${c.frequency}`).join("\n");
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
          // Real balance — same on-chain lookup the Telegram /balance command
          // uses (getUsdcBalance), served by the payroll-assistant route.
          try {
            const res = await fetch(`/api/merchant/payroll-assistant?vaultAddress=${encodeURIComponent(vaultAddress)}`, {
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
          if (identity.kind === "none") {
            addMessage("assistant", "Please connect a wallet (Flow) or log in to your merchant dashboard first, then come back.");
            break;
          }
          if (contractors.length === 0) {
            addMessage("assistant", "You haven't added anyone yet. Try: \"Add Manny 0xAbC123... as a contractor at 2 USDC monthly\"");
            break;
          }
          if (identity.kind === "merchant" && !vaultAddress) {
            addMessage("assistant", "Your merchant account has no wallet address set. Add one in your merchant dashboard first (Settings → Wallet) so I know which vault pays.");
            break;
          }

          addMessage("assistant", `Running payroll for ${contractors.length} contractor(s) from ${vaultAddress.slice(0, 10)}...`);
          addMessage("assistant", contractors.map((c) => `• ${c.name}: ${c.amount} USDC`).join("\n"));

          const run = identity.kind === "consumer" ? await runConsumerPayroll() : await runMerchantPayroll();
          addMessage("assistant", run.summary);
          setReceipts((prev) => [...run.results, ...prev]);

          // If a schedule was set, also register recurring payments.
          if (schedule && vaultAddress) {
            const scheduledCount = await registerSchedules(vaultAddress);
            if (scheduledCount > 0) {
              addMessage("assistant", `Also registered recurring ${schedule} payments for ${scheduledCount} contractor(s) — they'll run automatically going forward.`);
            } else {
              addMessage("assistant", "Heads up: I couldn't register the recurring schedules (the paying wallet may not be Circle-custodied). The one-off payments above still went through.");
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
            .slice(0, 10)
            .map((r) => `• ${r.label}: ${r.status === "SUCCESS" ? `✅ ${r.amount} USDC${r.txHash ? ` — ${r.txHash.slice(0, 12)}...` : ""}` : `❌ ${r.status}`}`)
            .join("\n");
          addMessage("assistant", `Here are your most recent receipts:\n${summary}`);
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
      addMessage("assistant", friendlyWalletError(e));
    } finally {
      setSending(false);
    }
  };

  // ── Shells ───────────────────────────────────────────────────────────────
  if (identity.kind === "checking") {
    return (
      <main className="flareHQ flow-app" style={styles.page} data-theme={darkMode ? "dark" : "light"}>
        <style>{FONT_IMPORT}</style>
        <p style={{ ...styles.eyebrow, textAlign: "center" }}>Loading...</p>
      </main>
    );
  }

  if (identity.kind === "none") {
    return (
      <main className="flareHQ flow-app" style={styles.page} data-theme={darkMode ? "light" : "light"}>
        <style>{FONT_IMPORT}</style>
        <div style={styles.flowCard}>
          <h1 style={styles.title}>Payroll Assistant</h1>
          <p style={styles.sub}>Chat your payroll — powered by FlareHQ's payroll & scheduled payments</p>
          <p style={{ fontSize: 14, color: "var(--flow-text-muted)", lineHeight: 1.6 }}>
            Connect a Flow wallet to run payroll from your own wallet, or log in to your
            merchant dashboard to pay a team. This page adapts to whoever opens it.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={styles.primaryButton} onClick={() => router.push("/consumer")}>Open Flow</button>
            <button style={styles.secondaryButton} onClick={() => router.push("/merchant/login")}>Merchant login</button>
          </div>
        </div>
      </main>
    );
  }

  // Merchant shell — matches the merchant dashboard (dark) tone.
  if (identity.kind === "merchant") {
    return (
      <main style={{ minHeight: "100vh", background: "#0e0b08", color: "#f0ece6", display: "flex", flexDirection: "column", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <header style={{ padding: "18px 20px", borderBottom: "1px solid #2d2015", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Payroll Assistant</h1>
            <p style={{ fontSize: 12, color: "#6b5a45", margin: "2px 0 0 0" }}>
              {identity.businessName} · vault {vaultAddress ? `${vaultAddress.slice(0, 8)}...${vaultAddress.slice(-6)}` : "not set"}
            </p>
          </div>
          <button onClick={() => router.push("/merchant/dashboard")} style={{ background: "#1a1410", border: "1px solid #2d2015", borderRadius: 8, padding: "6px 12px", color: "#c8975a", fontSize: 12, cursor: "pointer" }}>
            ← Dashboard
          </button>
        </header>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 14, maxHeight: "60vh" }}>
          {messages.map((m, i) => (
            <div key={i} style={merchantBubble(m.role)}>{m.text}</div>
          ))}
          <div ref={scrollRef} />
        </div>
        <div style={{ padding: "16px 20px", borderTop: "1px solid #2d2015", display: "flex", gap: 10 }}>
          <input
            style={{ flex: 1, background: "#1a1410", border: "1px solid #2d2015", borderRadius: 12, padding: "12px 14px", color: "#f0ece6", fontSize: 14, outline: "none" }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !sending) handleSend(); }}
            placeholder="Type a payroll command..."
            disabled={sending}
          />
          <button
            style={{ padding: "0 20px", borderRadius: 12, border: "none", background: sending ? "#6b5a45" : "#c8975a", color: "#0e0b08", fontWeight: 700, fontSize: 14, cursor: "pointer" }}
            onClick={handleSend}
            disabled={sending}
          >
            {sending ? "..." : "Send"}
          </button>
        </div>
      </main>
    );
  }

  // Consumer shell — the Flow look, identical chrome to /consumer.
  return (
    <main className="flareHQ flow-app" style={styles.page} data-theme={darkMode ? "dark" : "light"}>
      <style>{FONT_IMPORT}</style>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <Image src="/arcflare-logo.png" alt="ArcFlare" width={32} height={32} style={{ borderRadius: 6, flexShrink: 0 }} />
          <span style={styles.appName}>FlareHQ Flow</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button style={styles.themeToggle} onClick={() => setDarkMode((d) => !d)} title={darkMode ? "Switch to light mode" : "Switch to dark mode"}>
            {darkMode ? "☀️" : "🌙"}
          </button>
          <span style={styles.walletPill} title={vaultAddress}>
            {vaultAddress.slice(0, 6)}...{vaultAddress.slice(-4)}
          </span>
        </div>
      </header>

      <div style={styles.contentArea}>
        <section style={styles.flowCard}>
          <h2 style={styles.flowTitle}>Payroll Assistant</h2>
          <p style={{ fontSize: 13, color: "var(--flow-text-muted)", margin: "0 0 16px" }}>
            Chat your payroll — paying from your Flow wallet. Ask me anything, or try a command.
          </p>
          <div style={styles.chatArea}>
            {messages.map((m, i) => (
              <div key={i} style={bubble(m.role)}>{m.text}</div>
            ))}
            <div ref={scrollRef} />
          </div>
          <div style={styles.inputRow}>
            <input
              style={styles.chatInput}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !sending) handleSend(); }}
              placeholder="Type a payroll command..."
              disabled={sending}
            />
            <button style={styles.sendButton} onClick={handleSend} disabled={sending}>
              {sending ? "..." : "Send"}
            </button>
          </div>
        </section>
      </div>

      {/* ── Bottom Nav (same items as /consumer; Payroll active) ── */}
      <nav style={styles.bottomNav}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            style={styles.navItem}
            onClick={() => router.push(`/consumer?view=${item.view}`)}
          >
            <span style={styles.navIcon}>{item.icon}</span>
            <span style={styles.navLabel}>{item.label}</span>
          </button>
        ))}
        <button style={styles.navItemActive}>
          <span style={styles.navItemActiveIcon}>💬</span>
          <span style={styles.navLabel}>Payroll</span>
        </button>
      </nav>
    </main>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
function merchantBubble(role: "user" | "assistant"): React.CSSProperties {
  return {
    maxWidth: "85%",
    padding: "12px 16px",
    borderRadius: 16,
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "#c8975a" : "#1a1410",
    color: role === "user" ? "#0e0b08" : "#f0ece6",
    border: role === "assistant" ? "1px solid #2d2015" : "none",
  };
}

function bubble(role: "user" | "assistant"): React.CSSProperties {
  return {
    maxWidth: "85%",
    padding: "12px 16px",
    borderRadius: 16,
    fontSize: 14,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "#1C1B19" : "var(--flow-surface)",
    color: role === "user" ? "#FBF8F3" : "var(--flow-text)",
    border: role === "assistant" ? "1px solid var(--flow-border)" : "none",
  };
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "var(--flow-bg)",
    color: "var(--flow-text)",
    fontFamily: "'Inter', system-ui, sans-serif",
    maxWidth: 560,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    padding: "0 16px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 0 8px",
    flexWrap: "wrap",
    gap: 8,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  appName: {
    fontFamily: "'Fraunces', serif",
    fontSize: 20,
    fontWeight: 600,
    letterSpacing: -0.3,
    color: "var(--flow-text)",
  },
  themeToggle: {
    fontSize: 16,
    background: "var(--flow-surface-2)",
    border: "none",
    borderRadius: "50%",
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  walletPill: {
    fontSize: "clamp(10px, 1.2vw, 12px)",
    fontFamily: "monospace",
    color: "#5C7A5C",
    background: "var(--flow-surface-2)",
    padding: "6px 12px",
    borderRadius: 20,
    border: "none",
    whiteSpace: "nowrap",
  },
  contentArea: { flex: 1, padding: "0 0 80px", overflowY: "auto" },
  flowCard: { paddingTop: 16, display: "flex", flexDirection: "column" },
  flowTitle: { fontFamily: "'Fraunces', serif", fontSize: "clamp(22px, 4vw, 26px)", fontWeight: 500, margin: "0 0 8px" },
  title: { fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 600, margin: "0 0 4px" },
  sub: { fontSize: 13, color: "var(--flow-text-muted)", margin: "0 0 16px" },
  eyebrow: { fontSize: 13, color: "var(--flow-text-muted)", margin: "24px 0" },
  chatArea: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    minHeight: 320,
    maxHeight: "52vh",
    overflowY: "auto",
    padding: "4px 0 12px",
  },
  inputRow: {
    display: "flex",
    gap: 8,
    paddingTop: 12,
    borderTop: "1px solid var(--flow-border)",
  },
  chatInput: {
    flex: 1,
    padding: "12px 16px",
    borderRadius: 12,
    border: "1px solid var(--flow-border)",
    background: "var(--flow-surface)",
    color: "var(--flow-text)",
    fontSize: 14,
    outline: "none",
    fontFamily: "inherit",
  },
  sendButton: {
    padding: "12px 20px",
    borderRadius: 12,
    border: "none",
    background: "#5C7A5C",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  primaryButton: {
    padding: "14px 24px",
    borderRadius: 14,
    border: "none",
    background: "#1C1B19",
    color: "#FBF8F3",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  secondaryButton: {
    padding: "14px 24px",
    borderRadius: 14,
    border: "1px solid var(--flow-text)",
    background: "transparent",
    color: "var(--flow-text)",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  bottomNav: {
    position: "sticky",
    bottom: 0,
    display: "flex",
    justifyContent: "space-around",
    background: "var(--flow-surface)",
    borderTop: "1px solid var(--flow-border)",
    padding: "8px 4px 12px",
    marginTop: "auto",
  },
  navItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--flow-text-faint)",
    padding: "4px 8px",
  },
  navItemActive: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--flow-text)",
    padding: "4px 8px",
  },
  navIcon: {
    fontSize: "clamp(18px, 1.8vw, 21px)",
    lineHeight: 1.2,
    padding: "2px 10px",
    borderRadius: 12,
    background: "transparent",
  },
  navItemActiveIcon: {
    fontSize: "clamp(18px, 1.8vw, 21px)",
    lineHeight: 1.2,
    padding: "2px 10px",
    borderRadius: 12,
    background: "rgba(92, 122, 92, 0.16)",
  },
  navLabel: { fontSize: "clamp(9px, 0.8vw, 11px)", fontWeight: 600 },
};
