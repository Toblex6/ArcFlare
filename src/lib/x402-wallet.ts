// src/lib/x402-wallet.ts
//
// Per-merchant x402 buyer wallets. Replaces the single global BUYER_PRIVATE_KEY
// with one auto-provisioned EOA per merchant, key encrypted at rest.
//
// Requires X402_WALLET_ENCRYPTION_KEY in env — a 32-byte key, base64-encoded.
// Generate one with: `openssl rand -base64 32`
// This is NOT optional in production — without it, wallet creation will throw
// rather than silently falling back to storing plaintext keys.

import crypto from "crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { prisma } from "@/lib/prisma";

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
    const keyB64 = process.env.X402_WALLET_ENCRYPTION_KEY;
    if (!keyB64) {
        throw new Error(
            "X402_WALLET_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it in your environment before creating any x402 buyer wallets."
        );
    }
    const key = Buffer.from(keyB64, "base64");
    if (key.length !== 32) {
        throw new Error("X402_WALLET_ENCRYPTION_KEY must decode to exactly 32 bytes.");
    }
    return key;
}

function encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
    };
}

function decrypt(ciphertext: string, iv: string, authTag: string): string {
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64")),
        decipher.final(),
    ]);
    return plaintext.toString("utf8");
}

/**
 * Returns the merchant's x402 buyer wallet, creating one if they don't have
 * one yet. The returned privateKey is decrypted and should never be logged
 * or included in any API response — use it only to construct a GatewayClient.
 */
export async function getOrCreateBuyerWallet(
    merchantId: string
): Promise<{ address: string; privateKey: `0x${string}` }> {
    const existing = await (prisma as any).x402EoaWallet.findUnique({ where: { merchantId } });

    if (existing) {
        const privateKey = decrypt(existing.encryptedKey, existing.keyIv, existing.keyAuthTag) as `0x${string}`;
        return { address: existing.address, privateKey };
    }

    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const { ciphertext, iv, authTag } = encrypt(privateKey);

    await (prisma as any).x402EoaWallet.create({
        data: {
            address: account.address,
            encryptedKey: ciphertext,
            keyIv: iv,
            keyAuthTag: authTag,
            merchantId,
            label: "Auto-provisioned x402 buyer wallet",
        },
    });

    return { address: account.address, privateKey };
}

/** Returns just the address, without decrypting the key — safe for API responses. */
export async function getBuyerWalletAddress(merchantId: string): Promise<string | null> {
    const wallet = await (prisma as any).x402EoaWallet.findUnique({
        where: { merchantId },
        select: { address: true },
    });
    return wallet?.address ?? null;
}

/**
 * Read-only private-key accessor. Unlike getOrCreateBuyerWallet, this NEVER
 * provisions a new wallet — it returns null when the merchant has none.
 * Use it when the key MUST match an already-existing on-chain address
 * (e.g. signing rejectSubmission as the job poster), where auto-creating a
 * fresh wallet would silently produce a key for the WRONG address.
 * The returned key is decrypted and must never be logged or serialized.
 */
export async function getBuyerWalletPrivateKey(merchantId: string): Promise<`0x${string}` | null> {
    const existing = await (prisma as any).x402EoaWallet.findUnique({ where: { merchantId } });
    if (!existing) return null;
    const privateKey = decrypt(existing.encryptedKey, existing.keyIv, existing.keyAuthTag) as `0x${string}`;
    return privateKey;
}
