import React, { useState, CSSProperties } from "react";

interface Category {
  id: "bug" | "feature" | "ux" | "praise" | "other";
  emoji: string;
  label: string;
}

const CATEGORIES: Category[] = [
  { id: "bug",     emoji: "🪲", label: "Bug Report" },
  { id: "feature", emoji: "💡", label: "Feature Request" },
  { id: "ux",      emoji: "🎨", label: "UI / UX Feedback" },
  { id: "praise",  emoji: "⭐", label: "Praise" },
  { id: "other",   emoji: "💬", label: "Other" },
];

export default function FlowFiFeedback() {
  const [open, setOpen]         = useState<boolean>(false);
  const [category, setCategory] = useState<Category["id"]>("feature");
  const [rating, setRating]     = useState<number>(0);
  const [hovered, setHovered]   = useState<number>(0);
  const [message, setMessage]   = useState<string>("");
  const [email, setEmail]       = useState<string>("");
  const [sent, setSent]         = useState<boolean>(false);
  const [sending, setSending]   = useState<boolean>(false);

  const handleSubmit = async (): Promise<void> => {
    if (!message.trim()) return;
    setSending(true);

    try {
      // ── Optional: Wire up to ArcFlare API Endpoint if needed ──────────────
      // await fetch("/api/feedback", {
      //   method: "POST",
      //   headers: { "Content-Type": "application/json" },
      //   body: JSON.stringify({ category, rating, message, email }),
      // });
      await new Promise((r) => setTimeout(r, 900)); // simulates network delay
      setSent(true);
    } catch (error) {
      console.error("Failed to submit feedback:", error);
    } finally {
      setSending(false);
    }
  };

  const handleClose = (): void => {
    setOpen(false);
    setTimeout(() => {
      setSent(false);
      setCategory("feature");
      setRating(0);
      setHovered(0);
      setMessage("");
      setEmail("");
    }, 300);
  };

  return (
    <>
      {/* ── Floating trigger button ── */}
      <button
        onClick={() => setOpen(true)}
        style={styles.fab}
        aria-label="Send Feedback"
      >
        💬
      </button>

      {/* ── Backdrop overlay ── */}
      {open && (
        <div style={styles.backdrop} onClick={handleClose}>
          {/* ── Modal Card ── */}
          <div
            style={styles.modal}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-title"
          >
            {sent ? (
              /* ── Success State ── */
              <div style={styles.successWrap}>
                <div style={styles.successIcon}>✓</div>
                <h2 style={styles.successTitle}>Thanks for the feedback!</h2>
                <p style={styles.successSub}>
                  We read every submission and use it to improve ArcFlare.
                </p>
                <button style={styles.closeBtn} onClick={handleClose}>
                  Close
                </button>
              </div>
            ) : (
              <>
                {/* ── Header ── */}
                <div style={styles.header}>
                  <div>
                    <p style={styles.eyebrow}>SHARE YOUR THOUGHTS</p>
                    <h2 id="feedback-title" style={styles.title}>
                      Send Feedback
                    </h2>
                  </div>
                  <button
                    style={styles.xBtn}
                    onClick={handleClose}
                    aria-label="Close"
                  >
                    ×
                  </button>
                </div>

                {/* ── Category pills ── */}
                <label style={styles.label}>CATEGORY</label>
                <div style={styles.pills}>
                  {CATEGORIES.map((c) => {
                    const isActive = category === c.id;
                    return (
                      <button
                        key={c.id}
                        style={{
                          ...styles.pill,
                          ...(isActive ? styles.pillActive : {}),
                        }}
                        onClick={() => setCategory(c.id)}
                      >
                        {c.emoji} {c.label}
                      </button>
                    );
                  })}
                </div>

                {/* ── Star rating ── */}
                <label style={styles.label}>OVERALL EXPERIENCE</label>
                <div style={styles.stars}>
                  {([1, 2, 3, 4, 5] as const).map((n) => (
                    <button
                      key={n}
                      style={{
                        ...styles.star,
                        color: n <= (hovered || rating) ? "#c8f135" : "#3a4a3a",
                      }}
                      onMouseEnter={() => setHovered(n)}
                      onMouseLeave={() => setHovered(0)}
                      onClick={() => setRating(n)}
                      aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`}
                    >
                      ★
                    </button>
                  ))}
                </div>

                {/* ── Message Textarea ── */}
                <label style={styles.label}>
                  YOUR MESSAGE <span style={{ color: "#c8f135" }}>*</span>
                </label>
                <textarea
                  style={styles.textarea}
                  placeholder="Tell us what you think, what broke, or what you wish existed..."
                  maxLength={1000}
                  value={message}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setMessage(e.target.value)}
                />
                <p style={styles.charCount}>{message.length}/1000</p>

                {/* ── Email Field ── */}
                <label style={styles.label}>
                  EMAIL{" "}
                  <span style={{ color: "#5a7a5a", fontWeight: 400 }}>
                    (optional — for follow-up)
                  </span>
                </label>
                <input
                  type="email"
                  style={styles.input}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                />

                {/* ── Submit Button ── */}
                <button
                  style={{
                    ...styles.submitBtn,
                    opacity: !message.trim() || sending ? 0.5 : 1,
                    cursor: !message.trim() || sending ? "not-allowed" : "pointer",
                  }}
                  onClick={handleSubmit}
                  disabled={!message.trim() || sending}
                >
                  {sending ? (
                    <span style={styles.spinner} />
                  ) : (
                    <>✈ Send Feedback</>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Scoped CSS animations to safeguard local layout integrity */}
      <style>{`
        @keyframes flowfiFadeIn {
          from { opacity: 0; transform: scale(0.96) translateY(8px); }
          to   { opacity: 1; transform: scale(1)    translateY(0);   }
        }
        @keyframes flowfiSpin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}

/* ── Inline FlowFi Themed Layout Styles ────────────────────────────────── */
const styles: Record<string, CSSProperties> = {
  fab: {
    position: "fixed",
    bottom: 24,
    right: 24,
    zIndex: 999999, // Unbreakable z-index layer so it floats above everything
    width: 52,
    height: 52,
    borderRadius: "50%",
    background: "linear-gradient(135deg, #c8f135 0%, #7ec800 100%)",
    border: "none",
    cursor: "pointer",
    fontSize: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 0 0 4px rgba(200,241,53,0.15), 0 4px 20px rgba(0,0,0,0.4)",
    transition: "transform 0.2s ease",
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1000000, // Sits exactly on top of the button layer when active
    background: "rgba(0,0,0,0.65)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modal: {
    background: "#141f14",
    border: "1px solid #2a3d2a",
    borderRadius: 16,
    padding: "28px 28px 24px",
    width: "100%",
    maxWidth: 460,
    boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
    animation: "flowfiFadeIn 0.22s ease",
    position: "relative",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
  },
  eyebrow: {
    fontSize: 10,
    letterSpacing: "0.12em",
    color: "#5a7a5a",
    margin: "0 0 4px",
    fontFamily: "monospace",
  },
  title: {
    margin: 0,
    fontSize: 22,
    fontWeight: 700,
    color: "#e8f5d0",
    fontFamily: "'Segoe UI', sans-serif",
  },
  xBtn: {
    background: "none",
    border: "1px solid #2a3d2a",
    color: "#5a7a5a",
    borderRadius: 8,
    width: 32,
    height: 32,
    cursor: "pointer",
    fontSize: 18,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    display: "block",
    fontSize: 10,
    letterSpacing: "0.1em",
    color: "#5a7a5a",
    fontFamily: "monospace",
    fontWeight: 600,
    marginBottom: 8,
  },
  pills: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 20,
  },
  pill: {
    padding: "6px 12px",
    borderRadius: 999,
    border: "1px solid #2a3d2a",
    background: "#1a2a1a",
    color: "#8aaa6a",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all 0.15s ease",
  },
  pillActive: {
    background: "rgba(200,241,53,0.15)",
    border: "1px solid #c8f135",
    color: "#c8f135",
  },
  stars: {
    display: "flex",
    gap: 6,
    marginBottom: 20,
  },
  star: {
    background: "none",
    border: "none",
    fontSize: 26,
    cursor: "pointer",
    padding: 2,
    lineHeight: 1,
    transition: "color 0.1s ease",
  },
  textarea: {
    width: "100%",
    minHeight: 100,
    background: "#1a2a1a",
    border: "1px solid #2a3d2a",
    borderRadius: 10,
    color: "#e8f5d0",
    padding: "12px 14px",
    fontSize: 14,
    resize: "vertical",
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box",
  },
  charCount: {
    textAlign: "right",
    fontSize: 11,
    color: "#3a5a3a",
    margin: "4px 0 16px",
    fontFamily: "monospace",
  },
  input: {
    width: "100%",
    background: "#1a2a1a",
    border: "1px solid #2a3d2a",
    borderRadius: 10,
    color: "#e8f5d0",
    padding: "10px 14px",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box",
    marginBottom: 20,
  },
  submitBtn: {
    width: "100%",
    padding: "13px",
    borderRadius: 10,
    background: "linear-gradient(135deg, #1e3a1e 0%, #2a4a2a 100%)",
    border: "1px solid #3a6a3a",
    color: "#c8f135",
    fontSize: 14,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    fontFamily: "inherit",
    transition: "opacity 0.2s ease",
  },
  spinner: {
    width: 16,
    height: 16,
    border: "2px solid #3a6a3a",
    borderTopColor: "#c8f135",
    borderRadius: "50%",
    display: "inline-block",
    animation: "flowfiSpin 0.7s linear infinite",
  },
  successWrap: {
    textAlign: "center",
    padding: "16px 0",
  },
  successIcon: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    background: "rgba(200,241,53,0.15)",
    border: "2px solid #c8f135",
    color: "#c8f135",
    fontSize: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 16px",
  },
  successTitle: {
    color: "#e8f5d0",
    fontSize: 20,
    fontWeight: 700,
    margin: "0 0 8px",
  },
  successSub: {
    color: "#5a7a5a",
    fontSize: 14,
    margin: "0 0 24px",
  },
  closeBtn: {
    padding: "10px 28px",
    borderRadius: 10,
    background: "rgba(200,241,53,0.15)",
    border: "1px solid #c8f135",
    color: "#c8f135",
    fontSize: 14,
    cursor: "pointer",
    fontFamily: "inherit",
  },
};