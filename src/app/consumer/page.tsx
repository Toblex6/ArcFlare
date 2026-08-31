// src/app/consumer/page.tsx
"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useSignMessage } from "wagmi";
import type { Address } from "viem";
import { friendlyWalletError } from "@/lib/wallet/walletErrors";

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
  { id: "home", label: "Home", icon: "🏠" },
  { id: "send", label: "Send", icon: "💸" },
  { id: "save", label: "Save", icon: "🐷" },
  { id: "request", label: "Request", icon: "📥" },
  { id: "crosschain", label: "Bridge", icon: "🌉" },
  { id: "payroll-chat", label: "Payroll", icon: "💬" },
];

interface ChainOption {
  id: string;
  label: string;
  testnet: boolean;
}

// A saving plan = a scheduled self-transfer (payer == receiver). Rows the
// caller controls that pay OTHER people (e.g. payroll schedules) are not
// "savings" and are filtered out of the Save view.
interface SavingsPlan {
  reference: string;
  payerSCA: string;
  receiverSCA: string;
  amount: number;
  intervalDays: number;
  nextRunAt: string;
  runCount: number;
  maxRuns?: number | null;
  description?: string | null;
  status: string;
}

// Shape returned by /api/consumer/activity. explorerUrl is present only when
// the row has a real arcTxHash (null while a transfer is still pending).
interface ActivityItem {
  reference: string;
  direction: "in" | "out";
  counterparty?: string;
  amount: number;
  status: string;
  timestamp: string;
  explorerUrl?: string | null;
}

