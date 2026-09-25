// src/lib/middleware/withConsumerAuth.ts
import { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { tryJwtSecret } from '@/lib/auth/secrets';
import { CONSUMER_SESSION_AUDIENCE } from '@/src/lib/auth/consumerSession';

// Fail closed: no secret configured -> no session -> 401. There is no
// fallback secret that would silently mint/accept tokens.
//
// M4: DB-bound resolver with sessionVersion parity (mirrors the
// merchant-side fix in withMerchantAuth sessionVersionMatches). The token's
// sessionVersion claim must equal the account's CURRENT sessionVersion;
// tokens without the claim (pre-M4) or from before a bump (recovery /
// credential change) are rejected, so a stolen cookie dies on revocation.
// aud is enforced too.
export async function resolveConsumerSession(req: NextRequest): Promise<string | null> {
  const CONSUMER_JWT_SECRET = tryJwtSecret('CONSUMER_JWT_SECRET');
  if (!CONSUMER_JWT_SECRET) return null;
  const token = req.cookies.get('consumer_token')?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, CONSUMER_JWT_SECRET, {
      audience: CONSUMER_SESSION_AUDIENCE,
    });
    const walletAddress = payload.walletAddress as string;
    if (!walletAddress) return null;
    const { prisma } = await import('@/src/lib/prisma');
    const account = await (prisma as any).consumerAccount
      .findUnique({ where: { walletAddress } })
      .catch(() => null);
    if (!account) return null;
    const expected = (account as any).sessionVersion ?? 0;
    if ((payload as any)?.sessionVersion !== expected) return null;
    return walletAddress;
  } catch {
    return null;
  }
}
