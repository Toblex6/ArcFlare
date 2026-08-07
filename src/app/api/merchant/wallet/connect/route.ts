// src/app/api/merchant/wallet/connect/route.ts
//
// Two-step SIWE (Sign-In With Ethereum) flow to link an external wallet to
// an already-authenticated merchant. Order matters: the merchant must
// already be logged in via merchant_token before this runs — this proves
// wallet ownership and attaches it to that identity, it does not log anyone
// in on its own.
//
// Step 1 (GET): issue a nonce challenge, stored in a short-lived httpOnly
// cookie (stateless — no separate table needed for a 5-minute challenge).
// Step 2 (POST): verify the signature against that nonce with viem, then
// set walletProvider + walletAddress. Never stores a private key — there
// isn't one to store, this is exactly the point of this wallet type.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { verifyMessage } from "viem";
import { prisma } from "@/lib/prisma";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";

const NONCE_COOKIE = "wallet_connect_nonce";
const SUPPORTED_KINDS = new Set(["METAMASK", "WALLETCONNECT", "COINBASE"]);

function buildSiweMessage(domain: string, address: string, nonce: string): string {
  const issuedAt = new Date().toISOString();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    ``,
    `Link this wallet to your FlareHQ merchant account.`,
    ``,
    `URI: https://${domain}`,
    `Version: 1`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

// Step 1 — issue challenge
export async function GET(req: NextRequest) {
  const merchant = await resolveMerchant(req);
  if (!merchant) {
    return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  if (!address) {
    return NextResponse.json({ success: false, error: "address query param required." }, { status: 400 });
  }

  const nonce = randomBytes(16).toString("hex");
  const domain = req.headers.get("host") || "flarehq.xyz";
  const message = buildSiweMessage(domain, address, nonce);

  const res = NextResponse.json({ success: true, message });
  res.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 300, // 5 minutes to sign and return
    path: "/",
  });
  return res;
}

// Step 2 — verify signature, link wallet
export async function POST(req: NextRequest) {
  const merchant = await resolveMerchant(req);
  if (!merchant) {
    return NextResponse.json({ success: false, error: "Authentication required." }, { status: 401 });
  }

  const { address, message, signature, walletKind } = await req.json();
  if (!address || !message || !signature || !walletKind) {
    return NextResponse.json(
      { success: false, error: "address, message, signature, and walletKind are required." },
      { status: 400 }
    );
  }
  if (!SUPPORTED_KINDS.has(walletKind)) {
    return NextResponse.json(
      { success: false, error: `walletKind must be one of: ${Array.from(SUPPORTED_KINDS).join(", ")}` },
      { status: 400 }
    );
  }

  const cookieNonce = req.cookies.get(NONCE_COOKIE)?.value;
  if (!cookieNonce || !message.includes(cookieNonce)) {
    return NextResponse.json(
      { success: false, error: "Missing or expired challenge — request a new one via GET first." },
      { status: 400 }
    );
  }

  const valid = await verifyMessage({
    address: address as `0x${string}`,
    message,
    signature,
  }).catch(() => false);

  if (!valid) {
    return NextResponse.json({ success: false, error: "Signature verification failed." }, { status: 401 });
  }

  const updated = await (prisma as any).merchant.update({
    where: { id: merchant.id },
    data: { walletProvider: walletKind, walletAddress: address, circleWalletId: null },
  });

  const res = NextResponse.json({
    success: true,
    wallet: { walletProvider: updated.walletProvider, walletAddress: updated.walletAddress },
  });
  res.cookies.delete(NONCE_COOKIE);
  return res;
}
