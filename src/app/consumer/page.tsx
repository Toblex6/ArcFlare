// src/app/consumer/page.tsx
"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";

type View = "onboarding" | "home" | "send" | "save" | "request" | "payroll-chat" | "crosschain";

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
  { id: "crosschain", label: "Bridge to Arc", icon: "↕" },
  { id: "payroll-chat", label: "Payroll Chat", icon: "💬" },
];

interface ChainOption {
  id: string;
  label: string;
  testnet: boolean;
}

export default function ConsumerApp() {
  const router = useRouter();
  const [view, setView] = useState<View>("home");
  const [checkingSession, setCheckingSession] = useState(true);
  const [walletAddress, setWalletAddress] = useState("");
  const [onboardingInput, setOnboardingInput] = useState("");
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [creatingWallet, setCreatingWallet] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("7");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);

  // ── Cross‑chain state ──
  const [chains, setChains] = useState<ChainOption[]>([]);
  const [fromChain, setFromChain] = useState<string>("");
  // Destination is always Arc – stored but not user‑selectable
  const [toChain] = useState<string>("arc");
  const [crossRecipient, setCrossRecipient] = useState("");
  const [crossAmount, setCrossAmount] = useState("");
  const [crossLoading, setCrossLoading] = useState(false);
  const [crossResult, setCrossResult] = useState<ActionResult | null>(null);

  // ── Check for existing session ──
  useEffect(() => {
    fetch("/api/consumer/session")
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.account?.walletAddress) {
          setWalletAddress(data.account.walletAddress);
          setView("home");
        } else {
          setView("onboarding");
        }
      })
      .catch(() => setView("onboarding"))
      .finally(() => setCheckingSession(false));
  }, []);

  // ── Fetch supported source chains ──
  useEffect(() => {
    fetch("/api/cctp/transfer")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          const sourceChains = data.sourceChains || [];
          setChains(sourceChains);
          if (sourceChains.length > 0) {
            setFromChain(sourceChains[0].id);
          }
        }
      })
      .catch(console.error);
  }, []);

  // ── Wallet / session functions ──
  const connectExisting = async () => {
    const trimmed = onboardingInput.trim();
    if (!trimmed.startsWith("0x") || trimmed.length < 10) {
      setOnboardingError("That doesn't look like a wallet address. It should start with 0x.");
      return;
    }
    setOnboardingError(null);
    setCreatingWallet(true);
    try {
      const res = await fetch("/api/consumer/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: trimmed }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not connect that wallet.");
      setWalletAddress(data.account.walletAddress);
      setView("home");
    } catch (e: any) {
      setOnboardingError(e.message);
    } finally {
      setCreatingWallet(false);
    }
  };

  const createNewWallet = async () => {
    setCreatingWallet(true);
    setOnboardingError(null);
    try {
      const res = await fetch("/api/consumer/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not create a wallet right now.");
      setWalletAddress(data.account.walletAddress);
      setView("home");
    } catch (e: any) {
      setOnboardingError(e.message);
    } finally {
      setCreatingWallet(false);
    }
  };

  const disconnectWallet = async () => {
    try {
      await fetch("/api/consumer/session", { method: "DELETE" });
    } catch { }
    setWalletAddress("");
    setView("onboarding");
  };

  const resetActionState = () => {
    setRecipient("");
    setAmount("");
    setResult(null);
    setCrossRecipient("");
    setCrossAmount("");
    setCrossResult(null);
  };

  const goTo = (v: View) => {
    resetActionState();
    if (v === "payroll-chat") {
      router.push("/payroll-chat");
      return;
    }
    setView(v);
  };

  // ── Action Handlers ──
  const handleSend = async () => {
    setLoading(true);
    setResult(null);
    try {
      const initRes = await fetch(`/api/payments/initialize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, currency: "USDC", agentSCA: walletAddress || undefined, merchant: recipient }),
      });
      const initData = await initRes.json();
      if (!initData.success) throw new Error(initData.error || "Could not start payment.");

      const settleRes = await fetch(`/api/payments/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const res = await fetch(`/api/payments/scheduled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const res = await fetch(`/api/payments/initialize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  // ── Cross‑chain transfer ──
  const handleCrossChain = async () => {
    if (!fromChain || !crossAmount || !crossRecipient) {
      setCrossResult({ success: false, error: "Please fill in all fields." });
      return;
    }
    setCrossLoading(true);
    setCrossResult(null);
    try {
      const res = await fetch("/api/cctp/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromChain,
          toChain,      // always "arc"
          amount: crossAmount,
          recipient: crossRecipient,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Transfer failed.");
      setCrossResult({
        success: true,
        message: `Bridged ${crossAmount} USDC from ${fromChain} to Arc!`,
        txHash: data.sourceTxHash,
        explorerUrl: `https://testnet.arcscan.app/tx/${data.sourceTxHash}`,
      });
    } catch (e: any) {
      setCrossResult({ success: false, error: e.message });
    } finally {
      setCrossLoading(false);
    }
  };

  const submitHandlers: Record<string, () => void> = { send: handleSend, save: handleSave, request: handleRequest };

  // ── Onboarding view ──
  if (checkingSession) {
    return (
      <main style={styles.page}>
        <style>{FONT_IMPORT}</style>
        <div style={styles.onboardingWrap}>
          <p style={{ ...styles.onboardingSub, textAlign: "center" }}>Loading...</p>
        </div>
      </main>
    );
  }

  if (view === "onboarding") {
    return (
      <main style={styles.page}>
        <style>{FONT_IMPORT}</style>
        <div style={styles.onboardingWrap}>
          <div style={styles.logoMark}>
            <span style={styles.logoFlow}>＿╱</span>
            <span style={styles.logoText}>Flow</span>
          </div>
          <h1 style={styles.onboardingTitle}>Let's get you set up</h1>
          <p style={styles.onboardingSub}>You'll need a wallet to send, save, and request money. Takes a few seconds.</p>
          <button style={styles.primaryButton} disabled={creatingWallet} onClick={createNewWallet}>
            {creatingWallet ? "Setting things up..." : "Create my wallet"}
          </button>
          <div style={styles.orDivider}><span>or</span></div>
          <div style={styles.field}>
            <label style={styles.label}>I already have a wallet address</label>
            <input style={styles.input} value={onboardingInput} onChange={(e) => setOnboardingInput(e.target.value)} placeholder="0x..." />
          </div>
          <button style={styles.secondaryButton} onClick={connectExisting}>Use this wallet</button>
          {onboardingError && <p style={styles.onboardingError}>{onboardingError}</p>}
          <p style={styles.footnote}>Built on Arc · Your money is always yours</p>
        </div>
      </main>
    );
  }

  // ── Main Dashboard ──
  return (
    <main style={styles.page}>
      <style>{FONT_IMPORT}</style>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <Image
            src="/arcflare-logo.png.png"
            alt="ArcFlare"
            width={32}
            height={32}
            style={{ borderRadius: 6, flexShrink: 0 }}
          />
          <div style={styles.logoMark}>
            <span style={styles.logoFlow}>＿╱</span>
            <span style={styles.logoText}>Flow</span>
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <button
            style={styles.walletPill}
            onClick={() => setWalletMenuOpen((o) => !o)}
            title="Wallet options"
          >
            {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
          </button>
          {walletMenuOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 10 }}
                onClick={() => setWalletMenuOpen(false)}
              />
              <div
                style={{
                  position: 'absolute', top: '110%', right: 0, zIndex: 11,
                  background: '#FFFFFF', border: '1px solid #E5DDC9', borderRadius: 12,
                  boxShadow: '0 8px 20px rgba(0,0,0,0.12)', overflow: 'hidden', minWidth: 180,
                }}
              >
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(walletAddress);
                    setAddressCopied(true);
                    setTimeout(() => setAddressCopied(false), 1500);
                  }}
                  style={{
                    width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none',
                    border: 'none', fontSize: 13, color: '#1C1B19', cursor: 'pointer',
                  }}
                >
                  {addressCopied ? '✓ Copied' : '📋 Copy address'}
                </button>
                <button
                  onClick={() => {
                    setWalletMenuOpen(false);
                    disconnectWallet();
                  }}
                  style={{
                    width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none',
                    border: 'none', borderTop: '1px solid #E5DDC9', fontSize: 13, color: '#C0563A', cursor: 'pointer',
                  }}
                >
                  ⎋ Disconnect
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <div style={styles.contentArea}>
        {view === "home" && (
          <>
            <section style={styles.hero}>
              <p style={styles.eyebrow}>Money, simplified</p>
              <h1 style={styles.heroTitle}>Your money,<br />moving on its own.</h1>
              <p style={styles.heroSub}>Send to anyone. Save without thinking. Get paid in seconds.</p>
            </section>
            <section style={styles.actionsGrid}>
              <button style={styles.actionCard} onClick={() => goTo("send")}>
                <span style={styles.actionIcon}>→</span>
                <span style={styles.actionLabel}>Send money</span>
                <span style={styles.actionSub}>Pay anyone instantly</span>
              </button>
              <button style={styles.actionCard} onClick={() => goTo("save")}>
                <span style={styles.actionIcon}>◷</span>
                <span style={styles.actionLabel}>Save automatically</span>
                <span style={styles.actionSub}>Set money aside on a schedule</span>
              </button>
              <button style={styles.actionCard} onClick={() => goTo("request")}>
                <span style={styles.actionIcon}>←</span>
                <span style={styles.actionLabel}>Request payment</span>
                <span style={styles.actionSub}>Get a link to share</span>
              </button>
              <button style={styles.actionCard} onClick={() => goTo("crosschain")}>
                <span style={styles.actionIcon}>↕</span>
                <span style={styles.actionLabel}>Bridge to Arc</span>
                <span style={styles.actionSub}>Move USDC into Arc</span>
              </button>
              <button style={styles.actionCard} onClick={() => goTo("payroll-chat")}>
                <span style={styles.actionIcon}>💬</span>
                <span style={styles.actionLabel}>Payroll Chat</span>
                <span style={styles.actionSub}>Manage payroll with natural language</span>
              </button>
            </section>
            <p style={styles.footnote}>Built on Arc · Settled in USDC · Every transfer is real and onchain</p>
          </>
        )}

        {/* ── Send / Save / Request ── */}
        {(view === "send" || view === "save" || view === "request") && (
          <section style={styles.flowCard}>
            <h2 style={styles.flowTitle}>
              {view === "send" && "Send money"}
              {view === "save" && "Set up automatic saving"}
              {view === "request" && "Request a payment"}
            </h2>
            <div style={styles.flowLine}>
              <span style={styles.flowDot} />
              <span style={styles.flowStroke} />
              <span style={styles.flowDot} />
            </div>

            {!result && (
              <div style={styles.form}>
                {view === "send" && (
                  <div style={styles.field}>
                    <label style={styles.label}>Who's this for?</label>
                    <input style={styles.input} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Name or wallet address" />
                  </div>
                )}
                {view === "request" && (
                  <div style={styles.field}>
                    <label style={styles.label}>What's it for? (optional)</label>
                    <input style={styles.input} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="e.g. Rent, design work..." />
                  </div>
                )}
                <div style={styles.field}>
                  <label style={styles.label}>Amount (USDC)</label>
                  <input style={styles.input} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </div>
                {view === "save" && (
                  <div style={styles.field}>
                    <label style={styles.label}>How often?</label>
                    <div style={styles.freqRow}>
                      {[{ label: "Daily", val: "1" }, { label: "Weekly", val: "7" }, { label: "Monthly", val: "30" }].map((f) => (
                        <button key={f.val} style={frequency === f.val ? styles.freqPillActive : styles.freqPill} onClick={() => setFrequency(f.val)}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <button style={styles.submitButton} disabled={loading || !amount} onClick={submitHandlers[view]}>
                  {loading ? "Working on it..." : view === "send" ? "Send now" : view === "save" ? "Start saving" : "Create request"}
                </button>
              </div>
            )}

            {result && (
              <div style={result.success ? styles.resultSuccess : styles.resultError}>
                <p style={styles.resultIcon}>{result.success ? "✓" : "!"}</p>
                <p style={styles.resultText}>{result.success ? result.message : result.error}</p>
                {result.explorerUrl && <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer" style={styles.resultLink}>View transaction</a>}
                {result.reference && view === "request" && <div style={styles.linkBox}>{result.reference}</div>}
                <button style={styles.doneButton} onClick={() => goTo("home")}>Done</button>
              </div>
            )}
          </section>
        )}

        {/* ── Cross‑chain view ── */}
        {view === "crosschain" && (
          <section style={styles.flowCard}>
            <h2 style={styles.flowTitle}>Bridge to Arc</h2>
            <p style={{ color: "#8A8275", fontSize: "clamp(13px, 1.2vw, 15px)", marginBottom: 20 }}>
              Send USDC from any supported chain directly to your Arc wallet.
            </p>
            <div style={styles.flowLine}>
              <span style={styles.flowDot} />
              <span style={styles.flowStroke} />
              <span style={styles.flowDot} />
            </div>

            {!crossResult && (
              <div style={styles.form}>
                <div style={styles.field}>
                  <label style={styles.label}>Source Chain</label>
                  <select
                    value={fromChain}
                    onChange={(e) => setFromChain(e.target.value)}
                    style={styles.input}
                  >
                    {chains.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} {c.testnet ? "(testnet)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Destination Chain</label>
                  <input
                    style={{ ...styles.input, background: "#EDE6D8", cursor: "not-allowed" }}
                    value="Arc Testnet"
                    disabled
                  />
                  <input type="hidden" value="arc" />
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Amount (USDC)</label>
                  <input
                    style={styles.input}
                    type="number"
                    value={crossAmount}
                    onChange={(e) => setCrossAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Your Arc Address</label>
                  <input
                    style={styles.input}
                    value={crossRecipient}
                    onChange={(e) => setCrossRecipient(e.target.value)}
                    placeholder="0x..."
                  />
                </div>
                <button
                  style={styles.submitButton}
                  disabled={crossLoading || !crossAmount || !crossRecipient || !fromChain}
                  onClick={handleCrossChain}
                >
                  {crossLoading ? "Processing..." : "Bridge to Arc"}
                </button>
              </div>
            )}

            {crossResult && (
              <div style={crossResult.success ? styles.resultSuccess : styles.resultError}>
                <p style={styles.resultIcon}>{crossResult.success ? "✓" : "!"}</p>
                <p style={styles.resultText}>{crossResult.success ? crossResult.message : crossResult.error}</p>
                {crossResult.explorerUrl && (
                  <a href={crossResult.explorerUrl} target="_blank" rel="noopener noreferrer" style={styles.resultLink}>
                    View source transaction
                  </a>
                )}
                <button style={styles.doneButton} onClick={() => goTo("home")}>Done</button>
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── Bottom Nav ── */}
      <nav style={styles.bottomNav}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            style={view === item.id ? styles.navItemActive : styles.navItem}
            onClick={() => goTo(item.id)}
          >
            <span style={styles.navIcon}>{item.icon}</span>
            <span style={styles.navLabel}>{item.label}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}

// ── Styles (fully responsive) ──
const FONT_IMPORT = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');
`;

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#FBF8F3",
    color: "#1C1B19",
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
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  logoMark: { display: "flex", alignItems: "baseline", gap: 6 },
  logoFlow: { fontFamily: "'Fraunces', serif", fontSize: 20, color: "#E8714A" },
  logoText: { fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 600, letterSpacing: -0.3 },
  walletPill: {
    fontSize: "clamp(10px, 1.2vw, 12px)",
    fontFamily: "monospace",
    color: "#5C7A5C",
    background: "#EDE6D8",
    padding: "6px 12px",
    borderRadius: 20,
    border: "none",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  contentArea: { flex: 1, padding: "0 0 80px", overflowY: "auto" },
  hero: { padding: "20px 0 16px" },
  eyebrow: { fontSize: "clamp(10px, 1vw, 12px)", color: "#5C7A5C", fontWeight: 600, letterSpacing: 1.5, textTransform: "uppercase", margin: "0 0 14px" },
  heroTitle: {
    fontFamily: "'Fraunces', serif",
    fontSize: "clamp(28px, 5vw, 34px)",
    lineHeight: 1.12,
    fontWeight: 500,
    margin: "0 0 16px",
    letterSpacing: -0.5,
  },
  heroSub: { fontSize: "clamp(14px, 1.5vw, 16px)", lineHeight: 1.55, color: "#5C5850", margin: 0, maxWidth: 440 },
  actionsGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 12, margin: "20px 0 24px" },
  actionCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 4,
    background: "#FFFFFF",
    border: "1px solid #E5DDC9",
    borderRadius: 18,
    padding: "16px 18px",
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
    transition: "all 0.15s",
  },
  actionIcon: { fontSize: "clamp(18px, 2vw, 20px)", color: "#E8714A", marginBottom: 6, fontFamily: "'Fraunces', serif" },
  actionLabel: { fontSize: "clamp(16px, 1.8vw, 18px)", fontWeight: 600 },
  actionSub: { fontSize: "clamp(12px, 1.2vw, 14px)", color: "#8A8275" },
  footnote: { textAlign: "center", fontSize: "clamp(10px, 1vw, 12px)", color: "#A39C8C", margin: "8px 0" },
  flowCard: { paddingTop: 16 },
  flowTitle: { fontFamily: "'Fraunces', serif", fontSize: "clamp(22px, 4vw, 26px)", fontWeight: 500, margin: "0 0 20px" },
  flowLine: { display: "flex", alignItems: "center", gap: 0, marginBottom: 24 },
  flowDot: { width: 8, height: 8, borderRadius: "50%", background: "#5C7A5C", flexShrink: 0 },
  flowStroke: { flex: 1, height: 2, background: "linear-gradient(90deg, #5C7A5C, #E8714A)", margin: "0 6px" },
  form: { display: "flex", flexDirection: "column", gap: 16 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: "clamp(12px, 1.2vw, 14px)", fontWeight: 600, color: "#5C5850" },
  input: {
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid #E5DDC9",
    background: "#FFFFFF",
    fontSize: "clamp(14px, 1.5vw, 16px)",
    color: "#1C1B19",
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
    width: "100%",
  },
  freqRow: { display: "flex", gap: 8 },
  freqPill: {
    flex: 1,
    padding: "8px 0",
    borderRadius: 10,
    border: "1px solid #E5DDC9",
    background: "#FFFFFF",
    color: "#5C5850",
    fontSize: "clamp(12px, 1.2vw, 14px)",
    fontWeight: 500,
    cursor: "pointer",
  },
  freqPillActive: {
    flex: 1,
    padding: "8px 0",
    borderRadius: 10,
    border: "1px solid #5C7A5C",
    background: "#5C7A5C",
    color: "#FFFFFF",
    fontSize: "clamp(12px, 1.2vw, 14px)",
    fontWeight: 600,
    cursor: "pointer",
  },
  submitButton: {
    marginTop: 8,
    padding: "14px 0",
    borderRadius: 14,
    border: "none",
    background: "#1C1B19",
    color: "#FBF8F3",
    fontSize: "clamp(14px, 1.5vw, 16px)",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  resultSuccess: {
    textAlign: "center",
    padding: "24px 16px",
    background: "#FFFFFF",
    border: "1px solid #D6E2D6",
    borderRadius: 18,
  },
  resultError: {
    textAlign: "center",
    padding: "24px 16px",
    background: "#FFFFFF",
    border: "1px solid #F0D5C9",
    borderRadius: 18,
  },
  resultIcon: { fontSize: "clamp(24px, 3vw, 28px)", margin: "0 0 10px", color: "#5C7A5C" },
  resultText: { fontSize: "clamp(13px, 1.2vw, 15px)", margin: "0 0 14px", lineHeight: 1.5 },
  resultLink: { fontSize: "clamp(12px, 1vw, 13px)", color: "#E8714A", fontWeight: 600 },
  linkBox: {
    fontSize: "clamp(10px, 1vw, 12px)",
    fontFamily: "monospace",
    background: "#EDE6D8",
    padding: "8px 12px",
    borderRadius: 10,
    wordBreak: "break-all",
    margin: "0 0 14px",
  },
  doneButton: {
    marginTop: 12,
    padding: "10px 24px",
    borderRadius: 12,
    border: "1px solid #1C1B19",
    background: "transparent",
    color: "#1C1B19",
    fontSize: "clamp(12px, 1.2vw, 14px)",
    fontWeight: 600,
    cursor: "pointer",
  },
  onboardingWrap: {
    padding: "40px 16px",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    flex: 1,
  },
  onboardingTitle: {
    fontFamily: "'Fraunces', serif",
    fontSize: "clamp(26px, 5vw, 30px)",
    fontWeight: 500,
    margin: "24px 0 10px",
  },
  onboardingSub: {
    fontSize: "clamp(14px, 1.5vw, 16px)",
    color: "#5C5850",
    lineHeight: 1.5,
    margin: "0 0 24px",
  },
  primaryButton: {
    padding: "14px 0",
    borderRadius: 14,
    border: "none",
    background: "#1C1B19",
    color: "#FBF8F3",
    fontSize: "clamp(14px, 1.5vw, 16px)",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  secondaryButton: {
    padding: "14px 0",
    borderRadius: 14,
    border: "1px solid #1C1B19",
    background: "transparent",
    color: "#1C1B19",
    fontSize: "clamp(14px, 1.5vw, 16px)",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    marginTop: 12,
  },
  orDivider: { textAlign: "center", color: "#A39C8C", fontSize: "clamp(12px, 1vw, 13px)", margin: "20px 0", position: "relative" },
  onboardingError: { color: "#C0563A", fontSize: "clamp(12px, 1vw, 13px)", marginTop: 8 },
  bottomNav: {
    position: "sticky",
    bottom: 0,
    display: "flex",
    justifyContent: "space-around",
    background: "#FFFFFF",
    borderTop: "1px solid #E5DDC9",
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
    color: "#A39C8C",
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
    color: "#1C1B19",
    padding: "4px 8px",
  },
  navIcon: { fontSize: "clamp(14px, 1.5vw, 16px)", fontFamily: "'Fraunces', serif" },
  navLabel: { fontSize: "clamp(9px, 0.8vw, 11px)", fontWeight: 600 },
};