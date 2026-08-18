// src/lib/auth/consumerSession.ts
// Single source of truth for consumer_token JWT issuance — the web
// consumer login flow (src/app/api/consumer/session/route.ts) and the
// Telegram bot (src/lib/telegram/telegramAuth.ts) both call this. Never
// reimplement signing anywhere else: the fail-closed CONSUMER_JWT_SECRET
// requirement (requireJwtSecret) lives here, so no token can be minted
// with a missing or short secret.

import { SignJWT } from 'jose';
import { requireJwtSecret } from '@/src/lib/auth/secrets';

export async function issueConsumerSessionToken(
  consumerId: string,
  walletAddress: string
): Promise<string> {
  const JWT_SECRET = requireJwtSecret('CONSUMER_JWT_SECRET');
  return new SignJWT({ consumerId, walletAddress })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(JWT_SECRET);
}