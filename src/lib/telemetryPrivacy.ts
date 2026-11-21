// Defense in depth: custom step-up headers are not part of SDK default deny
// lists. Strip request payloads/headers before errors, traces or breadcrumbs
// leave any runtime. Security routes never send error/transaction payloads.
const secretKey = /^(?:pin|newpin|confirmpin|currentpin|oldpin|pinhash|code|codehash|otp|password|authorization|cookie|cookies|setcookie|headers|body|requestbody|data)$/i;
const privateRoute = /\/api\/consumer\/(?:pin|email|recover)(?:[/?-]|$)/i;

export function scrubTelemetry<T>(value: T): T {
  function scrub(input: unknown, depth: number): unknown {
    if (depth > 12) return '[Redacted]';
    if (Array.isArray(input)) return input.map((entry) => scrub(entry, depth + 1));
    if (!input || typeof input !== 'object') return input;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      const normalized = key.replace(/[^a-z]/gi, '');
      result[key] = secretKey.test(normalized) || /(?:xconsumerpin|pinhash)$/i.test(normalized)
        ? '[Redacted]' : scrub(item, depth + 1);
    }
    return result;
  }
  return scrub(value, 0) as T;
}

export function filterPrivateEvent<T extends { request?: { url?: string }; transaction?: string }>(event: T): T | null {
  if (privateRoute.test(event.request?.url ?? '') || privateRoute.test(event.transaction ?? '')) return null;
  return scrubTelemetry(event);
}
