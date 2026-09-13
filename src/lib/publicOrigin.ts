// src/lib/publicOrigin.ts
//
// Canonical public origin — the single authority for absolute URLs the app
// sends OUT (checkout links, escrow links/confirmations, QR codes, agent
// card baseUrl). NEXT_PUBLIC_BASE_URL is canonical; NEXT_PUBLIC_API_BASE is
// the legacy alias (kept only so existing deploys that set just one keep
// working). Local dev falls back to http://localhost:3000; production FAILS
// CLOSED instead of silently stamping links with a wrong domain.

/**
 * Resolve the canonical public origin (no trailing slash).
 * - NEXT_PUBLIC_BASE_URL wins; NEXT_PUBLIC_API_BASE is the legacy fallback.
 * - Local dev (NODE_ENV !== 'production'): http://localhost:3000 fallback.
 * - Production without either var: throws fail-closed.
 */
export function getPublicOrigin(
  env: Record<string, string | undefined> = process.env
): string {
  const trim = (v: string | undefined): string => (v ?? '').trim().replace(/\/+$/, '');
  const base = trim(env.NEXT_PUBLIC_BASE_URL);
  const legacy = trim(env.NEXT_PUBLIC_API_BASE);
  const origin = base || legacy;
  if (origin) {
    if (!/^https?:\/\//.test(origin)) {
      throw new Error(
        'NEXT_PUBLIC_BASE_URL must be an absolute URL (got a bare host/path). Set e.g. https://flarehq.xyz.'
      );
    }
    return origin;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_BASE_URL is required in production — refusing to stamp outbound links with a fallback domain.'
    );
  }
  return 'http://localhost:3000';
}

/** `${origin}/<path>` joiner (path may carry a leading slash or not). */
export function publicUrl(path: string, env: Record<string, string | undefined> = process.env): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${getPublicOrigin(env)}${clean}`;
}
