// src/lib/cctp-v2.ts
//
// Bridges USDC into Arc using Circle's own official Bridge Kit
// (@circle-fin/bridge-kit) instead of a generic third-party CCTP SDK.
// Bridge Kit ships dedicated bridge/adapter contracts deployed specifically
// for Arc, and is Circle's documented, supported path for this exact flow
// (see: circle.com/blog/consolidate-crosschain-usdc-fast-low-cost-transfers-with-cctp-and-gateway).
//
// Signing model: every transfer runs from the *consumer's own* Circle
// Developer-Controlled Wallet — never a shared platform wallet. The
// Circle Wallets adapter is "developer-controlled" (addressContext:
// 'developer-controlled'), meaning the wallet address is passed per
// operation, not baked into the adapter. One adapter instance (built from
// our existing CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET) is reused for every
// user; each call just points `from.address` / `to.address` at whichever
// wallet is relevant. This avoids the platform ever custodying funds beyond
// what each user's own wallet already holds.

import { BridgeKit, BridgeChain } from '@circle-fin/bridge-kit';
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets';
import type { BridgeResult } from '@circle-fin/bridge-kit';

// ── Supported source chains (where a user can bridge USDC from) ──
// `id` matches BridgeChain enum members (what Bridge Kit expects).
// `circleBlockchain` is Circle's own Developer-Controlled Wallets
// identifier for the same chain (a different naming scheme) — needed to
// provision a consumer's wallet there before they can bridge from it.
export const CCTP_SOURCE_CHAINS = [
  { id: 'Arbitrum_Sepolia', label: 'Arbitrum Sepolia', testnet: true, circleBlockchain: 'ARB-SEPOLIA' },
  { id: 'Base_Sepolia', label: 'Base Sepolia', testnet: true, circleBlockchain: 'BASE-SEPOLIA' },
  { id: 'Optimism_Sepolia', label: 'Optimism Sepolia', testnet: true, circleBlockchain: 'OP-SEPOLIA' },
  { id: 'Ethereum_Sepolia', label: 'Ethereum Sepolia', testnet: true, circleBlockchain: 'ETH-SEPOLIA' },
  { id: 'Polygon_Amoy_Testnet', label: 'Polygon Amoy', testnet: true, circleBlockchain: 'MATIC-AMOY' },
] as const;

// ── Destination chains (Arc is the only one this app bridges into) ──
export const CCTP_DEST_CHAINS = [
  { id: 'Arc_Testnet', label: 'Arc Testnet', testnet: true },
] as const;

let cachedAdapter: ReturnType<typeof createCircleWalletsAdapter> | null = null;
let cachedKit: BridgeKit | null = null;

function getKitAndAdapter() {
  if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
    throw new Error(
      'Missing Circle credentials: CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set in environment'
    );
  }
  if (!cachedAdapter) {
    cachedAdapter = createCircleWalletsAdapter({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });
  }
  if (!cachedKit) {
    cachedKit = new BridgeKit();
  }
  return { kit: cachedKit, adapter: cachedAdapter };
}

// In-memory store for in-flight bridge results, keyed by a reference we
// hand back to the client immediately. `kit.bridge()` itself still runs to
// completion (or to Bridge Kit's own 'pending' state) in the background —
// we never await it inside the HTTP request, since Circle's attestation for
// Arc specifically can take much longer than any request should stay open.
//
// NOTE: this is process-local. On a single long-running Render instance
// (which is how this app is deployed) that's fine; it will NOT survive a
// restart or work across multiple instances. If that becomes a problem,
// move this to a DB table (store the BridgeResult as JSON).
type TrackedTransfer =
  | { status: 'submitting' } // bridge() call is still in flight, no result yet
  | { status: 'settled'; result: BridgeResult }
  | { status: 'error'; message: string };

const pendingTransfers = new Map<string, TrackedTransfer>();

function makeReference(): string {
  return `bridge_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

// Returns immediately with a reference — does NOT wait for the bridge to
// complete, or even for the source burn to confirm. Call checkBridgeStatus
// with the returned reference to follow progress.
export function startBridge(params: {
  fromChain: string; // one of CCTP_SOURCE_CHAINS ids
  toChain: string; // one of CCTP_DEST_CHAINS ids ("Arc_Testnet")
  amount: string;
  senderAddress: `0x${string}`; // the consumer's own Circle wallet address
  recipientAddress: `0x${string}`; // where minted USDC should land on the destination
}): { reference: string } {
  const { fromChain, toChain, amount, senderAddress, recipientAddress } = params;
  const reference = makeReference();
  pendingTransfers.set(reference, { status: 'submitting' });

  console.log(
    `[Bridge Kit] starting ${amount} USDC ${fromChain} -> ${toChain}, wallet ${senderAddress} (ref ${reference})`
  );

  // Deliberately not awaited — this keeps running after the HTTP response
  // that called startBridge() has already been sent.
  (async () => {
    try {
      const { kit, adapter } = getKitAndAdapter();
      const result = await kit.bridge({
        from: { adapter, chain: fromChain as BridgeChain, address: senderAddress },
        to: { adapter, chain: toChain as BridgeChain, address: recipientAddress },
        amount,
      });
      pendingTransfers.set(reference, { status: 'settled', result });
    } catch (err: any) {
      console.error(`[Bridge Kit] ${reference} failed:`, err);
      pendingTransfers.set(reference, { status: 'error', message: err?.message || 'Bridge failed.' });
    }
  })();

  return { reference };
}

export async function checkBridgeStatus(
  reference: string
): Promise<
  | { status: 'submitting' }
  | { status: 'settled'; result: BridgeResult }
  | { status: 'error'; message: string }
  | null
> {
  const tracked = pendingTransfers.get(reference);
  if (!tracked) return null;

  if (tracked.status !== 'settled' || tracked.result.state !== 'pending') {
    return tracked;
  }

  // The underlying BridgeResult itself reports 'pending' (e.g. still
  // waiting on Circle's relayer for the destination mint) — ask Bridge Kit
  // to check on it rather than re-running bridge() from scratch, which
  // would resubmit the burn.
  const { kit, adapter } = getKitAndAdapter();
  const updated = await kit.retry(tracked.result, { from: adapter, to: adapter });
  const next: TrackedTransfer = { status: 'settled', result: updated };
  pendingTransfers.set(reference, next);
  return next;
}

// Bridge Kit's own step objects already carry a ready-made explorerUrl
// (per-chain, so the source burn and destination mint links are correct
// for whichever chain that step actually happened on) — just look the
// step up by name instead of reconstructing a URL ourselves.
export function findStep(result: BridgeResult, name: 'Approve' | 'Burn' | 'Mint') {
  return result.steps.find((s) => s.name === name);
}
