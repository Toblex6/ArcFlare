// src/lib/auth/consumerSession.ts
// Single source of truth for consumer_token JWT issuance — the web
// consumer login flow (src/app/api/consumer/session/route.ts) and the
// Telegram bot (src/lib/telegram/telegramAuth.ts) both call this. Never
// reimplement signing anywhere else: the fail-closed CONSUMER_JWT_SECRET
// requirement (requireJwtSecret) lives here, so no token can be minted
// with a missing or short secret.
//
// M4: tokens carry sessionVersion + aud claims (mirroring the merchant-side
// fix). The resolver (withConsumerAuth) DB-binds and rejects stale versions,
// so bumping ConsumerAccount.sessionVersion (recovery / credential change)
// kills stolen cookies immediately. Tokens issued before this claim existed
// are rejected (fail closed).

import { SignJWT } from 'jose';
import { requireJwtSecret } from '@/src/lib/auth/secrets';

export const CONSUMER_SESSION_AUDIENCE = 'consumer-session';

export async function issueConsumerSessionToken(
  consumerId: string,
  walletAddress: string,
  sessionVersion: number = 0
): Promise<string> {
  const JWT_SECRET = requireJwtSecret('CONSUMER_JWT_SECRET');
  return new SignJWT({ consumerId, walletAddress, sessionVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setAudience(CONSUMER_SESSION_AUDIENCE)
    .setExpirationTime('30d')
    .sign(JWT_SECRET);
}

// M4 revocation: bump to invalidate all existing consumer_token cookies for
// this wallet (call on recovery / email change / suspected theft).
export async function bumpConsumerSessionVersion(walletAddress: string): Promise<number> {
  const { prisma } = await import('@/src/lib/prisma');
  const updated = await (prisma as any).consumerAccount.update({
    where: { walletAddress },
    data: { sessionVersion: { increment: 1 } },
  });
  return (updated as any).sessionVersion as number;
}
