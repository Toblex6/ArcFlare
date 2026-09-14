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
//
// MAINNET PORTABILITY (explicit TODOs — nothing invented here):
//   - Source chains below are the Sepolia/Amoy TESTNET set. Mainnet needs
//     the production source list (e.g. Arbitrum/Base/Optimism/Ethereum/
//     Polygon mainnets) with Circle's exact mainnet `circleBlockchain`
//     identifiers — confirm against Circle Developer-Controlled Wallets +
//     Bridge Kit docs, then supply via CCTP_MAINNET_SOURCES_JSON (array of
//     { id, label, circleBlockchain }) or extend the table below. Until
//     then, mainnet bridging refuses closed (see getCctpSources()).
//   - The Arc destination BridgeChain enum below is 'Arc_Testnet'. The
//     mainnet enum value (expected 'Arc' — UNCONFIRMED) must be verified
//     against the installed @circle-fin/bridge-kit BridgeChain enum, then
//     supplied via CCTP_MAINNET_ARC_CHAIN_ID; no mainnet value is assumed.

import { BridgeKit, BridgeChain } from '@circle-fin/bridge-kit';
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets';
import type { BridgeResult } from '@circle-fin/bridge-kit';
import { getArcNetworkName, getNetworkConfig } from '@/lib/config/network';

// ── BridgeKit compatibility guard ────────────────────────────────────────────
// BridgeChain is the CANONICAL source of bridging-supported chains for the
// installed @circle-fin/bridge-kit (1.13.0 in this repo: Arc_Testnet only, NO
// Arc mainnet member — verified 2026-09-13). Mainnet chain ids supplied via
// env are validated against this enum so a typo or a pre-support value fails
// fast here instead of inside kit.bridge(). NOTE: until Circle ships a
// bridge-kit containing an Arc mainnet member, NO value can satisfy the
// destination check below — mainnet bridging stays fail-closed by
// construction, which is the correct posture (see .env.example).
function assertBridgeChainMember(value: string, envVar: string): void {
  const members = new Set<string>(Object.values(BridgeChain) as string[]);
  if (!members.has(value)) {
    throw new Error(
      `${envVar}="${value}" is not a member of the installed @circle-fin/bridge-kit BridgeChain enum ` +
        `(no Arc mainnet member exists in the installed version — mainnet bridging is unsupported until Circle ships one). ` +
        `Verify against the installed package before setting this variable.`
    );
  }
}

// ── Supported source chains (where a user can bridge USDC from) ──
// `id` matches BridgeChain enum members (what Bridge Kit expects).
// `circleBlockchain` is Circle's own Developer-Controlled Wallets
// identifier for the same chain (a different naming scheme) — needed to
// provision a consumer's wallet there before they can bridge from it.
//
// TESTNET set (Sepolia/Amoy). Mainnet overrides come from
// CCTP_MAINNET_SOURCES_JSON — see getCctpSources().
const TESTNET_SOURCE_CHAINS = [
  { id: 'Arbitrum_Sepolia', label: 'Arbitrum Sepolia', testnet: true, circleBlockchain: 'ARB-SEPOLIA' },
  { id: 'Base_Sepolia', label: 'Base Sepolia', testnet: true, circleBlockchain: 'BASE-SEPOLIA' },
  { id: 'Optimism_Sepolia', label: 'Optimism Sepolia', testnet: true, circleBlockchain: 'OP-SEPOLIA' },
  { id: 'Ethereum_Sepolia', label: 'Ethereum Sepolia', testnet: true, circleBlockchain: 'ETH-SEPOLIA' },
  { id: 'Polygon_Amoy_Testnet', label: 'Polygon Amoy', testnet: true, circleBlockchain: 'MATIC-AMOY' },
] as const;

export interface CctpSourceChain {
  id: string;
  label: string;
  testnet: boolean;
  circleBlockchain: string;
}

/**
 * Environment-selected CCTP source chains. Testnet returns the pinned
 * Sepolia/Amoy table (unchanged behavior). Mainnet requires explicit
 * CCTP_MAINNET_SOURCES_JSON (JSON array of { id, label, circleBlockchain })
 * and FAILS CLOSED otherwise — testnet Sepolia values are never offered on
 * mainnet. Entries are validated (non-empty id/label/circleBlockchain) but
 * the VALUES themselves must be confirmed against Circle docs (not invented).
 */
