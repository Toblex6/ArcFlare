"use client";

// consumer-app/src/app/page.tsx
// ArcFlare Consumer App ("Flow") — v2: adds persistent bottom nav + wallet
// onboarding screen, closing the gap flagged earlier. Still single-page
// with view-switching, per the agreed approach — no route changes.

import React, { useState, useEffect } from "react";
import Image from "next/image";  // 👈 added for logo

const API_BASE = process.env.NEXT_PUBLIC_ARCFLARE_API_BASE || "https://arcflare-gateway.onrender.com";
const API_KEY = process.env.NEXT_PUBLIC_ARCFLARE_API_KEY || "";
const WALLET_STORAGE_KEY = "flow_wallet_address";

type View = "onboarding" | "home" | "send" | "save" | "request";

interface ActionResult {
  success: boolean;
  message?: string;
  error?: string;
  reference?: string;
  txHash?: string;
  explorerUrl?: string;
}

const NAV_ITEMS: { id: View; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "○" },
  { id: "send", label: "Send", icon: "→" },
  { id: "save", label: "Save", icon: "◷" },
  { id: "request", label: "Request", icon: "←" },
];

export default function ConsumerApp() {
  const [view, setView] = useState<View>("home");
  const [walletAddress, setWalletAddress] = useState("");
  const [onboardingInput, setOnboardingInput] = useState("");
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [creatingWallet, setCreatingWallet] = useState(false);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("7");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  // ── Check for existing wallet on load ──────────────────────────────────────
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage?.getItem(WALLET_STORAGE_KEY) : null;
    if (saved) {
      setWalletAddress(saved);
      setView("home");
    } else {
      setView("onboarding");
    }
  }, []);

  const saveWallet = (address: string) => {
    setWalletAddress(address);
    try {
      window.localStorage?.setItem(WALLET_STORAGE_KEY, address);
    } catch {}
    setView("home");
  };

  // ── Onboarding: paste existing wallet ──────────────────────────────────────
  const connectExisting = () => {
    const trimmed = onboardingInput.trim();
    if (!trimmed.startsWith("0x") || trimmed.length < 10) {
      setOnboardingError("That doesn't look like a wallet address. It should start with 0x.");
      return;
    }
    setOnboardingError(null);
    saveWallet(trimmed);
  };

  // ── Onboarding: create a new wallet via ArcFlare's agent deploy route ──────
  const createNewWallet = async () => {
    setCreatingWallet(true);
    setOnboardingError(null);
    try {
      const res = await fetch(`${API_BASE}/api/agent/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ agentName: "Flow user wallet" }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not create a wallet right now.");
      saveWallet(data.agent.scaAddress);
    } catch (e: any) {
      setOnboardingError(e.message);
    } finally {
      setCreatingWallet(false);
    }
  };

  const disconnectWallet = () => {
    try {
      window.localStorage?.removeItem(WALLET_STORAGE_KEY);
    } catch {}
    setWalletAddress("");
    setView("onboarding");
  };

  const resetActionState = () => {
    setRecipient("");
    setAmount("");
    setResult(null);
  };

  const goTo = (v: View) => {
    resetActionState();
    setView(v);
  };

  // ── Actions (unchanged logic) ──────────────────────────────────────────────
  const handleSend = async () => {
    setLoading(true);
    setResult(null);
    try {
      const initRes = await fetch(`${API_BASE}/api/payments/initialize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ amount, currency: "USDC", agentSCA: walletAddress || undefined, merchant: recipient }),
      });
      const initData = await initRes.json();
      if (!initData.success) throw new Error(initData.error || "Could not start payment.");

      const settleRes = await fetch(`${API_BASE}/api/payments/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ reference: initData.reference }),
      });
      const settleData = await settleRes.json();
      if (!settleData.success) throw new Error(settleData.error || "Could not complete payment.");

      setResult({ success: true, message: `Sent ${amount} USDC to ${recipient}.`, txHash: settleData.arcTxHash, explorerUrl: settleData.explorerUrl });
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/payments/scheduled`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ payerSCA: walletAddress, receiverSCA: walletAddress, amount, intervalDays: parseInt(frequency), description: "Automatic savings" }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not set up savings.");
      setResult({ success: true, message: `Saving ${amount} USDC every ${frequency} day(s).`, reference: data.scheduledPayment?.reference });
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setLoading(false);
    }
  };

  const handleRequest = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/payments/initialize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ amount, currency: "USDC", merchant: "Payment request" }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not create request.");
      setResult({ success: true, message: "Your payment link is ready to share.", reference: data.checkoutUrl });
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setLoading(false);
    }
  };

  const submitHandlers: Record<string, () => void> = { send: handleSend, save: handleSave, request: handleRequest };

  // ── Render: Onboarding ──────────────────────────────────────────────────────
  if (view === "onboarding") {
    return (
      <main style={S.page}>
        <style>{FONT_IMPORT}</style>
        <div style={S.onboardingWrap}>
          <div style={S.logoMark}>
            <Image
              src="/arcflare-logo.png.png"
              alt="ArcFlare"
              width={32}
              height={32}
              style={{ borderRadius: 6, objectFit: "contain" }}
            />
            <span style={S.logoFlow}>＿╱</span>
            <span style={S.logoText}>Flow</span>
          </div>
          <h1 style={S.onboardingTitle}>Let's get you set up</h1>
          <p style={S.onboardingSub}>You'll need a wallet to send, save, and request money. Takes a few seconds.</p>

          <button style={S.primaryButton} disabled={creatingWallet} onClick={createNewWallet}>
            {creatingWallet ? "Setting things up..." : "Create my wallet"}
          </button>

          <div style={S.orDivider}><span>or</span></div>

          <div style={S.field}>
            <label style={S.label}>I already have a wallet address</label>
            <input style={S.input} value={onboardingInput} onChange={(e) => setOnboardingInput(e.target.value)} placeholder="0x..." />
          </div>
          <button style={S.secondaryButton} onClick={connectExisting}>Use this wallet</button>

          {onboardingError && <p style={S.onboardingError}>{onboardingError}</p>}

          <p style={S.footnote}>Built on Arc · Your money is always yours</p>
        </div>
      </main>
    );
  }

  // ── Render: Home + Action views, with bottom nav ───────────────────────────
  return (
    <main style={S.page}>
      <style>{FONT_IMPORT}</style>

      <header style={S.header}>
        <div style={S.logoMark}>
          <Image
            src="/arcflare-logo.png.png"
            alt="ArcFlare"
            width={32}
            height={32}
            style={{ borderRadius: 6, objectFit: "contain" }}
          />
          <span style={S.logoFlow}>＿╱</span>
          <span style={S.logoText}>Flow</span>
        </div>
        <button style={S.walletPill} onClick={disconnectWallet} title="Tap to switch wallet">
          {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
        </button>
      </header>

      <div style={S.contentArea}>
        {view === "home" && (
          <>
            <section style={S.hero}>
              <p style={S.eyebrow}>Money, simplified</p>
              <h1 style={S.heroTitle}>Your money,<br />moving on its own.</h1>
              <p style={S.heroSub}>Send to anyone. Save without thinking. Get paid in seconds.</p>
            </section>

            <section style={S.actionsGrid}>
              <button style={S.actionCard} onClick={() => goTo("send")}>
                <span style={S.actionIcon}>→</span>
                <span style={S.actionLabel}>Send money</span>
                <span style={S.actionSub}>Pay anyone instantly</span>
              </button>
              <button style={S.actionCard} onClick={() => goTo("save")}>
                <span style={S.actionIcon}>◷</span>
                <span style={S.actionLabel}>Save automatically</span>
                <span style={S.actionSub}>Set money aside on a schedule</span>
              </button>
              <button style={S.actionCard} onClick={() => goTo("request")}>
                <span style={S.actionIcon}>←</span>
                <span style={S.actionLabel}>Request payment</span>
                <span style={S.actionSub}>Get a link to share</span>
              </button>
            </section>

            <p style={S.footnote}>Built on Arc · Settled in USDC · Every transfer is real and onchain</p>
          </>
        )}

        {(view === "send" || view === "save" || view === "request") && (
          <section style={S.flowCard}>
            <h2 style={S.flowTitle}>
              {view === "send" && "Send money"}
              {view === "save" && "Set up automatic saving"}
              {view === "request" && "Request a payment"}
            </h2>

            <div style={S.flowLine}>
              <span style={S.flowDot} />
              <span style={S.flowStroke} />
              <span style={S.flowDot} />
            </div>

            {!result && (
              <div style={S.form}>
                {view === "send" && (
                  <div style={S.field}>
                    <label style={S.label}>Who's this for?</label>
                    <input style={S.input} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Name or wallet address" />
                  </div>
                )}
                {view === "request" && (
                  <div style={S.field}>
                    <label style={S.label}>What's it for? (optional)</label>
                    <input style={S.input} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="e.g. Rent, design work..." />
                  </div>
                )}
                <div style={S.field}>
                  <label style={S.label}>Amount (USDC)</label>
                  <input style={S.input} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </div>
                {view === "save" && (
                  <div style={S.field}>
                    <label style={S.label}>How often?</label>
                    <div style={S.freqRow}>
                      {[{ label: "Daily", val: "1" }, { label: "Weekly", val: "7" }, { label: "Monthly", val: "30" }].map((f) => (
                        <button key={f.val} style={frequency === f.val ? S.freqPillActive : S.freqPill} onClick={() => setFrequency(f.val)}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <button style={S.submitButton} disabled={loading || !amount} onClick={submitHandlers[view]}>
                  {loading ? "Working on it..." : view === "send" ? "Send now" : view === "save" ? "Start saving" : "Create request"}
                </button>
              </div>
            )}

            {result && (
              <div style={result.success ? S.resultSuccess : S.resultError}>
                <p style={S.resultIcon}>{result.success ? "✓" : "!"}</p>
                <p style={S.resultText}>{result.success ? result.message : result.error}</p>
                {result.explorerUrl && <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer" style={S.resultLink}>View transaction</a>}
                {result.reference && view === "request" && <div style={S.linkBox}>{result.reference}</div>}
                <button style={S.doneButton} onClick={() => goTo("home")}>Done</button>
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── Persistent bottom nav ── */}
      <nav style={S.bottomNav}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            style={view === item.id ? S.navItemActive : S.navItem}
            onClick={() => goTo(item.id)}
          >
            <span style={S.navIcon}>{item.icon}</span>
            <span style={S.navLabel}>{item.label}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}

const FONT_IMPORT = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');
`;

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh", background: "#FBF8F3", color: "#1C1B19",
    fontFamily: "'Inter', system-ui, sans-serif", maxWidth: 560, margin: "0 auto",
    display: "flex", flexDirection: "column",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "24px 24px 8px" },
  logoMark: { display: "flex", alignItems: "center", gap: 8 }, // 👈 changed to center-align with image
  logoFlow: { fontFamily: "'Fraunces', serif", fontSize: 20, color: "#E8714A" },
  logoText: { fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 600, letterSpacing: -0.3 },
  walletPill: {
    fontSize: 12, fontFamily: "monospace", color: "#5C7A5C", background: "#EDE6D8",
    padding: "6px 12px", borderRadius: 20, border: "none", cursor: "pointer",
  },
  contentArea: { flex: 1, padding: "0 24px 100px", overflowY: "auto" },
  hero: { padding: "28px 0 24px" },
  eyebrow: { fontSize: 12, color: "#5C7A5C", fontWeight: 600, letterSpacing: 1.5, textTransform: "uppercase", margin: "0 0 14px" },
  heroTitle: { fontFamily: "'Fraunces', serif", fontSize: 34, lineHeight: 1.12, fontWeight: 500, margin: "0 0 16px", letterSpacing: -0.5 },
  heroSub: { fontSize: 16, lineHeight: 1.55, color: "#5C5850", margin: 0, maxWidth: 440 },
  actionsGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 12, margin: "28px 0 32px" },
  actionCard: {
    display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4,
    background: "#FFFFFF", border: "1px solid #E5DDC9", borderRadius: 18,
    padding: "20px 22px", cursor: "pointer", textAlign: "left", width: "100%",
  },
  actionIcon: { fontSize: 20, color: "#E8714A", marginBottom: 6, fontFamily: "'Fraunces', serif" },
  actionLabel: { fontSize: 17, fontWeight: 600 },
  actionSub: { fontSize: 13.5, color: "#8A8275" },
  footnote: { textAlign: "center", fontSize: 12, color: "#A39C8C", margin: "8px 0" },

  flowCard: { paddingTop: 20 },
  flowTitle: { fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 500, margin: "0 0 24px" },
  flowLine: { display: "flex", alignItems: "center", gap: 0, marginBottom: 28 },
  flowDot: { width: 8, height: 8, borderRadius: "50%", background: "#5C7A5C", flexShrink: 0 },
  flowStroke: { flex: 1, height: 2, background: "linear-gradient(90deg, #5C7A5C, #E8714A)", margin: "0 6px" },
  form: { display: "flex", flexDirection: "column", gap: 18 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: "#5C5850" },
  input: {
    padding: "14px 16px", borderRadius: 12, border: "1px solid #E5DDC9", background: "#FFFFFF",
    fontSize: 16, color: "#1C1B19", outline: "none", fontFamily: "inherit", boxSizing: "border-box",
  },
  freqRow: { display: "flex", gap: 8 },
  freqPill: { flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #E5DDC9", background: "#FFFFFF", color: "#5C5850", fontSize: 14, fontWeight: 500, cursor: "pointer" },
  freqPillActive: { flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid #5C7A5C", background: "#5C7A5C", color: "#FFFFFF", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  submitButton: { marginTop: 8, padding: "16px 0", borderRadius: 14, border: "none", background: "#1C1B19", color: "#FBF8F3", fontSize: 16, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  resultSuccess: { textAlign: "center", padding: "32px 16px", background: "#FFFFFF", border: "1px solid #D6E2D6", borderRadius: 18 },
  resultError: { textAlign: "center", padding: "32px 16px", background: "#FFFFFF", border: "1px solid #F0D5C9", borderRadius: 18 },
  resultIcon: { fontSize: 28, margin: "0 0 12px", color: "#5C7A5C" },
  resultText: { fontSize: 15, margin: "0 0 16px", lineHeight: 1.5 },
  resultLink: { fontSize: 13, color: "#E8714A", fontWeight: 600 },
  linkBox: { fontSize: 12, fontFamily: "monospace", background: "#EDE6D8", padding: "10px 14px", borderRadius: 10, wordBreak: "break-all", margin: "0 0 16px" },
  doneButton: { marginTop: 12, padding: "12px 28px", borderRadius: 12, border: "1px solid #1C1B19", background: "transparent", color: "#1C1B19", fontSize: 14, fontWeight: 600, cursor: "pointer" },

  // Onboarding
  onboardingWrap: { padding: "60px 24px", display: "flex", flexDirection: "column", alignItems: "stretch", flex: 1 },
  onboardingTitle: { fontFamily: "'Fraunces', serif", fontSize: 30, fontWeight: 500, margin: "28px 0 10px" },
  onboardingSub: { fontSize: 15, color: "#5C5850", lineHeight: 1.5, margin: "0 0 28px" },
  primaryButton: { padding: "16px 0", borderRadius: 14, border: "none", background: "#1C1B19", color: "#FBF8F3", fontSize: 16, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  secondaryButton: { padding: "16px 0", borderRadius: 14, border: "1px solid #1C1B19", background: "transparent", color: "#1C1B19", fontSize: 16, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", marginTop: 14 },
  orDivider: { textAlign: "center", color: "#A39C8C", fontSize: 13, margin: "24px 0", position: "relative" },
  onboardingError: { color: "#C0563A", fontSize: 13, marginTop: 10 },

  // Bottom nav
  bottomNav: {
    position: "sticky", bottom: 0, display: "flex", justifyContent: "space-around",
    background: "#FFFFFF", borderTop: "1px solid #E5DDC9", padding: "12px 8px 16px",
  },
  navItem: { display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", color: "#A39C8C", padding: "4px 12px" },
  navItemActive: { display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", color: "#1C1B19", padding: "4px 12px" },
  navIcon: { fontSize: 16, fontFamily: "'Fraunces', serif" },
  navLabel: { fontSize: 11, fontWeight: 600 },
};