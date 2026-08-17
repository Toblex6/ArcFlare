// src/lib/middleware/withConsumerAuth.ts
import { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { tryJwtSecret } from '@/lib/auth/secrets';

// Fail closed: no secret configured -> no session -> 401. There is no
// fallback secret that would silently mint/accept tokens.
export async function resolveConsumerSession(req: NextRequest): Promise<string | null> {
  const CONSUMER_JWT_SECRET = tryJwtSecret('CONSUMER_JWT_SECRET');
  if (!CONSUMER_JWT_SECRET) return null;
  const token = req.cookies.get('consumer_token')?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, CONSUMER_JWT_SECRET);
    return payload.walletAddress as string;
  } catch {
    return null;
  }
}