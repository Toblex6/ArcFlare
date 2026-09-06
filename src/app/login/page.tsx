"use client";

// src/app/login/page.tsx
//
// /login is NOT a real login page — it is a thin redirect shim so the
// public-browse login gate (see src/lib/auth/returnTo.ts) has a stable,
// auth-system-agnostic entry point: /login?returnTo=<path> forwards to the
// merchant login, which reads the same returnTo after sign-in. Browsing
// stays public everywhere; only authenticated ACTIONS gate through here.
//
// If consumer-side gated actions need this later, make the shim
// auth-system-aware HERE (consumer_token vs merchant_token are separate
// cookie auth systems) rather than adding a second gate helper.

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginRedirect() {
    const router = useRouter();
    const params = useSearchParams();

    useEffect(() => {
        const raw = params.get("returnTo") || "/marketplace";
        // Only same-origin relative paths are honoured.
        const returnTo = raw.startsWith("/") ? raw : "/marketplace";
        router.replace(`/merchant/login?returnTo=${encodeURIComponent(returnTo)}`);
    }, [params, router]);

    return (
        <main
            style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--background)",
                color: "var(--text-secondary)",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 14,
            }}
        >
            Redirecting to sign in…
        </main>
    );
}

// useSearchParams forces client-side rendering — wrap in Suspense so the rest
// of the route can still prerender.
export default function LoginPage() {
    return (
        <Suspense fallback={null}>
            <LoginRedirect />
        </Suspense>
    );
}