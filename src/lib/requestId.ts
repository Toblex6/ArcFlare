// src/lib/requestId.ts
//
// Tiny request-correlation helper for server-side error logs (Phase 5).
// Reads an incoming `x-request-id` header when present and well-formed,
// otherwise mints a short random id. The id carries NO sensitive data —
// it is only echoed in console.* lines so an operator can correlate the
// log lines of a single failed request across routes/helpers.
//
// Deliberately NOT middleware: there is no src/middleware.ts in this repo,
// and adding one would risk changing auth/rate-limit behavior globally.
// Call getRequestId(req) at the top of a route handler and include `req=`
// in that handler's error/warn logs.

function mint(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return (crypto as any).randomUUID().slice(0, 8);
    }
  } catch {
    // fall through to Math.random
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getRequestId(req: { headers: { get(name: string): string | null } }): string {
  try {
    const incoming = req.headers.get('x-request-id')?.trim() ?? '';
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(incoming)) return incoming;
  } catch {
    // header read failed — mint below
  }
  return mint();
}
