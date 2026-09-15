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
import { jwtVerify } from 'jose';
import { isAddress, verifyMessage } from 'viem';
import { randomBytes } from 'crypto';
import { createAccountWallet } from '@/src/lib/circle/client';
import {
  listUserControlledWallets,
  selectArcWallet,
} from '@/src/lib/circle/userControlled';
import { requireJwtSecret, tryJwtSecret } from '@/src/lib/auth/secrets';
import { issueConsumerSessionToken } from '@/src/lib/auth/consumerSession';

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

async function issueSession(
  account: { id: string; walletAddress: string; walletType?: string | null; circleWalletId?: string | null; walletSetId?: string | null },
  extra?: { isNew?: boolean }
) {
  const token = await issueConsumerSessionToken(account.id, account.walletAddress);

  const res = NextResponse.json({
    success: true,
    // isNew is true only when this request created the account row (used by
    // the UI for first-run affordances like the faucet banner). Returning
    // sign-ins resolve to the existing row with isNew: false.
    isNew: extra?.isNew ?? false,
    account: {
      id: account.id,
      walletAddress: account.walletAddress,
      // EXTERNAL (bring-your-own) vs CIRCLE (FlareHQ-managed) — the UI uses
      // this to gate features that need a FlareHQ wallet (e.g. bridging).
      // walletSetId is exposed so the browser can call
      // signingModelForWallet({ walletType, walletSetId }) — the single
      // authority for save/bridge UX branching — instead of comparing
      // walletType strings inline (a CIRCLE row without walletSetId is not
      // server-signable and must not render the automatic-save UX).
      walletType: account.walletType ?? null,
      circleWalletId: (account as any).circleWalletId ?? null,
      walletSetId: (account as any).walletSetId ?? null,
    },
  });

  res.cookies.set('consumer_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });

  return res;
}

// GET /api/consumer/session
//   no params         -> check for an existing session (page load)
//   ?nonce=1&address= -> issue a signature challenge (step 1 of connect)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get('address');

    if (address) {
      const { allowed, response: limitResponse } = await checkRateLimit(req, 'session');
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
    const acct = await prisma.consumerAccount.findUnique({
      where: { id: payload.consumerId as string },
    });
    return NextResponse.json({
      success: true,
      account: {
        id: payload.consumerId as string,
        walletAddress: payload.walletAddress as string,
        walletType: acct?.walletType ?? null,
        circleWalletId: (acct as any)?.circleWalletId ?? null,
        // See issueSession above: the Save view branches via
        // signingModelForWallet({ walletType, walletSetId }).
        walletSetId: (acct as any)?.walletSetId ?? null,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid or expired session.' }, { status: 401 });
  }
}

// POST /api/consumer/session
// body: {} -> create a brand new Circle-managed wallet + account (legacy,
//   developer-controlled — kept for backwards compatibility and the
//   bridge-upgrade flow; new users onboard via Path C below)
// body: { walletAddress, message, signature } -> connect an existing wallet
//   (signature must prove control of walletAddress against a nonce issued by GET)
// body: { circleAuth: { userToken, walletAddress?, circleUserId? } } ->
//   link a Circle USER-CONTROLLED wallet (Google / email OTP via the Circle
//   Web SDK) to a FlareHQ consumer session. The walletAddress is verified
//   server-side against Circle's authoritative wallet list for that
//   userToken — a client-supplied address alone is never trusted.
export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'session');
    if (!allowed) return limitResponse;

    const body = await req.json().catch(() => ({}));
    const { walletAddress, message, signature } = body;

    // ── Path C: link a Circle user-controlled wallet ────────────────────
    // The browser completed Circle's Google/email ceremony and holds a
    // userToken (+ Circle wallet address). This path verifies the userToken
    // against Circle, resolves the authoritative wallet, then maps it to
    // the EXISTING consumer_token session model — no new session system.
    // Returning users (same Google/email identity) resolve to their
    // existing ConsumerAccount row; no duplicates are created.
    if (body?.circleAuth) {
      const { userToken, walletAddress: hintedAddress, circleUserId: hintedUserId } =
        body.circleAuth as { userToken?: unknown; walletAddress?: unknown; circleUserId?: unknown };

      if (typeof userToken !== 'string' || !userToken.trim()) {
        return NextResponse.json(
          {
            success: false,
            error: 'Circle authentication is required — complete Google or email login first.',
          },
          { status: 401 }
        );
      }

      const circleUserId =
        typeof hintedUserId === 'string' && hintedUserId.trim().length > 0 && hintedUserId.length <= 128
          ? hintedUserId.trim()
          : null;

      let authoritative: Awaited<ReturnType<typeof listUserControlledWallets>>;
      try {
        authoritative = await listUserControlledWallets(userToken);
      } catch (e: any) {
        const status = typeof e?.status === 'number' ? e.status : 502;
        if (status === 401) {
          return NextResponse.json(
            {
              success: false,
              error: 'Circle session expired — sign in with Google or email again.',
              code: 'CIRCLE_AUTH_EXPIRED',
            },
            { status: 401 }
          );
        }
        if (status === 503) {
          return NextResponse.json(
            { success: false, error: 'Circle wallet service is not configured.', code: e?.code },
            { status: 503 }
          );
        }
        return NextResponse.json(
          { success: false, error: 'Could not verify the Circle wallet. Try again.', code: e?.code },
          { status: 502 }
        );
      }

      if (authoritative.length === 0) {
        return NextResponse.json(
          {
            success: false,
            error: 'No Circle wallet found for this identity yet — finish creating the wallet first.',
            code: 'CIRCLE_WALLET_NOT_FOUND',
          },
          { status: 404 }
        );
      }

      // Resolve the target wallet: a client-hinted address is accepted ONLY
      // when Circle's own list proves it belongs to this Circle user.
      // Otherwise the Arc-network wallet is selected server-side.
      let target = selectArcWallet(authoritative);
      if (typeof hintedAddress === 'string' && hintedAddress.trim()) {
        if (!isAddress(hintedAddress)) {
          return NextResponse.json(
            { success: false, error: 'Not a valid wallet address.' },
            { status: 400 }
          );
        }
        const match = authoritative.find(
          (w) => w.address.toLowerCase() === (hintedAddress as string).toLowerCase()
        );
        if (!match) {
          return NextResponse.json(
            {
              success: false,
              error: 'This wallet does not belong to the authenticated Circle identity.',
              code: 'CIRCLE_WALLET_MISMATCH',
            },
            { status: 403 }
          );
        }
        target = match;
      }
      if (!target) {
        return NextResponse.json(
          { success: false, error: 'Could not resolve a Circle wallet for this identity.' },
          { status: 502 }
        );
      }

      // Returning-user resolution: same Circle user id OR same wallet
      // address maps to the existing row — never a second account.
      const or: Array<Record<string, unknown>> = [
        { walletAddress: { equals: target.address, mode: 'insensitive' } },
      ];
      if (circleUserId) or.push({ circleUserId });
      let account = await (prisma as any).consumerAccount.findFirst({
        where: { OR: or },
      });

      let isNewAccount = false;
      if (!account) {
        account = await (prisma as any).consumerAccount.create({
          data: {
            walletAddress: target.address,
            walletType: 'USER_CONTROLLED',
            circleWalletId: target.id,
            circleUserId,
            onboardingSource: 'circle-user-controlled',
          },
        });
        isNewAccount = true;
      } else {
        // Backfill the Circle binding on rows that predate it, and refresh
        // custody metadata if Circle reports a new wallet id — the address
        // match above is what makes this write safe. A developer-controlled
        // (CIRCLE + walletSetId) row is NEVER converted: custody models have
        // disjoint key material, so an address collision across them would
        // indicate corruption, and silently converting a server-signable
        // wallet would break settlement signing.
        if (account.walletType === 'CIRCLE' && account.walletSetId) {
          return NextResponse.json(
            {
              success: false,
              error: 'This wallet is already registered as a Flow-created wallet. Sign in with your existing session instead.',
              code: 'CUSTODY_CONFLICT',
            },
            { status: 409 }
          );
        }
        await (prisma as any).consumerAccount.update({
          where: { id: account.id },
          data: {
            lastSeenAt: new Date(),
            walletType: 'USER_CONTROLLED',
            circleWalletId: target.id,
            ...(circleUserId && !account.circleUserId ? { circleUserId } : {}),
          },
        });
        account = await (prisma as any).consumerAccount.findUnique({
          where: { id: account.id },
        });
      }

      return issueSession(account, { isNew: isNewAccount });
    }

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