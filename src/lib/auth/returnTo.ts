// src/lib/auth/returnTo.ts
//
// Shared client-side "returnTo" handling for the public-browse login gate
// (Track A): pages that are publicly browsable but embed authenticated
// actions check session state client-side and redirect to
// /login?returnTo=<current path> instead of letting the API call fail with
// an unexplained 401. /login is a redirect shim (src/app/login/page.tsx)
// onto the real sign-in page, so the gate stays auth-system-agnostic.
//
// NOTE: consumer_token and merchant_token are separate JWT cookie auth
// systems — never conflate them. If this gate is later reused from
// consumer-facing pages, make the shim auth-system-aware there rather than
// adding a second gate helper.

export function deriveReturnTo(fallbackPath = "/marketplace"): string {
    if (typeof window === "undefined") return fallbackPath;
    const { pathname, search } = window.location;
    return `${pathname}${search}` || fallbackPath;
}

// Build the /login gate URL. returnTo is always normalised to a same-origin
// relative path — it must never point off-site.
export function loginRedirectUrl(returnTo: string): string {
    const safe = returnTo.startsWith("/") ? returnTo : `/${returnTo}`;
    return `/login?returnTo=${encodeURIComponent(safe)}`;
}