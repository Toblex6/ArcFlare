// src/lib/wallet/resolve.ts
//
// The only place in the codebase that should read Merchant.walletProvider
// directly. Every route that executes a payment calls this, then talks to
// the returned WalletProvider — never Circle or a raw address again.

import { prisma } from "@/lib/prisma";
import { WalletProvider } from "./provider";
import { CircleWalletProvider } from "./circleProvider";
import { ExternalWalletProvider } from "./externalProvider";

const EXTERNAL_SIGNER_KINDS = new Set(["METAMASK", "WALLETCONNECT", "COINBASE"]);

export async function resolveWalletProvider(merchantId: string): Promise<WalletProvider> {
  const merchant = await (prisma as any).merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new Error(`No merchant found for id ${merchantId}`);

  if (merchant.walletProvider === "CIRCLE") {
    if (!merchant.walletAddress) throw new Error("Merchant has no Circle wallet address provisioned yet.");
    return new CircleWalletProvider(merchant.walletAddress);
  }

  if (EXTERNAL_SIGNER_KINDS.has(merchant.walletProvider)) {
    if (!merchant.walletAddress) throw new Error("Merchant's external wallet is not connected.");
    return new ExternalWalletProvider(merchant.walletProvider, merchant.id, merchant.walletAddress);
  }

  // Legacy "EXTERNAL" value from before this redesign — address-only, never
  // SIWE-verified, no signer capability. Don't silently treat it as a real
  // external signer; fail clearly so the merchant is prompted to reconnect
  // via the new /api/merchant/wallet/connect flow instead of hitting a
  // confusing downstream error inside whatever feature called this.
  if (merchant.walletProvider === "EXTERNAL") {
    throw new Error(
      "This merchant's wallet was set up with the old address-only flow and needs to reconnect via /api/merchant/wallet/connect before it can sign anything."
    );
  }

  throw new Error(`Unknown walletProvider "${merchant.walletProvider}" for merchant ${merchantId}.`);
}
