// src/lib/cctp.ts
// Shared CCTP V2 helper — used across settle, detect and webhook routes.

import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';

// ─── CCTP V2 endpoints and contracts ─────────────────────────────────────────
const IRIS_API_V2 = 'https://iris-api-sandbox.circle.com/v2';
const MESSAGE_TRANSMITTER_V2 = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275';
const ARC_TESTNET_DOMAIN = 26; // Arc Testnet CCTP V2 domain

const MESSAGE_TRANSMITTER_ABI = [
  {
    name: 'receiveMessage',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

// ─── Decode a CCTP V2 message to extract mintRecipient + amount ────────────
// Byte layout verified against Circle's CCTPV2 whitepaper and
// evm-cctp-contracts/src/messages/BurnMessage.sol (circlefin/evm-cctp-contracts).
//
// Outer generic message (what Iris returns as `message`):
//   version(4) sourceDomain(4) destinationDomain(4) nonce(32) sender(32)
//   recipient(32) destinationCaller(32) minFinalityThreshold(4)
//   finalityThresholdExecuted(4) messageBody(dynamic, starts at byte 148)
//
// Inner messageBody (BurnMessage, relative offsets):
//   version(4) burnToken(32) mintRecipient(32) amount(32) messageSender(32)
//   maxFee(32) feeExecuted(32) expirationBlock(32) hookData(dynamic)
//
// So absolute offsets: mintRecipient @ 148+36=184, amount @ 148+68=216.
// This exists because settling a checkout payment must never trust an
// attested message at face value — the mint recipient and amount encoded
// IN the message are the only real proof of what was actually paid to whom.
export function decodeBurnMessage(messageHex: string): { mintRecipient: string; amount: bigint } {
  const hex = messageHex.startsWith('0x') ? messageHex.slice(2) : messageHex;

  // Each byte = 2 hex chars. mintRecipient: bytes 184–216 (32 bytes, an
  // address right-padded to 32 bytes — take the last 20 bytes for EVM).
  const mintRecipientHex = hex.slice(184 * 2, 216 * 2);
  const mintRecipient = '0x' + mintRecipientHex.slice(-40);

  // amount: bytes 216–248 (32 bytes, big-endian uint256)
  const amountHex = hex.slice(216 * 2, 248 * 2);
  const amount = BigInt('0x' + amountHex);

  return { mintRecipient, amount };
}


export async function pollForAttestation(
  messageHash: string,
  maxAttempts = 30,
  intervalMs = 3000
): Promise<{ message: string; attestation: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // CCTP V2 attestation endpoint
      const res = await fetch(`${IRIS_API_V2}/attestations/${messageHash}`, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (res.ok) {
        const data = await res.json();
        // V2 returns { status: "complete", attestation: "0x...", message: "0x..." }
        if (data.status === 'complete' && data.attestation) {
          console.log(`✅ CCTP V2 attestation received for ${messageHash}`);
          return { message: data.message, attestation: data.attestation };
        }
        console.log(`⏳ Attempt ${attempt + 1}/${maxAttempts} — status: ${data.status}`);
      } else {
        console.warn(`⚠️ Iris V2 responded with ${res.status}`);
      }
    } catch (err: any) {
      console.warn(`⚠️ Iris V2 poll error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `CCTP V2 attestation timed out after ${maxAttempts} attempts (${(maxAttempts * intervalMs) / 1000}s). ` +
    `The burn tx may still be confirming on the source chain.`
  );
}

// ─── Poll Circle Iris V2 API for attestation, by source tx hash ─────────────
// Added for checkout CCTP support: the payer's browser reports a burn
// txHash directly (same trust model as /api/payments/verify-onchain for the
// direct-wallet flow — client reports, server independently verifies before
// settling), not a pre-computed messageHash. Circle's V2 Iris API supports
// looking up by (sourceDomain, transactionHash) directly, so this avoids
// needing to independently parse/decode MessageSent event logs ourselves.
export async function pollForAttestationByTxHash(
  sourceDomainId: number,
  transactionHash: string,
  maxAttempts = 40,
  intervalMs = 3000
): Promise<{ message: string; attestation: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(
        `${IRIS_API_V2}/messages/${sourceDomainId}?transactionHash=${transactionHash}`,
        { headers: { 'Content-Type': 'application/json' } }
      );

      if (res.ok) {
        const data = await res.json();
        // Iris V2's tx-hash lookup returns { messages: [{ status, message, attestation, ... }] }
        const entry = data?.messages?.[0];
        if (entry?.status === 'complete' && entry?.attestation && entry?.message) {
          console.log(`✅ CCTP V2 attestation received for tx ${transactionHash}`);
          return { message: entry.message, attestation: entry.attestation };
        }
        console.log(`⏳ Attempt ${attempt + 1}/${maxAttempts} — status: ${entry?.status || 'not found yet'}`);
      } else {
        console.warn(`⚠️ Iris V2 responded with ${res.status}`);
      }
    } catch (err: any) {
      console.warn(`⚠️ Iris V2 poll error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `CCTP V2 attestation timed out after ${maxAttempts} attempts (${(maxAttempts * intervalMs) / 1000}s) ` +
    `for tx ${transactionHash}. The burn tx may still be confirming on the source chain.`
  );
}

// ─── Submit V2 attestation to Arc MessageTransmitter ─────────────────────────
export async function mintOnArc(message: string, attestation: string): Promise<string> {
  const adminKey = process.env.ARC_ADMIN_PRIVATE_KEY;
  if (!adminKey) throw new Error('ARC_ADMIN_PRIVATE_KEY not set in environment.');

  const account = privateKeyToAccount(adminKey as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http('https://rpc.testnet.arc.network'),
  });

  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http('https://rpc.testnet.arc.network'),
  });

  console.log(`⚡ Submitting CCTP V2 attestation to Arc MessageTransmitterV2...`);

  const txHash = await walletClient.writeContract({
    address: MESSAGE_TRANSMITTER_V2 as `0x${string}`,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: 'receiveMessage',
    args: [message as `0x${string}`, attestation as `0x${string}`],
  });

  // Arc's sub-second finality — usually confirms in <1s
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  console.log(`✅ USDC minted on Arc L1 via CCTP V2. Tx: ${txHash}`);
  return txHash;
}

// ─── Verify Circle webhook signature ─────────────────────────────────────────
export function verifyCircleWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  const secret = process.env.CIRCLE_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  try {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const expected = hmac.digest('hex');
    return signatureHeader === expected;
  } catch {
    return false;
  }
}

// ─── CCTP V2 source chain domains ────────────────────────────────────────────
export const CHAIN_DOMAINS: Record<number, string> = {
  0: 'Ethereum Mainnet',
  1: 'Avalanche',
  2: 'Optimism',
  3: 'Arbitrum',
  6: 'Base',
  7: 'Polygon',
  26: 'Arc Testnet',
};

export function getChainName(domain: number): string {
  return CHAIN_DOMAINS[domain] || `Chain Domain ${domain}`;
}

// ─── Build CCTP V2 burn message for source chain ──────────────────────────────
// Used when initiating a cross-chain transfer from source to Arc
export function buildCCTPV2TransferParams(recipientAddress: string, amount: bigint) {
  return {
    destinationDomain: ARC_TESTNET_DOMAIN,
    mintRecipient: recipientAddress,
    burnToken: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // USDC on Ethereum Sepolia
    amount,
  };
}
