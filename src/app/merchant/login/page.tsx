"use client";

import React, { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

export default function MerchantLogin() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/merchant/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      router.push("/merchant/dashboard");
    } catch (err: any) {
      setError(err.message || "Login failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", background: "#0e0b08", color: "#f0ece6", fontFamily: "Inter, system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>

        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <Image src="/arcflare-logo.png.png" alt="ArcFlare" width={52} height={52} style={{ borderRadius: 14, objectFit: "contain", marginBottom: 16 }} />
          <h1 style={{ fontSize: 26, fontWeight: 800, color: "#f0ece6", margin: "0 0 8px" }}>Merchant Login</h1>
          <p style={{ color: "#6b5a45", fontSize: 14, margin: 0 }}>Sign in to your ArcFlare merchant account.</p>
        </div>

        <div style={{ background: "#1a1410", border: "1px solid #2d2015", borderRadius: 24, padding: 36 }}>
          {error && (
            <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 12, padding: "12px 16px", marginBottom: 20 }}>
              <p style={{ color: "#f87171", fontSize: 13, margin: 0 }}>❌ {error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={{ display: "block", color: "#8a7560", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Email Address</label>
              <input
                type="email"
                placeholder="you@business.com"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                required
                style={{ width: "100%", background: "#251c12", border: "1px solid #3d2e1a", borderRadius: 10, padding: "12px 14px", color: "#f0ece6", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ display: "block", color: "#8a7560", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Password</label>
              <input
                type="password"
                placeholder="Your password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                required
                style={{ width: "100%", background: "#251c12", border: "1px solid #3d2e1a", borderRadius: 10, padding: "12px 14px", color: "#f0ece6", fontSize: 14, outline: "none", boxSizing: "border-box" }}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{ marginTop: 8, padding: "14px", background: loading ? "rgba(200,151,90,0.3)" : "#c8975a", color: loading ? "rgba(14,11,8,0.5)" : "#0e0b08", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", transition: "all 0.15s" }}
            >
              {loading ? "Signing in..." : "Sign In →"}
            </button>
          </form>

          <p style={{ textAlign: "center", marginTop: 20, color: "#4b4035", fontSize: 13 }}>
            No account yet?{" "}
            <a href="/merchant/signup" style={{ color: "#c8975a", textDecoration: "none", fontWeight: 600 }}>Create one free</a>
          </p>
        </div>
      </div>
    </main>
  );
}
