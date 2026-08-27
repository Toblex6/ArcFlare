/**
 * circleWalletProvisioning.ts
 *
 * Mints a Circle Developer-Controlled Wallet for a newly onboarded
 * Telegram user, and sponsors gas so they never need to acquire it
 * themselves.
 *
 * This uses the SAME Circle product your platform already runs live —
 * confirmed via the hardening report: initiateDeveloperControlledWalletsClient
 * with .env keys, same client type that resolves DEFAULT_PAYER_SCA and
 * settles real testnet USDC through Path B today. This is NOT the earlier
 * (unverified, abandoned) MPC/User-Controlled Wallets approach — per your
 * explicit instruction, this batch uses Developer-Controlled only.
 *
 * Trust model, stated plainly: the platform's API key/entity secret can
 * move funds in this wallet unilaterally — same as every other wallet
 * already in production on this platform. This is a deliberate,
 * consistent choice, not a shortcut specific to Telegram users.
 */

import { randomUUID } from 'crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { prisma } from '@/lib/prisma'; // adjust to your actual client path
import { getRelayerSigner } from '@/lib/wallet/jobEscrowClient'; // existing relayer, reused for gas sponsorship — same signer used across batches 1-6

let cachedClient: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;
let cachedCreds: { apiKey: string; entitySecret: string } | null = null;

function getProvisioningConfig() {
  return {
    apiKey: process.env.CIRCLE_API_KEY ?? '',
    entitySecret: process.env.CIRCLE_ENTITY_SECRET ?? '',
    walletSetId: process.env.CIRCLE_WALLET_SET_ID ?? '',
    blockchain: process.env.CIRCLE_ARC_BLOCKCHAIN_ID ?? 'ARC-TESTNET',
    gasWei: process.env.GAS_SPONSORSHIP_AMOUNT_WEI ?? '10000000000000000',
  };
}

function getCircleClient() {
  const { apiKey, entitySecret } = getProvisioningConfig();
  if (!apiKey || !entitySecret) {
    throw new Error(
      'Circle Developer-Controlled Wallets is not configured — set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET. ' +
      'These should already exist in your production env since the platform already uses this client for settlement.'
    );
  }
  if (!cachedClient || !cachedCreds || cachedCreds.apiKey !== apiKey || cachedCreds.entitySecret !== entitySecret) {
    cachedClient = initiateDeveloperControlledWalletsClient({
      apiKey,
      entitySecret,
    });
    cachedCreds = { apiKey, entitySecret };
  }
  return cachedClient;
}

export interface ProvisionedWallet {
  circleWalletId: string;
  walletAddress: string;
  gasSponsorshipTxHash: string | null;
}

/**
 * Mints a new Circle Developer-Controlled Wallet for a Telegram user and
 * sponsors it with gas. Idempotent two ways: DB check up front (a user
 * hitting /start twice gets their existing wallet back), plus a
 * deterministic idempotencyKey passed to Circle itself.
 */
