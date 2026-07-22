// src/lib/internalUrl.ts
// Build a URL for server-to-server calls back into this same Next.js
// instance (e.g. the assistant route composing initialize -> settle).
//
// Why not `new URL(path, req.url)`? On Render (and most single-instance
// PaaS hosts), that resolves to the app's *public* https:// origin, so the
// request leaves the box, goes through Render's edge/TLS termination, and
// comes back in — an unnecessary network hop that is a known source of
// intermittent `TypeError: fetch failed` / `ERR_SSL_PACKET_LENGTH_TOO_LONG`
// errors when a server process calls its own public hostname.
//
// Instead, talk to the local port directly over plain HTTP — it's the same
// process, so there's nothing to encrypt.
export function internalUrl(path: string): string {
    const port = process.env.PORT || '3000';
    return `http://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`;
}