export default function ConsumerApp() {
  const router = useRouter();
  const { signMessageAsync } = useSignMessage();
  const [view, setView] = useState<View>("home");
  const [checkingSession, setCheckingSession] = useState(true);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletType, setWalletType] = useState<string | null>(null);
  const [justCreatedWallet, setJustCreatedWallet] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("flow-theme");
    if (saved === "dark") setDarkMode(true);
  }, []);

  useEffect(() => {
    localStorage.setItem("flow-theme", darkMode ? "dark" : "light");
  }, [darkMode]);
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
  const [linkCopied, setLinkCopied] = useState(false);

  // ── Cross‑chain state ──
  const [chains, setChains] = useState<ChainOption[]>([]);
  const [fromChain, setFromChain] = useState<string>("");
  const [toChain] = useState<string>("Arc_Testnet");
  const [crossAmount, setCrossAmount] = useState("");
  const [crossLoading, setCrossLoading] = useState(false);
  const [crossResult, setCrossResult] = useState<ActionResult | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [chainBalance, setChainBalance] = useState<string | null>(null);
  const [chainBalanceLoading, setChainBalanceLoading] = useState(false);
  const [chainBalanceError, setChainBalanceError] = useState<string | null>(null);
  const [chainBalanceTick, setChainBalanceTick] = useState(0);
  const [bridgeNeedsFlareWallet, setBridgeNeedsFlareWallet] = useState(false);
  const [creatingFlareWallet, setCreatingFlareWallet] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  // ── Savings plans (scheduled self-transfers) ──
  const [savingsPlans, setSavingsPlans] = useState<SavingsPlan[]>([]);
  const [savingsLoading, setSavingsLoading] = useState(false);
  const [savingsBusyRef, setSavingsBusyRef] = useState<string | null>(null);
  const [editingRef, setEditingRef] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editFrequency, setEditFrequency] = useState("7");

  // ── Deep links (/consumer?view=save etc.) — captured once at mount so the
  // payroll page's bottom nav can land on a specific view ──
  const initialViewRef = useRef<View | null>(null);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    const valid: View[] = ["home", "send", "save", "request", "crosschain"];
    if (requested && valid.includes(requested as View)) {
      initialViewRef.current = requested as View;
    }
  }, []);

  const refreshSavings = () => {
    if (!walletAddress) return;
    setSavingsLoading(true);
    fetch("/api/payments/scheduled?status=ACTIVE")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          const selfPay = (data.scheduledPayments || []).filter(
            (s: SavingsPlan) => (s.receiverSCA || "").toLowerCase() === (s.payerSCA || "").toLowerCase()
          );
          setSavingsPlans(selfPay);
        }
      })
      .catch(console.error)
      .finally(() => setSavingsLoading(false));
  };

  useEffect(() => {
    if (view === "save" && walletAddress) refreshSavings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, walletAddress]);


  const refreshBalance = () => {
    if (!walletAddress) return;
    setBalanceLoading(true);
    fetch("/api/consumer/balance")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setBalance(data.balance);
      })
      .catch(console.error)
      .finally(() => setBalanceLoading(false));
  };

  useEffect(() => {
    if (!walletAddress) return;
    refreshBalance();
    fetch("/api/consumer/activity")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setActivity(data.activity || []);
      })
      .catch(console.error);
  }, [walletAddress]);

  // ── Refresh the home balance whenever the user comes back to Home ──
  useEffect(() => {
    if (view === "home" && walletAddress) refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, walletAddress]);

  // ── Source-chain balance for the bridge view (per selected chain) ──
  useEffect(() => {
    if (view !== "crosschain" || !fromChain || !walletAddress) return;
    let cancelled = false;
    setChainBalanceLoading(true);
    setChainBalanceError(null);
    fetch(`/api/cctp/transfer/balance?fromChain=${encodeURIComponent(fromChain)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) setChainBalance(data.balance);
        else if (data.code === "EXTERNAL_WALLET") {
          setBridgeNeedsFlareWallet(true);
          setChainBalance(null);
          setChainBalanceError(null);
        } else {
          setChainBalance(null);
          setChainBalanceError(data.error || "Could not load balance for this chain.");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setChainBalance(null);
        setChainBalanceError("Could not load balance for this chain.");
      })
      .finally(() => {
        if (!cancelled) setChainBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, fromChain, walletAddress, chainBalanceTick]);

  // ── Check for existing session ──
  useEffect(() => {
    fetch("/api/consumer/session")
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.account?.walletAddress) {
          setWalletAddress(data.account.walletAddress);
          setWalletType(data.account.walletType ?? null);
          setView(initialViewRef.current ?? "home");
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
      // 1. Get a challenge from the server (nonce cookie + SIWE-style
      // message). The challenge is bound to the address being claimed, so
      // a signature for one address can't be replayed against another.
      const challengeRes = await fetch(`/api/consumer/session?nonce=1&address=${trimmed}`);
      const challengeData = await challengeRes.json();
      if (!challengeData.success || !challengeData.message) {
        throw new Error(challengeData.error || "Could not start wallet connection.");
      }

      // 2. Ask the user's wallet (MetaMask etc.) to sign the challenge
      // message from the address they typed. If they don't control that
      // address, the wallet refuses — nothing is sent to the server.
      const signature = await signMessageAsync({
        message: challengeData.message,
        account: trimmed as Address,
      });

      // 3. Exchange signature → session cookie.
      const res = await fetch("/api/consumer/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: trimmed, message: challengeData.message, signature }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not connect that wallet.");
      setWalletAddress(data.account.walletAddress);
      setWalletType(data.account.walletType ?? null);
      setView("home");
    } catch (e: any) {
      const lower = String(e?.shortMessage ?? e?.message ?? '').toLowerCase();
      const message = lower.includes('user rejected') || lower.includes('user denied')
        ? 'Signature was cancelled. No changes were made.'
        : friendlyWalletError(e);
      setOnboardingError(message);
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
      setWalletType(data.account.walletType ?? "CIRCLE");
      setJustCreatedWallet(true);
      setView("home");
    } catch (e: any) {
      setOnboardingError(friendlyWalletError(e));
    } finally {
      setCreatingWallet(false);
    }
  };

  // ── Bridge upgrade flow: give an external-wallet user a FlareHQ wallet ──
  // POST {} provisions a brand-new Circle-managed wallet and reissues the
  // session against it. The user's connected wallet still works for sending/
  // requesting; the FlareHQ wallet is what the bridge can actually move
  // funds from (Circle signs on it).
  const createFlareHQWallet = async () => {
    setCreatingFlareWallet(true);
    setCrossResult(null);
    try {
      const res = await fetch("/api/consumer/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not create a FlareHQ wallet right now.");
      setWalletAddress(data.account.walletAddress);
      setWalletType(data.account.walletType ?? "CIRCLE");
      setBridgeNeedsFlareWallet(false);
      setJustCreatedWallet(true);
    } catch (e: any) {
      setCrossResult({ success: false, error: friendlyWalletError(e) });
    } finally {
      setCreatingFlareWallet(false);
    }
  };

  const disconnectWallet = async () => {
    try {
      await fetch("/api/consumer/session", { method: "DELETE" });
    } catch { }
    setWalletAddress("");
    setWalletType(null);
    setBridgeNeedsFlareWallet(false);
    setView("onboarding");
  };

  const resetActionState = () => {
    setRecipient("");
    setAmount("");
    setResult(null);
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
        body: JSON.stringify({ amount, currency: "USDC", payoutAddress: recipient, merchant: recipient, direction: "send" }),
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
      refreshSavings();
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setLoading(false);
    }
  };

  // ── Savings plan management (edit / cancel via /api/payments/scheduled) ──
  const startEditSavings = (plan: SavingsPlan) => {
    setEditingRef(plan.reference);
    setEditAmount(String(plan.amount));
    setEditFrequency(String(plan.intervalDays));
  };

  const handleSaveEdit = async () => {
    if (!editingRef) return;
    setSavingsBusyRef(editingRef);
    try {
      const res = await fetch(`/api/payments/scheduled`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference: editingRef,
          amount: parseFloat(editAmount),
          intervalDays: parseInt(editFrequency),
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not update this plan.");
      setEditingRef(null);
      refreshSavings();
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setSavingsBusyRef(null);
    }
  };

  const handleCancelSavings = async (reference: string) => {
    setSavingsBusyRef(reference);
    try {
      const res = await fetch(`/api/payments/scheduled`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not cancel this plan.");
      if (editingRef === reference) setEditingRef(null);
      refreshSavings();
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setSavingsBusyRef(null);
    }
  };

  const handleRequest = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`/api/payments/initialize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, currency: "USDC", merchant: "Payment request", direction: "request" }),
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
    if (!fromChain || !crossAmount) {
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
          toChain,
          amount: crossAmount,
          recipient: walletAddress,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        if (data.code === "EXTERNAL_WALLET") setBridgeNeedsFlareWallet(true);
        throw new Error(data.error || "Transfer failed.");
      }

      // The whole bridge (burn -> attestation -> mint) runs in the
      // background from here — poll instead of waiting on one open
      // request, since Circle's attestation for Arc can take a while.
      setCrossResult({
        success: true,
        message: `Starting bridge from ${fromChain}...`,
      });

      const { reference } = data;
      const maxAttempts = 60; // ~10 minutes at 10s intervals
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 10_000));
        const statusRes = await fetch(`/api/cctp/transfer/status?reference=${reference}`);
        const statusData = await statusRes.json();
        if (!statusData.success) continue; // transient — keep polling

        if (statusData.state === "success") {
          setCrossResult({
            success: true,
            message: `Bridged ${crossAmount} USDC from ${fromChain} to Arc!`,
            explorerUrl: statusData.destinationExplorerUrl,
          });
          setChainBalanceTick((t) => t + 1);
          return;
        }
        if (statusData.state === "error") {
          setCrossResult({ success: false, error: statusData.error || "Bridge transfer failed." });
          return;
        }
        // 'submitting' (burn not confirmed yet) or 'pending' (burn confirmed,
        // waiting on attestation + mint) — keep polling, show whatever link
        // is available so far.
        setCrossResult({
          success: true,
          message:
            statusData.state === "submitting"
              ? `Confirming burn on ${fromChain}...`
              : `Burn confirmed on ${fromChain}. Waiting for Circle's attestation and mint — this can take a few minutes...`,
          explorerUrl: statusData.sourceExplorerUrl,
        });
      }

      setCrossResult({
        success: false,
        error: "Still waiting after 10 minutes. It may still complete — check the source transaction on the explorer. Note: Arc is a newer CCTP destination, so attestation can take longer than usual.",
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
      <main style={styles.page} className="flarehq flow-app" data-theme={darkMode ? "dark" : "light"}>
        <style>{FONT_IMPORT}</style>
        <div style={styles.onboardingWrap}>
          <p style={{ ...styles.onboardingSub, textAlign: "center" }}>Loading...</p>
        </div>
      </main>
    );
  }

  if (view === "onboarding") {
    return (
      <main style={styles.page} className="flareHQ flow-app" data-theme={darkMode ? "dark" : "light"}>
        <style>{FONT_IMPORT}</style>
        <div style={styles.onboardingWrap}>
          <div style={styles.headerLeft}>
            <Image
              src="/arcflare-logo.png"
              alt="ArcFlare"
              width={40}
              height={40}
              style={{ borderRadius: 8, flexShrink: 0 }}
            />
            <span style={styles.appName}>FlareHQ Flow</span>
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
    <main style={styles.page} className="flareHQ flow-app" data-theme={darkMode ? "dark" : "light"}>
      <style>{FONT_IMPORT}</style>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <Image
            src="/arcflare-logo.png"
            alt="ArcFlare"
            width={32}
            height={32}
            style={{ borderRadius: 6, flexShrink: 0 }}
          />
          <span style={styles.appName}>FlareHQ Flow</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            style={styles.themeToggle}
            onClick={() => setDarkMode((d) => !d)}
            title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
          >
            {darkMode ? "☀️" : "🌙"}
          </button>
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
                    background: 'var(--flow-surface)', border: '1px solid var(--flow-border)', borderRadius: 12,
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
                      border: 'none', fontSize: 13, color: 'var(--flow-text)', cursor: 'pointer',
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
                      border: 'none', borderTop: '1px solid var(--flow-border)', fontSize: 13, color: '#C0563A', cursor: 'pointer',
                    }}
                  >
                    ⎋ Disconnect
                  </button>
                </div>
              </>
            )}
          </div>
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

            {justCreatedWallet && (
              <section style={styles.faucetBanner}>
                <div>
                  <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 14 }}>🎉 Wallet created!</p>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--flow-text-muted)" }}>
                    Grab some free test USDC to try sending, saving, and bridging.
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <a
                    href="https://faucet.circle.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.faucetButton}
                  >
                    Get Test USDC
                  </a>
                  <button style={styles.faucetDismiss} onClick={() => setJustCreatedWallet(false)}>✕</button>
                </div>
              </section>
            )}

            <section style={styles.balanceCard}>
              <p style={{ margin: "0 0 4px", fontSize: 12, color: "var(--flow-text-faint)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Balance
              </p>
              <p style={{ margin: 0, fontSize: "clamp(28px, 5vw, 36px)", fontWeight: 700, fontFamily: "'Fraunces', serif" }}>
                {balanceLoading ? "..." : balance !== null ? `$${parseFloat(balance).toFixed(2)}` : "—"}
                <span style={{ fontSize: 16, fontWeight: 500, color: "var(--flow-text-faint)", marginLeft: 6 }}>USDC</span>
              </p>
              <button style={styles.refreshBalanceButton} onClick={refreshBalance} disabled={balanceLoading}>
                {balanceLoading ? "Refreshing..." : "↻ Refresh"}
              </button>
            </section>

            <section style={styles.actionsGrid} className="flow-actions-grid">
              <button style={styles.actionCard} onClick={() => goTo("send")}>
                <span style={styles.actionIconBadge}><span style={styles.actionIcon}>💸</span></span>
                <span style={styles.actionLabel}>Send money</span>
                <span style={styles.actionSub}>Pay anyone instantly</span>
              </button>
              <button style={styles.actionCard} onClick={() => goTo("save")}>
                <span style={styles.actionIconBadge}><span style={styles.actionIcon}>🐷</span></span>
                <span style={styles.actionLabel}>Save automatically</span>
                <span style={styles.actionSub}>Set money aside on a schedule</span>
              </button>
              <button style={styles.actionCard} onClick={() => goTo("request")}>
                <span style={styles.actionIconBadge}><span style={styles.actionIcon}>📥</span></span>
                <span style={styles.actionLabel}>Request payment</span>
                <span style={styles.actionSub}>Get a link to share</span>
              </button>
              <button style={styles.actionCard} onClick={() => goTo("crosschain")}>
                <span style={styles.actionIconBadge}><span style={styles.actionIcon}>🌉</span></span>
                <span style={styles.actionLabel}>Bridge to Arc</span>
                <span style={styles.actionSub}>Move USDC into Arc</span>
              </button>
              <button style={styles.actionCard} onClick={() => goTo("payroll-chat")}>
                <span style={styles.actionIconBadge}><span style={styles.actionIcon}>💬</span></span>
                <span style={styles.actionLabel}>Payroll Chat</span>
                <span style={styles.actionSub}>Manage payroll with natural language</span>
              </button>
            </section>

            <section style={styles.faucetCard}>
              <div>
                <p style={{ margin: "0 0 2px", fontWeight: 700, fontSize: 13 }}>Need more test USDC?</p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--flow-text-faint)" }}>Opens Circle's official Arc testnet faucet.</p>
              </div>
              <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer" style={styles.faucetCardLink}>
                Open faucet ↗
              </a>
            </section>

            <section>
              <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "var(--flow-text-muted)" }}>Recent Activity</p>
              {activity.length === 0 ? (
                <p style={{ margin: 0, fontSize: 13, color: "var(--flow-text-faint)" }}>No transactions yet.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {activity.map((a) => (
                    <div key={a.reference} style={styles.activityRow}>
                      <div>
                        <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 600 }}>
                          {a.direction === "out" ? "Sent" : "Received"}
                          {a.counterparty ? ` ${a.direction === "out" ? "to" : "from"} ${a.counterparty.slice(0, 6)}...${a.counterparty.slice(-4)}` : ""}
                        </p>
                        <p style={{ margin: 0, fontSize: 11, color: "var(--flow-text-faint)" }}>
                          {new Date(a.timestamp).toLocaleString()} · {a.status}
                        </p>
                        {a.explorerUrl ? (
                          <a href={a.explorerUrl} target="_blank" rel="noopener noreferrer" style={styles.resultLink}>
                            View on ArcScan
                          </a>
                        ) : (
                          <p style={{ margin: 0, fontSize: 11, color: "var(--flow-text-faint)" }}>
                            {a.status !== "SUCCESS" ? "Pending — no transaction yet" : null}
                          </p>
                        )}
                      </div>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: a.direction === "out" ? "#C0563A" : "#3F7A57" }}>
                        {a.direction === "out" ? "-" : "+"}${a.amount.toFixed(2)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <p style={styles.footnote}>Built on Arc · Settled in USDC · Every transfer is real and onchain</p>
          </>
        )}

        {/* ── Your savings plans (Save view) ── */}
        {view === "save" && walletAddress && (
          <section style={{ marginBottom: 24 }}>
            <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "var(--flow-text-muted)" }}>
              Your savings plans
            </p>
            {savingsLoading && savingsPlans.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: "var(--flow-text-faint)" }}>Loading your plans...</p>
            ) : savingsPlans.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: "var(--flow-text-faint)" }}>
                No active saving plans yet — set one up below and it will appear here.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {savingsPlans.map((plan) => (
                  <div key={plan.reference} style={{ background: "var(--flow-surface-2)", borderRadius: 12, padding: "12px 14px" }}>
                    {editingRef !== plan.reference ? (
                      <>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                          <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                            ${plan.amount.toFixed(2)} <span style={{ fontWeight: 500, color: "var(--flow-text-muted)" }}>every {plan.intervalDays} day(s)</span>
                          </p>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#3F7A57", background: "rgba(63,122,87,0.12)", padding: "3px 8px", borderRadius: 8 }}>
                            ACTIVE
                          </span>
                        </div>
                        <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--flow-text-faint)" }}>
                          Next run {new Date(plan.nextRunAt).toLocaleString()} · {plan.runCount} run(s) so far
                        </p>
                        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                          <button
                            style={{ flex: 1, padding: "8px 0", borderRadius: 10, border: "1px solid var(--flow-border)", background: "var(--flow-surface)", color: "var(--flow-text)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                            onClick={() => startEditSavings(plan)}
                            disabled={savingsBusyRef === plan.reference}
                          >
                            ✏️ Edit
                          </button>
                          <button
                            style={{ flex: 1, padding: "8px 0", borderRadius: 10, border: "1px solid #F0D5C9", background: "var(--flow-surface)", color: "#C0563A", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                            onClick={() => handleCancelSavings(plan.reference)}
                            disabled={savingsBusyRef === plan.reference}
                          >
                            {savingsBusyRef === plan.reference ? "Cancelling..." : "✕ Cancel plan"}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600 }}>Edit this plan</p>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div style={styles.field}>
                            <label style={styles.label}>Amount (USDC)</label>
                            <input style={styles.input} type="number" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} placeholder="0.00" />
                          </div>
                          <div style={styles.field}>
                            <label style={styles.label}>How often? (days)</label>
                            <div style={styles.freqRow}>
                              {[{ label: "Daily", val: "1" }, { label: "Weekly", val: "7" }, { label: "Monthly", val: "30" }].map((f) => (
                                <button key={f.val} style={editFrequency === f.val ? styles.freqPillActive : styles.freqPill} onClick={() => setEditFrequency(f.val)}>
                                  {f.label}
                                </button>
                              ))}
                            </div>
                            <input style={{ ...styles.input, marginTop: 6 }} type="number" min="1" value={editFrequency} onChange={(e) => setEditFrequency(e.target.value)} placeholder="Custom interval in days" />
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#1C1B19", color: "#FBF8F3", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                              onClick={handleSaveEdit}
                              disabled={savingsBusyRef === plan.reference || !editAmount || parseInt(editFrequency) <= 0}
                            >
                              {savingsBusyRef === plan.reference ? "Saving..." : "Save changes"}
                            </button>
                            <button
                              style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid var(--flow-border)", background: "var(--flow-surface)", color: "var(--flow-text)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                              onClick={() => setEditingRef(null)}
                              disabled={savingsBusyRef === plan.reference}
                            >
                              Discard
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
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
                {result.reference && view === "request" && (
                  <div style={styles.linkRow}>
                    <div style={styles.linkBox}>{result.reference}</div>
                    <button
                      style={styles.copyLinkButton}
                      onClick={() => {
                        navigator.clipboard.writeText(result.reference!);
                        setLinkCopied(true);
                        setTimeout(() => setLinkCopied(false), 1500);
                      }}
                    >
                      {linkCopied ? "✓ Copied" : "📋 Copy link"}
                    </button>
                  </div>
                )}
                <button style={styles.doneButton} onClick={() => goTo("home")}>Done</button>
              </div>
            )}
          </section>
        )}

        {/* ── Cross‑chain view ── */}
        {view === "crosschain" && (
          <section style={styles.flowCard}>
            <h2 style={styles.flowTitle}>Bridge to Arc</h2>
            <p style={{ color: "var(--flow-text-faint)", fontSize: "clamp(13px, 1.2vw, 15px)", marginBottom: 20 }}>
              Send USDC from any supported chain directly to your Arc wallet.
            </p>
            <div style={styles.flowLine}>
              <span style={styles.flowDot} />
              <span style={styles.flowStroke} />
              <span style={styles.flowDot} />
            </div>

            {(walletType === "EXTERNAL" || bridgeNeedsFlareWallet) && !crossResult ? (
              <div style={styles.flareWalletCard}>
                <p style={styles.flareWalletIcon}>👛</p>
                <p style={styles.flareWalletTitle}>Bridging needs a FlareHQ wallet</p>
                <p style={styles.flareWalletText}>
                  You connected your own wallet — great for holding funds, but FlareHQ
                  can't sign bridge transactions from it. Create a free FlareHQ-managed
                  wallet and you can bridge USDC from any supported chain in one tap.
                  Your connected wallet keeps working everywhere else.
                </p>
                <button
                  style={styles.submitButton}
                  disabled={creatingFlareWallet}
                  onClick={createFlareHQWallet}
                >
                  {creatingFlareWallet ? "Creating your wallet..." : "Create a FlareHQ wallet"}
                </button>
              </div>
            ) : (
              <>
            {!crossResult && (
              <div style={styles.form}>
                <div style={styles.field}>
                  <label style={styles.label}>Source Chain</label>
                  <div style={styles.selectWrap}>
                    <select
                      value={fromChain}
                      onChange={(e) => {
                        setCrossAmount("");
                        setFromChain(e.target.value);
                      }}
                      style={styles.select}
                      aria-label="Select the chain to bridge from"
                    >
                      {chains.length === 0 && <option value="">Loading chains…</option>}
                      {chains.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label} {c.testnet ? "(testnet)" : ""}
                        </option>
                      ))}
                    </select>
                    <span style={styles.selectChevron} aria-hidden="true">▾</span>
                  </div>
                  <div style={styles.chainBalanceRow}>
                    {chainBalanceLoading ? (
                      <span style={styles.chainBalanceText}>Checking balance…</span>
                    ) : chainBalanceError ? (
                      <>
                        <span style={styles.chainBalanceErrorText}>{chainBalanceError}</span>
                        <button style={styles.chainBalanceRetry} onClick={() => setChainBalanceTick((t) => t + 1)}>Retry</button>
                      </>
                    ) : (
                      <>
                        <span style={styles.chainBalanceText}>
                          Available: <strong>{chainBalance !== null ? `${parseFloat(chainBalance).toFixed(2)} USDC` : "—"}</strong>
                        </span>
                        <button
                          style={styles.maxButton}
                          disabled={!chainBalance || parseFloat(chainBalance) <= 0}
                          onClick={() => setCrossAmount(String(parseFloat(chainBalance!)))}
                        >
                          Max
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Destination Chain</label>
                  <input
                    style={{ ...styles.input, background: "var(--flow-surface-2)", cursor: "not-allowed" }}
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
                  <label style={styles.label}>Arriving in</label>
                  <div style={{ ...styles.input, background: "var(--flow-surface-2)", display: "flex", alignItems: "center", fontFamily: "monospace", fontSize: "clamp(11px, 1vw, 13px)" }}>
                    Your wallet ({walletAddress.slice(0, 6)}...{walletAddress.slice(-4)})
                  </div>
                </div>
                <button
                  style={styles.submitButton}
                  disabled={
                    crossLoading ||
                    !crossAmount ||
                    !fromChain ||
                    chains.length === 0 ||
                    (chainBalance !== null && parseFloat(crossAmount) > parseFloat(chainBalance))
                  }
                  onClick={handleCrossChain}
                >
                  {crossLoading
                    ? "Processing..."
                    : chains.length === 0
                      ? "Loading chains..."
                      : chainBalance !== null && parseFloat(crossAmount || "0") > parseFloat(chainBalance)
                        ? "Amount exceeds available balance"
                        : "Bridge to Arc"}
                </button>
              </div>
            )}

            {crossResult && (
              <div style={crossResult.success ? styles.resultSuccess : styles.resultError}>
                <p style={styles.resultIcon}>{crossResult.success ? "✓" : "!"}</p>
                <p style={styles.resultText}>{crossResult.success ? crossResult.message : crossResult.error}</p>
                {crossResult.explorerUrl && (
                  <a href={crossResult.explorerUrl} target="_blank" rel="noopener noreferrer" style={styles.resultLink}>
                    View transaction
                  </a>
                )}
                <button style={styles.doneButton} onClick={() => goTo("home")}>Done</button>
              </div>
            )}
              </>
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
            <span style={view === item.id ? styles.navItemActiveIcon : styles.navIcon}>{item.icon}</span>
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

  /* Light is the default/current Flow look. Dark matches the rest of the
     site's theme (same tones as merchant pages: near-black bg, warm dark
     card surfaces, cream text). Toggled via data-theme on the .flow-app
     root — nothing else in the component needs to re-render. */
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

  /* Desktop/tablet: the mobile-first single-column layout below still
     applies by default (nothing changes on small screens) — these rules
     only kick in once there's real horizontal space to use. */
  @media (min-width: 720px) {
    .flow-app {
      max-width: 720px !important;
      padding: 0 24px !important;
    }
  }
  @media (min-width: 1080px) {
    .flow-app {
      max-width: 1040px !important;
      padding: 0 40px !important;
    }
    .flow-actions-grid {
      grid-template-columns: repeat(2, 1fr) !important;
      gap: 16px !important;
    }
  }
`;

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
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
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
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  contentArea: { flex: 1, padding: "0 0 80px", overflowY: "auto" },
  hero: { padding: "20px 0 16px" },
  faucetBanner: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
    background: "#FCEFE2", border: "1px solid #F0D9BC", borderRadius: 14,
    padding: "14px 16px", margin: "0 0 16px",
  },
  faucetButton: {
    display: "inline-block", background: "#1C1B19", color: "#FBF8F3", fontSize: 13, fontWeight: 700,
    padding: "8px 14px", borderRadius: 10, textDecoration: "none", whiteSpace: "nowrap",
  },
  faucetDismiss: {
    background: "none", border: "none", color: "var(--flow-text-faint)", fontSize: 14, cursor: "pointer", padding: 4,
  },
  balanceCard: {
    background: "#1C1B19", color: "#FBF8F3", borderRadius: 18, padding: "20px 22px",
    margin: "0 0 16px", position: "relative",
  },
  refreshBalanceButton: {
    position: "absolute", top: 18, right: 20, background: "rgba(255,255,255,0.1)", color: "#FBF8F3",
    border: "none", borderRadius: 8, fontSize: 12, padding: "6px 10px", cursor: "pointer",
  },
  faucetCard: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
    background: "var(--flow-surface-2)", borderRadius: 14, padding: "14px 16px", margin: "0 0 20px",
  },
  faucetCardLink: {
    fontSize: 13, fontWeight: 700, color: "var(--flow-text)", textDecoration: "none", whiteSpace: "nowrap",
  },
  activityRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
    background: "var(--flow-surface-2)", borderRadius: 12, padding: "10px 14px",
  },
  eyebrow: { fontSize: "clamp(10px, 1vw, 12px)", color: "#5C7A5C", fontWeight: 600, letterSpacing: 1.5, textTransform: "uppercase", margin: "0 0 14px" },
  heroTitle: {
    fontFamily: "'Fraunces', serif",
    fontSize: "clamp(28px, 5vw, 34px)",
    lineHeight: 1.12,
    fontWeight: 500,
    margin: "0 0 16px",
    letterSpacing: -0.5,
  },
  heroSub: { fontSize: "clamp(14px, 1.5vw, 16px)", lineHeight: 1.55, color: "var(--flow-text-muted)", margin: 0, maxWidth: 440 },
  actionsGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 12, margin: "20px 0 24px" },
  actionCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 4,
    background: "var(--flow-surface)",
    border: "1px solid var(--flow-border)",
    borderRadius: 18,
    padding: "16px 18px",
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
    transition: "all 0.15s",
  },
  actionIconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    background: "rgba(232, 113, 74, 0.14)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
    flexShrink: 0,
  },
  actionIcon: { fontSize: "clamp(20px, 2.2vw, 24px)", lineHeight: 1 },
  actionLabel: { fontSize: "clamp(16px, 1.8vw, 18px)", fontWeight: 600 },
  actionSub: { fontSize: "clamp(12px, 1.2vw, 14px)", color: "var(--flow-text-faint)" },
  footnote: { textAlign: "center", fontSize: "clamp(10px, 1vw, 12px)", color: "var(--flow-text-faint)", margin: "8px 0" },
  flowCard: { paddingTop: 16 },
  flowTitle: { fontFamily: "'Fraunces', serif", fontSize: "clamp(22px, 4vw, 26px)", fontWeight: 500, margin: "0 0 20px" },
  flowLine: { display: "flex", alignItems: "center", gap: 0, marginBottom: 24 },
  flowDot: { width: 8, height: 8, borderRadius: "50%", background: "#5C7A5C", flexShrink: 0 },
  flowStroke: { flex: 1, height: 2, background: "linear-gradient(90deg, #5C7A5C, #E8714A)", margin: "0 6px" },
  form: { display: "flex", flexDirection: "column", gap: 16 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: "clamp(12px, 1.2vw, 14px)", fontWeight: 600, color: "var(--flow-text-muted)" },
  input: {
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid var(--flow-border)",
    background: "var(--flow-surface)",
    fontSize: "clamp(14px, 1.5vw, 16px)",
    color: "var(--flow-text)",
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
    border: "1px solid var(--flow-border)",
    background: "var(--flow-surface)",
    color: "var(--flow-text-muted)",
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
  flareWalletCard: {
    textAlign: "center" as const,
    background: "var(--flow-surface)",
    border: "1px solid var(--flow-border)",
    borderRadius: 18,
    padding: "28px 22px",
  },
  flareWalletIcon: { fontSize: 40, margin: "0 0 10px", lineHeight: 1 },
  flareWalletTitle: {
    fontFamily: "'Fraunces', serif",
    fontSize: "clamp(18px, 2vw, 21px)",
    fontWeight: 600,
    margin: "0 0 10px",
  },
  flareWalletText: {
    fontSize: "clamp(13px, 1.2vw, 15px)",
    lineHeight: 1.55,
    color: "var(--flow-text-muted)",
    margin: "0 0 18px",
  },
  selectWrap: { position: "relative", width: "100%" },
  select: {
    padding: "12px 40px 12px 14px",
    borderRadius: 12,
    border: "1px solid var(--flow-border)",
    background: "var(--flow-surface)",
    fontSize: "clamp(14px, 1.5vw, 16px)",
    color: "var(--flow-text)",
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
    width: "100%",
    appearance: "none" as const,
    WebkitAppearance: "none" as const,
    cursor: "pointer",
  },
  selectChevron: {
    position: "absolute",
    right: 14,
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: 14,
    color: "var(--flow-text-muted)",
    pointerEvents: "none" as const,
  },
  chainBalanceRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 4,
  },
  chainBalanceText: { fontSize: "clamp(12px, 1.1vw, 13px)", color: "var(--flow-text-muted)" },
  chainBalanceErrorText: { fontSize: "clamp(12px, 1.1vw, 13px)", color: "#C0563A" },
  chainBalanceRetry: {
    background: "none",
    border: "none",
    color: "#E8714A",
    fontSize: "clamp(12px, 1.1vw, 13px)",
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
  },
  maxButton: {
    background: "var(--flow-surface-2)",
    border: "1px solid var(--flow-border)",
    borderRadius: 8,
    fontSize: "clamp(11px, 1vw, 12px)",
    fontWeight: 700,
    color: "var(--flow-text)",
    padding: "4px 10px",
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
    background: "var(--flow-surface)",
    border: "1px solid #D6E2D6",
    borderRadius: 18,
  },
  resultError: {
    textAlign: "center",
    padding: "24px 16px",
    background: "var(--flow-surface)",
    border: "1px solid #F0D5C9",
    borderRadius: 18,
  },
  resultIcon: { fontSize: "clamp(24px, 3vw, 28px)", margin: "0 0 10px", color: "#5C7A5C" },
  resultText: { fontSize: "clamp(13px, 1.2vw, 15px)", margin: "0 0 14px", lineHeight: 1.5 },
  resultLink: { fontSize: "clamp(12px, 1vw, 13px)", color: "#E8714A", fontWeight: 600 },
  linkRow: {
    display: "flex",
    alignItems: "stretch",
    gap: 8,
    margin: "0 0 14px",
  },
  linkBox: {
    fontSize: "clamp(10px, 1vw, 12px)",
    fontFamily: "monospace",
    background: "var(--flow-surface-2)",
    padding: "8px 12px",
    borderRadius: 10,
    wordBreak: "break-all",
    flex: 1,
    minWidth: 0,
  },
  copyLinkButton: {
    flexShrink: 0,
    fontSize: "clamp(11px, 1vw, 13px)",
    fontWeight: 600,
    background: "#1C1B19",
    color: "#FBF8F3",
    border: "none",
    borderRadius: 10,
    padding: "8px 14px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  doneButton: {
    marginTop: 12,
    padding: "10px 24px",
    borderRadius: 12,
    border: "1px solid var(--flow-text)",
    background: "transparent",
    color: "var(--flow-text)",
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
    color: "var(--flow-text-muted)",
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
    border: "1px solid var(--flow-text)",
    background: "transparent",
    color: "var(--flow-text)",
    fontSize: "clamp(14px, 1.5vw, 16px)",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    marginTop: 12,
  },
  orDivider: { textAlign: "center", color: "var(--flow-text-faint)", fontSize: "clamp(12px, 1vw, 13px)", margin: "20px 0", position: "relative" },
  onboardingError: { color: "#C0563A", fontSize: "clamp(12px, 1vw, 13px)", marginTop: 8 },
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