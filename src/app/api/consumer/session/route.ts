// src/app/api/consumer/session/route.ts
// Wallet-first consumer auth — no email/password. A wallet address IS the
// account. Session is a signed JWT cookie, same pattern as merchant auth.
//
// Consumer wallet model (two modes, one session):
//   CIRCLE   — Circle developer-controlled SCA created by FlareHQ (the
//              server signs via CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET).
//   EXTERNAL — bring-your-own wallet (browser/wagmi signs; the server never
//              signs and never sees keys).
//
// Passwordless email login (new + returning consumers) lives in
// src/app/api/consumer/email-auth/route.ts — it resolves the SAME
// ConsumerAccount row by verified email and issues this same session.
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
// Creating a brand-new Circle-managed wallet (empty body) is unchanged for
// callers WITHOUT an EXTERNAL session; a caller holding an EXTERNAL session
// is refused (EMAIL_VERIFICATION_REQUIRED) — a FlareHQ wallet is never
// provisioned from a connected external wallet without email verification.
// The address comes from Circle's own response, never from the client.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { jwtVerify } from 'jose';
import { isAddress, verifyMessage } from 'viem';
import { randomBytes } from 'crypto';
import { createAccountWallet } from '@/src/lib/circle/client';
import { resolveExternalBridgeDestination } from '@/lib/bridge/externalDestination';
import { requireJwtSecret, tryJwtSecret } from '@/src/lib/auth/secrets';
import { issueConsumerSessionToken } from '@/src/lib/auth/consumerSession';
import { resolveConsumerWallet } from '@/src/lib/auth/consumerWallet';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';

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
  account: { id: string; walletAddress: string; walletType?: string | null; circleWalletId?: string | null; sessionVersion?: number | null },
  extra?: { isNew?: boolean }
) {
  // M4: bind the token to the account's current sessionVersion.
  const token = await issueConsumerSessionToken(account.id, account.walletAddress, account.sessionVersion ?? 0);

  // Canonical wallet view (mode + server-signing capability): lets callers
  // distinguish a fully-bound CIRCLE wallet from one whose signing identity
  // is missing (recoverable state — server-controlled features fail closed
  // with CIRCLE_WALLET_UNBOUND instead of guessing). Legacy/unknown custody
  // resolves to nulls here, never to a guessed mode.
  const wallet = resolveConsumerWallet(account);

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
      walletType: account.walletType ?? null,
      circleWalletId: (account as any).circleWalletId ?? null,
      mode: wallet?.mode ?? null,
      canServerSign: wallet?.canServerSign ?? false,
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
    // Same canonical wallet view as issueSession (recoverable state for
    // unbound CIRCLE rows; nulls for legacy/unknown custody).
    const wallet = resolveConsumerWallet(acct as any);
    return NextResponse.json({
      success: true,
      account: {
        id: payload.consumerId as string,
        walletAddress: payload.walletAddress as string,
        walletType: acct?.walletType ?? null,
        circleWalletId: (acct as any)?.circleWalletId ?? null,
        mode: wallet?.mode ?? null,
        canServerSign: wallet?.canServerSign ?? false,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid or expired session.' }, { status: 401 });
  }
}

// POST /api/consumer/session
// body: {} -> create a brand new Circle-managed wallet + account
//   (developer-controlled SCA — the server signs via CIRCLE_API_KEY +
//   CIRCLE_ENTITY_SECRET; the address comes from Circle's own response,
//   never from the client)
// body: { walletAddress, message, signature } -> connect an existing wallet
//   (signature must prove control of walletAddress against a nonce issued by GET)
export async function POST(req: NextRequest) {
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'session');
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

      // ── Bridge-destination link (best-effort, never authoritative client
      // input) ── If the browser was signed in as a FlareHQ CIRCLE wallet
      // (e.g. the wallet this user just created through email verification)
      // and this proven-controlled EXTERNAL wallet has no usable destination
      // link, record the link so the EXTERNAL bridge resolves its destination
      // server-side. Safety: the caller just proved ownership of `walletAddress`
      // by signature, the written value is ALWAYS the CIRCLE row the same
      // browser session already held (no client-supplied destination is ever
      // trusted), and a USABLE link is never replaced.
      //
      // "Usable" is decided by the destination resolver — the single authority
      // for that rule — rather than by a second copy of its validity checks
      // here. That matters for correctness, not just DRY: the previous
      // link-when-unset-only rule could never repair a DANGLING link (one
      // pointing at a row that is gone or is not a CIRCLE wallet), so email
      // onboarding would loop forever between OTP and the recoverable
      // CIRCLE_WALLET_UNBOUND gate and the user could never bridge.
      try {
        const priorAddress = await resolveConsumerSession(req).catch(() => null);
        if (priorAddress) {
          const prior = await prisma.consumerAccount
            .findUnique({ where: { walletAddress: priorAddress } })
            .catch(() => null);
          const priorWallet = resolveConsumerWallet(prior as any);
          // Unset -> not usable (write). Dangling -> not usable (repair).
          // Usable -> never replaced. A resolver FAILURE resolves to true so
          // an uncertain read can never repoint a live destination.
          const linkUsable = !!(account as any)?.linkedCircleAddress
            ? await resolveExternalBridgeDestination(account)
                .then((d) => d.ok)
                .catch(() => true)
            : false;
          if (
            prior &&
            priorWallet?.mode === 'CIRCLE' &&
            prior.id !== account.id &&
            !linkUsable
          ) {
            await prisma.consumerAccount
              .update({
                where: { id: account.id },
                data: { linkedCircleAddress: prior.walletAddress },
              })
              .catch((e: any) => {
                // Never blocks wallet connection — but never silent either:
                // the bridge preview re-resolves right after this call, so a
                // dropped write must be diagnosable rather than surfacing as a
                // bare "no FlareHQ wallet linked yet" with no explanation.
                console.warn(
                  '[consumer/session] bridge destination link write failed:',
                  e?.message ?? e
                );
              });
          }
        }
      } catch {
        // Linking must never block wallet connection.
      }

      const response = await issueSession(account);
      response.cookies.delete(NONCE_COOKIE);
      return response;
    }

    // ── Path B: create a brand new Circle-managed wallet ────────────────
    // The address comes from Circle's own response, never from the client.
    // INVARIANT (wallet-creation onboarding): a FlareHQ CIRCLE wallet may
    // NEVER be provisioned directly from a connected EXTERNAL wallet. The
    // only supported creation path is Email → OTP → verified consumer
    // identity → create/retrieve CIRCLE wallet (POST/PUT
    // /api/consumer/email-auth). An EXTERNAL session asking Path B to
    // provision therefore fails closed here — no Circle call, no link write,
    // no session replacement.
    try {
      const priorAddress = await resolveConsumerSession(req).catch(() => null);
      if (priorAddress) {
        const prior = await prisma.consumerAccount
          .findUnique({ where: { walletAddress: priorAddress } })
          .catch(() => null);
        const priorWallet = resolveConsumerWallet(prior as any);
        if (priorWallet?.mode === 'EXTERNAL') {
          return NextResponse.json(
            {
              success: false,
              code: 'EMAIL_VERIFICATION_REQUIRED',
              error:
                'Verify your email to create a FlareHQ wallet. From the bridge, use "Continue with email" — a wallet is never created directly from a connected external wallet.',
            },
            { status: 403 }
          );
        }
      }
    } catch {
      // Best-effort only — the invariant check must never throw out of Path B
      // for callers without a resolvable session.
    }
    const wallet = await createAccountWallet(`consumer_${Date.now()}`);

    const account = await prisma.consumerAccount.create({
      data: {
        walletAddress: wallet.address,
        walletType: 'CIRCLE',
        circleWalletId: wallet.walletId,
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