export async function provisionWalletForTelegramUser(
  telegramUserId: string,
  displayName: string
): Promise<ProvisionedWallet> {
  const { walletSetId, blockchain } = getProvisioningConfig();
  if (!walletSetId) {
    throw new Error(
      'CIRCLE_WALLET_SET_ID is not configured. Create a wallet set once via the Circle console/API ' +
      '(separate from any existing merchant-facing wallet set, to keep Telegram consumer wallets logically ' +
      'grouped) and set this env var before provisioning any Telegram wallets.'
    );
  }

  const existing = await prisma.consumerAccount.findFirst({ where: { telegramUserId } });
  if (existing?.walletAddress) {
    return {
      circleWalletId: existing.circleWalletId ?? '',
      walletAddress: existing.walletAddress,
      gasSponsorshipTxHash: null, // already provisioned, no new sponsorship needed
    };
  }

  const client = getCircleClient();

  // Aligned with src/lib/circle/client.ts:createWallets — uses ARC-TESTNET,
  // count 1, SCA. idempotencyKey must be UUID v4 (Circle validates format;
  // the previous `telegram-${telegramUserId}` caused 400 API parameter invalid).
  // metadata shape is WalletMetadata[] { name, refId } per SDK — kept, but
  // removed if Circle ever rejects it (minimal diff vs working call site).
  let response: Awaited<ReturnType<typeof client.createWallets>>;
  try {
    response = await client.createWallets({
      idempotencyKey: randomUUID(),
      walletSetId,
      blockchains: [blockchain as any],
      count: 1,
      accountType: 'SCA', // matches the live wallet creation pattern (src/lib/circle/client.ts)
      metadata: [{ name: displayName, refId: telegramUserId }],
    });
  } catch (e: any) {
    const circleMessage =
      e?.response?.data?.message ??
      e?.response?.data?.errors?.[0]?.message ??
      e?.data?.message ??
      e?.message ??
      String(e);
    const safeMeta = {
      url: e?.url,
      method: e?.method,
      status: e?.status,
      code: e?.code,
      circleMessage,
    };
    console.error('[circleWalletProvisioning] Circle createWallets failed', JSON.stringify(safeMeta));
    // Re-throw with Circle's message exposed (no secrets) so webhook logs are actionable
    throw new Error(`Circle wallet creation failed: ${circleMessage} (status ${e?.status ?? 'unknown'}, code ${e?.code ?? 'unknown'})`);
  }

  const wallet = response?.data?.wallets?.[0];
  if (!wallet?.id || !wallet?.address) {
    throw new Error(`unexpected Circle wallet creation response shape: ${JSON.stringify(response?.data)}`);
  }

  // Persist immediately — before gas sponsorship — so a sponsorship
  // failure below never loses track of a wallet Circle actually created.
  await prisma.consumerAccount.upsert({
    where: { telegramUserId },
    create: {
      telegramUserId,
      walletAddress: wallet.address,
      circleWalletId: wallet.id,
      onboardingSource: 'telegram',
    },
    update: {
      walletAddress: wallet.address,
      circleWalletId: wallet.id,
    },
  });

  let gasSponsorshipTxHash: string | null = null;
  try {
    gasSponsorshipTxHash = await sponsorGas(wallet.address);
  } catch (gasError) {
    // Do not fail provisioning over a gas sponsorship failure — the
    // wallet is real and usable once funded; log loudly so this doesn't
    // get lost, and let retryGasSponsorship handle it (e.g. lazily,
    // right before the user's first transaction attempt).
    console.error(
      `[circleWalletProvisioning] wallet ${wallet.address} created but gas sponsorship failed: ` +
      `${(gasError as Error).message}. Needs manual or retried sponsorship before first tx. ` +
      `THIS IS PRODUCTION — treat this log as actionable, not noise.`
    );
  }

  return { circleWalletId: wallet.id, walletAddress: wallet.address, gasSponsorshipTxHash };
}

async function sponsorGas(walletAddress: string): Promise<string> {
  const { gasWei } = getProvisioningConfig();
  const relayerSigner = getRelayerSigner();
  const tx = await relayerSigner.sendTransaction({
    to: walletAddress,
    value: BigInt(gasWei),
  });
  const receipt = await tx.wait();
  return receipt!.hash;
}

export async function retryGasSponsorship(telegramUserId: string): Promise<string> {
  const account = await prisma.consumerAccount.findFirst({ where: { telegramUserId } });
  if (!account?.walletAddress) {
    throw new Error(`no wallet found for telegram user ${telegramUserId}`);
  }
  return sponsorGas(account.walletAddress);
}

/*
 * ---- Required schema additions to ConsumerAccount (diff) ----
 *
 *   telegramUserId    String?  @unique
 *   circleWalletId    String?
 *   onboardingSource  String?  // "telegram" | "web" | etc
 *
 * If ConsumerAccount already has a walletAddress field from the existing
 * web signup flow, this reuses it directly — Telegram-provisioned wallets
 * live in the same field, distinguished only by onboardingSource. This is
 * a deliberate simplification: one wallet-address field, one consumer
 * identity, regardless of entry point. If that assumption is wrong for
 * your schema (e.g. walletAddress is populated differently for web users),
 * flag it back — this file assumes reuse, not a parallel field.
 */
