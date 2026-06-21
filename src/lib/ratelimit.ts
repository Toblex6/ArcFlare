// src/lib/ratelimit.ts
// Rate limiting middleware using Upstash Redis.
// Falls back gracefully if env vars are not set (dev/testnet mode).

import { NextRequest, NextResponse } from 'next/server';

// ── In-memory fallback store for when Upstash is not configured ──────────────
const memoryStore = new Map<string, { count: number; resetAt: number }>();

function memoryRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
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

// ── Rate limit configs per route type ────────────────────────────────────────
export const RATE_LIMITS = {
  payments: { limit: 30, windowMs: 60_000 }, // 30 requests per minute
  agent: { limit: 10, windowMs: 60_000 }, // 10 deploys per minute
  keys: { limit: 5, windowMs: 60_000 }, // 5 key ops per minute
  escrow: { limit: 20, windowMs: 60_000 }, // 20 escrow ops per minute
  stream: { limit: 20, windowMs: 60_000 }, // 20 stream ops per minute
  nano: { limit: 100, windowMs: 60_000 }, // 100 nano calls per minute
  default: { limit: 50, windowMs: 60_000 }, // fallback
} as const;

type RateLimitType = keyof typeof RATE_LIMITS;

// ── Main rate limit function ──────────────────────────────────────────────────
export async function checkRateLimit(
  req: NextRequest,
  type: RateLimitType = 'default'
): Promise<{ allowed: boolean; response?: NextResponse }> {
  const config = RATE_LIMITS[type];

  // Get identifier — prefer API key, fall back to IP
  const apiKey = req.headers.get('x-api-key') || '';
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
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
