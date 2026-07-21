// src/lib/middleware/withConsumerAuth.ts
import { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const CONSUMER_JWT_SECRET = new TextEncoder().encode(
  process.env.CONSUMER_JWT_SECRET || 'flarehq-consumer-secret-change-on-mainnet'
);

export async function resolveConsumerSession(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get('consumer_token')?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, CONSUMER_JWT_SECRET);
    return payload.walletAddress as string;
  } catch {
    return null;
  }
}