// src/app/api/consumer/session/route.ts
// Wallet-first consumer auth — no email/password. A wallet address IS the
// account. Session is a signed JWT cookie, same pattern as merchant auth.
//
// SECURITY: connecting an EXISTING wallet now requires proof of ownership.
// A body-supplied address is no longer accepted as identity — the caller
// must complete the same two-step nonce challenge + signature flow the
// merchant wallet-connect route uses (src/app/api/merchant/wallet/connect):
//
//   1. GET /api/consumer/session?nonce=1&address=0x…  -> challenge message
//      + short-lived httpOnly nonce cookie (5 minutes).
//   2. POST /api/consumer/session with { walletAddress, message, signature }
//      -> viem verifyMessage against the nonce cookie, then a session JWT.
//
// Creating a brand-new Circle-managed wallet (empty body) is unchanged:
// the address comes from Circle's own response, never from the client.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { SignJWT, jwtVerify } from 'jose';
import { isAddress, verifyMessage } from 'viem';
import { randomBytes } from 'crypto';
import { createAccountWallet } from '@/src/lib/circle/client';
import { requireJwtSecret, tryJwtSecret } from '@/src/lib/auth/secrets';

const NONCE_COOKIE = 'consumer_connect_nonce';

function buildChallengeMessage(domain: string, address: string, nonce: string): string {
  const issuedAt = new Date().toISOString();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    ``,
    `Sign in to FlareHQ consumer app.`,
    ``,
    `URI: https://${domain}`,
    `Version: 1`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

async function issueSession(account: { id: string; walletAddress: string }) {
  const JWT_SECRET = requireJwtSecret('CONSUMER_JWT_SECRET');
  const token = await new SignJWT({
    consumerId: account.id,
    walletAddress: account.walletAddress,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(JWT_SECRET);

  const response = NextResponse.json({
    success: true,
    account: { id: account.id, walletAddress: account.walletAddress },
  });

  response.cookies.set('consumer_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });

  return response;
}

// GET /api/consumer/session
//   no params         -> check for an existing session (page load)
//   ?nonce=1&address= -> issue a signature challenge (step 1 of connect)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get('address');

    if (address) {
      const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
      if (!allowed) return limitResponse;

      if (!isAddress(address)) {
        return NextResponse.json(
          { success: false, error: 'Not a valid wallet address.' },
          { status: 400 }
        );
      }

      const nonce = randomBytes(16).toString('hex');
      const domain = req.headers.get('host') || 'flarehq.xyz';
      const message = buildChallengeMessage(domain, address, nonce);

      const res = NextResponse.json({ success: true, message });
      res.cookies.set(NONCE_COOKIE, nonce, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 300,
        path: '/',
      });
      return res;
    }

    const JWT_SECRET = tryJwtSecret('CONSUMER_JWT_SECRET');
    if (!JWT_SECRET) {
      return NextResponse.json(
        { success: false, error: 'Consumer auth is not configured.' },
        { status: 401 }
      );
    }
    const token = req.cookies.get('consumer_token')?.value;
    if (!token) {
      return NextResponse.json({ success: false, error: 'No session.' }, { status: 401 });
    }

    const { payload } = await jwtVerify(token, JWT_SECRET);
    return NextResponse.json({
      success: true,
      account: {
        id: payload.consumerId as string,
        walletAddress: payload.walletAddress as string,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid or expired session.' }, { status: 401 });
  }
}

// POST /api/consumer/session
// body: {} -> create a brand new Circle-managed wallet + account
// body: { walletAddress, message, signature } -> connect an existing wallet
//   (signature must prove control of walletAddress against a nonce issued by GET)
export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'default');
    if (!allowed) return limitResponse;

    const body = await req.json().catch(() => ({}));
    const { walletAddress, message, signature } = body;

    // ── Path A: connect an existing wallet ──────────────────────────────
    if (walletAddress) {
      if (!isAddress(walletAddress)) {
        return NextResponse.json(
          { success: false, error: 'Not a valid wallet address.' },
          { status: 400 }
        );
      }

      if (!message || !signature) {
        return NextResponse.json(
          {
            success: false,
            error:
              'Connecting an existing wallet requires proof of ownership: ' +
              'call GET /api/consumer/session?nonce=1&address=<addr> for a challenge, ' +
              'then POST { walletAddress, message, signature }.',
          },
          { status: 400 }
        );
      }

      const cookieNonce = req.cookies.get(NONCE_COOKIE)?.value;
      if (!cookieNonce || !message.includes(cookieNonce)) {
        return NextResponse.json(
          {
            success: false,
            error: 'Missing or expired challenge — request a new one via GET first.',
          },
          { status: 400 }
        );
      }

      const valid = await verifyMessage({
        address: walletAddress as `0x${string}`,
        message,
        signature,
      }).catch(() => false);

      if (!valid) {
        return NextResponse.json(
          { success: false, error: 'Signature verification failed.' },
          { status: 401 }
        );
      }

      let account = await prisma.consumerAccount.findUnique({
        where: { walletAddress },
      });

      if (!account) {
        account = await prisma.consumerAccount.create({
          data: { walletAddress, walletType: 'EXTERNAL' },
        });
      } else {
        await prisma.consumerAccount.update({
          where: { id: account.id },
          data: { lastSeenAt: new Date() },
        });
      }

      const response = await issueSession(account);
      response.cookies.delete(NONCE_COOKIE);
      return response;
    }

    // ── Path B: create a brand new Circle-managed wallet ────────────────
    const wallet = await createAccountWallet(`consumer_${Date.now()}`);

    const account = await prisma.consumerAccount.create({
      data: {
        walletAddress: wallet.address,
        walletType: 'CIRCLE',
        circleWalletId: wallet.walletId,
        walletSetId: wallet.walletSetId,
      },
    });

    return issueSession(account);
  } catch (error: any) {
    console.error('Consumer session error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error.' }, { status: 500 });
  }
}

// DELETE /api/consumer/session — sign out
export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.delete('consumer_token');
  response.cookies.delete(NONCE_COOKIE);
  return response;
}