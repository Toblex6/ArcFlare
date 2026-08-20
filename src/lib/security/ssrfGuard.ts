// src/lib/security/ssrfGuard.ts
//
// Server-Side Request Forgery guard for user-supplied upstream URLs (the
// marketplace `targetUrl` and `docsUrl` fields). The pay route proxies the
// buyer's request to `targetUrl` with our server credentials/IP — without
// validation an attacker could point it at http://169.254.169.254 (cloud
// metadata), http://localhost, or an internal 10.x service.
//
// Rules (all of them, not an or):
//   1. protocol MUST be https:
//   2. hostname must not be localhost / *.localhost / *.local / *.internal
//   3. hostname must not be a loopback / private / link-local / metadata /
//      reserved IP literal
//   4. DNS rebinding: resolve the hostname; if ANY resolved address is in a
//      blocked range, reject (even if the first record is a clean public IP)
//
// Applied at listing creation AND at proxy time (defense in depth against a
// DB-poisoned row), plus at publish-time reachability.

import { lookup } from "dns/promises";
import { isIP } from "net";

const BLOCKED_HOSTNAMES = new Set(["localhost"]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // private
  "100.64.0.0/10", // CGNAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local incl. 169.254.169.254 cloud metadata
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmark
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved
];

function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_IPV4_CIDRS.some((cidr) => ipv4InCidr(ip, cidr));
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // IPv4-mapped / NAT64-embedded IPv4 — check the embedded v4.
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) return isBlockedIpv4(mappedMatch[1]);
  const nat64Match = normalized.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (nat64Match) return isBlockedIpv4(nat64Match[1]);

  if (normalized === "::" || normalized === "::1") return true; // unspecified / loopback
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7 ULA
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // fe80::/10 link-local
  if (normalized.startsWith("ff")) return true; // ff00::/8 multicast
  if (normalized.startsWith("2001:db8")) return true; // documentation range
  return false;
}

function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // unparseable IP — treat as blocked
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  return false;
}

/**
 * Validates a user-supplied URL for outbound proxying. Resolves the
 * hostname to catch DNS rebinding (an attacker DNS record that alternates
 * between a public IP and 127.0.0.1). Async — call from request handlers.
 */
export async function assertSafeTargetUrl(
  rawUrl: string
): Promise<{ ok: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "only https:// URLs are allowed for upstream targets" };
  }

  const hostname = parsed.hostname;
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: `hostname ${hostname} is blocked (internal/local target)` };
  }

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      return { ok: false, reason: `IP literal ${hostname} is in a blocked range` };
    }
    return { ok: true };
  }

  // DNS rebinding guard: resolve every address; ANY blocked record rejects.
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dns timeout")), 5000)),
    ]);
    for (const { address } of addresses) {
      if (isBlockedIp(address)) {
        return { ok: false, reason: `hostname ${hostname} resolves to blocked address ${address}` };
      }
    }
  } catch (err: any) {
    return { ok: false, reason: `DNS lookup failed for ${hostname}: ${err?.message ?? "unknown"}` };
  }

  return { ok: true };
}