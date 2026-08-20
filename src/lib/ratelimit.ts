// src/lib/ratelimit.ts
// Rate limiting middleware using Upstash Redis.
// Falls back gracefully if env vars are not set (dev/testnet mode).

import { NextRequest, NextResponse } from 'next/server';

// ── In-memory fallback store for when Upstash is not configured ──────────────
// Bounded (H12): at most MAX_MEMORY_ENTRIES keys are retained; expired
// entries are pruned on insert and the oldest entries are dropped once the
// cap is reached, so a distributed-call flood can't grow memory forever.
const MAX_MEMORY_ENTRIES = 10_000;
const memoryStore = new Map<string, { count: number; resetAt: number }>();

function pruneMemoryStore(now: number): void {
  if (memoryStore.size < MAX_MEMORY_ENTRIES) return;
  for (const [key, record] of memoryStore) {
    if (now > record.resetAt) {
      memoryStore.delete(key);
      if (memoryStore.size < MAX_MEMORY_ENTRIES) break;
    }
  }
  while (memoryStore.size > MAX_MEMORY_ENTRIES) {
    const oldest = memoryStore.keys().next().value;
    if (oldest === undefined) break;
    memoryStore.delete(oldest);
  }
}

function memoryRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  pruneMemoryStore(now);
  const record = memoryStore.get(key);

  if (!record || now > record.resetAt) {
    memoryStore.set(key, { count: 1, resetAt: now + windowMs });
    return true; // allowed
  }

  if (record.count >= limit) {
    return false; // blocked
  }

  record.count += 1;
  return true; // allowed
}

/**
 * H12 — trusted caller identity. The client-supplied X-Forwarded-For header
 * is trivially spoofable (any attacker can cycle values to rotate identity
 * and reset every limit), so it is NEVER trusted as the primary key. The
 * platform-provided connection IP (req.ip) is authoritative when present;
 * the first XFF hop is used only as a last resort and is documented as
 * spoofable (dev-mode proxy setups without req.ip).
 */
function callerIdentity(req: NextRequest): string {
  const ip = (req as any).ip;
  if (typeof ip === "string" && ip.length > 0) return ip;
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  return "unknown";
}

// ── Rate limit configs per route type ────────────────────────────────────────
export const RATE_LIMITS = {
  payments: { limit: 30, windowMs: 60_000 }, // 30 requests per minute
  agent: { limit: 10, windowMs: 60_000 }, // 10 deploys per minute
  keys: { limit: 5, windowMs: 60_000 }, // 5 key ops per minute
  escrow: { limit: 20, windowMs: 60_000 }, // 20 escrow ops per minute
  stream: { limit: 20, windowMs: 60_000 }, // 20 stream ops per minute
  nano: { limit: 100, windowMs: 60_000 }, // 100 nano calls per minute
  withdraw: { limit: 5, windowMs: 60_000 }, // 5 withdrawal attempts per minute
  session: { limit: 10, windowMs: 60_000 }, // 10 consumer session ops per minute (M11 wallet-creation quota)
  default: { limit: 50, windowMs: 60_000 }, // fallback
} as const;

type RateLimitType = keyof typeof RATE_LIMITS;

// ── Main rate limit function ──────────────────────────────────────────────────
export async function checkRateLimit(
  req: NextRequest,
  type: RateLimitType = 'default'
): Promise<{ allowed: boolean; response?: NextResponse }> {
  const config = RATE_LIMITS[type];

  // Get identifier — prefer API key (a bearer secret an attacker cannot
  // spoof), fall back to the TRUSTED connection identity (H12: req.ip, not
  // the client-supplied X-Forwarded-For header, which is freely spoofable).
  const apiKey = req.headers.get('x-api-key') || '';
  const ip = callerIdentity(req);
  const identifier = apiKey ? `key:${apiKey}` : `ip:${ip}`;
  const key = `rl:${type}:${identifier}`;

  // Try Upstash if configured
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Ratelimit } = await import('@upstash/ratelimit');
      const { Redis } = await import('@upstash/redis');

      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });

      const ratelimit = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(config.limit, `${config.windowMs / 1000} s`),
        prefix: 'arcflare',
      });

      const { success, remaining, reset } = await ratelimit.limit(key);

      if (!success) {
        return {
          allowed: false,
          response: NextResponse.json(
            {
              success: false,
              error: 'Rate limit exceeded. Too many requests.',
              retryAfter: Math.ceil((reset - Date.now()) / 1000),
            },
            {
              status: 429,
              headers: {
                'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
                'X-RateLimit-Limit': String(config.limit),
                'X-RateLimit-Remaining': String(remaining),
              },
            }
          ),
        };
      }

      return { allowed: true };
    } catch (err) {
      console.warn('Upstash rate limit error — falling back to memory:', err);
    }
  }

  // Memory fallback
  const allowed = memoryRateLimit(key, config.limit, config.windowMs);

  if (!allowed) {
    return {
      allowed: false,
      response: NextResponse.json(
        { success: false, error: 'Rate limit exceeded. Too many requests.' },
        { status: 429 }
      ),
    };
  }

  return { allowed: true };
}