export function getCctpSources(
  env: Record<string, string | undefined> = process.env
): CctpSourceChain[] {
  if (getArcNetworkName(env) !== 'mainnet') {
    return TESTNET_SOURCE_CHAINS.map((c) => ({ ...c }));
  }
  const raw = (env.CCTP_MAINNET_SOURCES_JSON ?? '').trim();
  if (!raw) {
    throw new Error(
      'CCTP_MAINNET_SOURCES_JSON is required on mainnet — the Sepolia/Amoy testnet source list is never offered on mainnet. ' +
        'Set it to a JSON array of { id, label, circleBlockchain } confirmed against Circle Developer-Controlled Wallets + Bridge Kit docs.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CCTP_MAINNET_SOURCES_JSON is not valid JSON (expected an array of { id, label, circleBlockchain }).');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('CCTP_MAINNET_SOURCES_JSON must be a non-empty array of { id, label, circleBlockchain }.');
  }
  return parsed.map((entry: any, i: number) => {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
    const circleBlockchain = typeof entry?.circleBlockchain === 'string' ? entry.circleBlockchain.trim() : '';
    if (!id || !label || !circleBlockchain) {
      throw new Error(
        `CCTP_MAINNET_SOURCES_JSON[${i}] must carry non-empty { id, label, circleBlockchain } (got ${JSON.stringify(entry)}).`
      );
    }
    // Fail fast on ids the installed BridgeKit cannot bridge (typos or
    // chains without CCTPv2 support in this bridge-kit version).
    assertBridgeChainMember(id, `CCTP_MAINNET_SOURCES_JSON[${i}].id`);
    return { id, label, testnet: false, circleBlockchain };
  });
}

/** Back-compat export: testnet table (existing importers keep working). */
export const CCTP_SOURCE_CHAINS: readonly CctpSourceChain[] = TESTNET_SOURCE_CHAINS.map((c) => ({ ...c }));

// ── Destination chains (Arc is the only one this app bridges into) ─────────
// All destination configuration derives from the authoritative network config:
//   - the testnet flag + label follow the selected ARC_NETWORK;
//   - the CCTP V2 destination chain identifier (domain), MessageTransmitter,
//     destination chain id and Iris URL are owned by network.ts (mainnet fails
//     closed without the ARC_MAINNET_CCTP_* inputs).
// `id` is Circle Bridge Kit's destination-chain ENUM — a product constant
// Bridge Kit resolves internally, not a network literal, so it is not
// duplicated from network.ts (there is no network field for it).
// TESTNET: 'Arc_Testnet' (verified). MAINNET: the enum value is UNCONFIRMED
// (expected 'Arc' — do NOT assume); supply CCTP_MAINNET_ARC_CHAIN_ID after
// verifying against the installed BridgeKit BridgeChain enum, else mainnet
// bridging fails closed here rather than bridging to a wrong chain.
export function getCctpDestination() {
  const net = getNetworkConfig();
  const isTestnet = net.name !== 'mainnet';
  if (!isTestnet) {
    const arcChainId = (process.env.CCTP_MAINNET_ARC_CHAIN_ID ?? '').trim();
    if (!arcChainId) {
      throw new Error(
        'CCTP_MAINNET_ARC_CHAIN_ID is required on mainnet — the BridgeKit Arc destination enum is unconfirmed ' +
          "(expected 'Arc', UNVERIFIED). Verify against the installed @circle-fin/bridge-kit BridgeChain enum, then set CCTP_MAINNET_ARC_CHAIN_ID explicitly."
      );
    }
    // Must be a real BridgeChain member of the INSTALLED bridge-kit, not an
    // assumed string. (Installed 1.13.0 has no Arc mainnet member, so this
    // throws until Circle ships one — fail-closed by construction.)
    assertBridgeChainMember(arcChainId, 'CCTP_MAINNET_ARC_CHAIN_ID');
    return {
      id: arcChainId as 'Arc_Testnet',
      label: 'Arc Mainnet',
      testnet: false,
      // CCTP V2 destination values owned by network.ts:
      destinationDomain: net.cctpDomain,
      messageTransmitter: net.cctpMessageTransmitter,
      destinationChainId: net.chainId,
      irisApiUrl: net.irisApiUrl,
    };
  }
  return {
    id: 'Arc_Testnet' as const,
    label: 'Arc Testnet',
    testnet: net.name !== 'mainnet',
    // CCTP V2 destination values owned by network.ts:
    destinationDomain: net.cctpDomain,
    messageTransmitter: net.cctpMessageTransmitter,
    destinationChainId: net.chainId,
    irisApiUrl: net.irisApiUrl,
  };
}

/** Back-compat export: environment-selected destination list (lazy getter). */
export function getCctpDestinations() {
  return [getCctpDestination()];
}

export const CCTP_DEST_CHAINS = [getCctpDestination()];

let cachedAdapter: ReturnType<typeof createCircleWalletsAdapter> | null = null;
let cachedKit: BridgeKit | null = null;

// The @circle-fin/adapter-circle-wallets and @circle-fin/bridge-kit package
// versions in this repo don't line up at the type level (the adapter's
// exported type isn't assignable to Bridge Kit's Adapter interface), but
// the runtime shape is what Bridge Kit expects. Cast once here so call
// sites stay typed.
function toBridgeAdapter(adapter: ReturnType<typeof createCircleWalletsAdapter>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return adapter as any;
}

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
  return { kit: cachedKit, adapter: toBridgeAdapter(cachedAdapter) };
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
