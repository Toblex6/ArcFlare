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
//   - Installed Bridge Kit 1.15.1 includes BridgeChain.Arc = 'Arc' (mainnet).
//     CCTP_MAINNET_ARC_CHAIN_ID must explicitly be that CHAIN NAME, not the
//     EVM chain ID 5042 or CCTP domain 26. No destination is defaulted.

import { BridgeKit, BridgeChain } from '@circle-fin/bridge-kit';
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets';
import type { BridgeResult } from '@circle-fin/bridge-kit';
import { getArcNetworkName, getNetworkConfig } from '@/lib/config/network';
// Canonical EXTERNAL Bridge source table (single authority for the supported
// set, labels, and BridgeKit ids). The CIRCLE server-signed path below keeps
// its own { id, label, testnet, circleBlockchain } view derived from it —
// the values are mapped, never re-declared.
import { getBridgeSourceChains } from '@/lib/bridge/sourceChains';
import { CctpUnavailableError } from '@/lib/bridge/cctpAvailability';
import { getCircleClient } from '@/lib/circle/client';
import { withCircleBridgeAdapterGuard } from '@/lib/circle/networkGuard';
import { extractBurnTxHash } from '@/lib/bridge/resumeStore';
import { withReadOnlyBridgeAdapter } from '@/lib/bridge/readOnlyAdapter';

// ── BridgeKit compatibility guard ────────────────────────────────────────────
// BridgeChain is the CANONICAL source of bridging-supported chains for the
// installed @circle-fin/bridge-kit (1.15.1: Arc and Arc_Testnet supported).
// These identifiers are chain NAMES, validated before kit.bridge(). Package
// support alone does not enable our Circle server-signed source-wallet flow.
function assertBridgeChainMember(value: string, envVar: string): void {
  const members = new Set<string>(Object.values(BridgeChain) as string[]);
  if (!members.has(value)) {
    throw new CctpUnavailableError(
      `${envVar}="${value}" is not a member of the installed @circle-fin/bridge-kit BridgeChain enum ` +
        `Use a chain name from the installed package, not an EVM chain ID or CCTP domain.`
    );
  }
}

// ── Supported source chains (where a user can bridge USDC from) ──
// Derived from the canonical EXTERNAL Bridge table
// (src/lib/bridge/sourceChains.ts) — the supported SET, labels, and
// BridgeKit ids live there. `circleBlockchain` (Circle's own
// Developer-Controlled Wallets identifier for the same chain) is carried
// along because the CIRCLE server-signed path keys source provisioning off
// it; `testnet` marks the Sepolia/Amoy TESTNET set.
//
// TESTNET set (Sepolia/Amoy). Mainnet overrides come from
// CCTP_MAINNET_SOURCES_JSON — see getCctpSources().
function buildTestnetSourceChains() {
  return getBridgeSourceChains().map((s) => ({
    id: s.id,
    label: s.label,
    testnet: true as const,
    circleBlockchain: s.circleBlockchain,
  }));
}

const TESTNET_SOURCE_CHAINS = buildTestnetSourceChains();

export interface CctpSourceChain {
  id: string;
  label: string;
  testnet: boolean;
  circleBlockchain: string;
}

/**
 * Validate the retained future mainnet source metadata. This is intentionally
 * separate from getCctpSources(): the installed Circle adapter currently
 * refuses mainnet execution even when these values are well formed.
 */
export function parseConfiguredMainnetCctpSources(
  env: Record<string, string | undefined> = process.env
): CctpSourceChain[] {
  const raw = (env.CCTP_MAINNET_SOURCES_JSON ?? '').trim();
  if (!raw) {
    throw new CctpUnavailableError(
      'CCTP_MAINNET_SOURCES_JSON is required on mainnet — the Sepolia/Amoy testnet source list is never offered on mainnet.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CctpUnavailableError('CCTP_MAINNET_SOURCES_JSON is not valid JSON (expected an array of { id, label, circleBlockchain }).');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CctpUnavailableError('CCTP_MAINNET_SOURCES_JSON must be a non-empty array of { id, label, circleBlockchain }.');
  }
  return parsed.map((entry: unknown, i: number) => {
    const item = entry as Record<string, unknown> | null;
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    const circleBlockchain = typeof item?.circleBlockchain === 'string' ? item.circleBlockchain.trim() : '';
    if (!id || !label || !circleBlockchain) {
      throw new CctpUnavailableError(`CCTP_MAINNET_SOURCES_JSON[${i}] must carry non-empty { id, label, circleBlockchain }.`);
    }
    assertBridgeChainMember(id, `CCTP_MAINNET_SOURCES_JSON[${i}].id`);
    return { id, label, testnet: false, circleBlockchain };
  });
}

/**
 * Environment-selected CCTP source chains. Testnet returns the pinned
 * Sepolia/Amoy table (unchanged behavior). Mainnet server signing is refused:
 * adapter-circle-wallets 1.4.3 embeds adapter-viem-v2 1.14.0, whose chain
 * registry has Arc_Testnet but not Arc. Listing configured source metadata
 * would therefore overstate an execution path that cannot initialize its Arc
 * destination client. The separate browser-signed external flow is unaffected.
 */
export function getCctpSources(
  env: Record<string, string | undefined> = process.env
): CctpSourceChain[] {
  if (getArcNetworkName(env) !== 'mainnet') {
    return TESTNET_SOURCE_CHAINS.map((c) => ({ ...c }));
  }
  // Validate operator metadata so malformed future configuration remains
  // observable, then fail closed on the installed adapter incompatibility.
  parseConfiguredMainnetCctpSources(env);
  throw new CctpUnavailableError(
    'Circle server-signed CCTP is unavailable on mainnet: the installed Circle Wallets adapter cannot initialize Arc Mainnet. Use the separately gated external-wallet bridge; no signing request was submitted.'
  );
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
// TESTNET: 'Arc_Testnet'. MAINNET: explicitly configured 'Arc', verified in
// installed Bridge Kit 1.15.1. Configuration is lazy and never defaulted.
export function getCctpDestination(env: Record<string, string | undefined> = process.env) {
  const net = getNetworkConfig(env);
  const isTestnet = net.name !== 'mainnet';
  if (!isTestnet) {
    const arcChainId = (env.CCTP_MAINNET_ARC_CHAIN_ID ?? '').trim();
    if (!arcChainId) {
      throw new CctpUnavailableError(
        "CCTP_MAINNET_ARC_CHAIN_ID is required for mainnet bridging — set it explicitly to the Bridge Kit chain NAME 'Arc', not EVM chain ID 5042 or CCTP domain 26."
      );
    }
    assertBridgeChainMember(arcChainId, 'CCTP_MAINNET_ARC_CHAIN_ID');
    if (arcChainId !== BridgeChain.Arc) {
      throw new CctpUnavailableError("CCTP_MAINNET_ARC_CHAIN_ID must be the mainnet chain NAME 'Arc'; other destinations and Arc_Testnet are refused.");
    }
    return {
      id: BridgeChain.Arc,
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
export function getCctpDestinations(env: Record<string, string | undefined> = process.env) {
  return [getCctpDestination(env)];
}

// Former eager CCTP_DEST_CHAINS export removed: all consumers use the lazy
// getCctpDestinations(). Importing this module must not require bridge env.

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
    throw new CctpUnavailableError(
      'Missing Circle credentials: CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set in environment'
    );
  }
  if (!cachedAdapter) {
    cachedAdapter = withCircleBridgeAdapterGuard(createCircleWalletsAdapter({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    }), getCircleClient());
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
  toChain: string; // configured Bridge Kit chain NAME ("Arc_Testnet" / "Arc")
  amount: string;
  senderAddress: `0x${string}`; // the consumer's own Circle wallet address
  recipientAddress: `0x${string}`; // where minted USDC should land on the destination
}): { reference: string } {
  const { fromChain, toChain, amount, senderAddress, recipientAddress } = params;
  // Validate configuration and initialize credentials synchronously: never
  // claim "pending" then discover a missing bridge dependency in background.
  const sources = getCctpSources();
  const destinations = getCctpDestinations();
  if (!sources.some((source) => source.id === fromChain) || !destinations.some((dest) => dest.id === toChain)) {
    throw new CctpUnavailableError('Bridge chains do not match the configured source/destination list.');
  }
  const { kit, adapter } = getKitAndAdapter();
  if (getArcNetworkName() === 'mainnet') {
    const source = sources.find((entry) => entry.id === fromChain)!;
    if (source.circleBlockchain !== getNetworkConfig().circleBlockchain || /TESTNET|SEPOLIA|AMOY/i.test(source.circleBlockchain)) {
      throw new CctpUnavailableError('The signing wallet must be on the active Arc network; cross-chain Circle source wallets are not provisioned by this flow.');
    }
  }
  const reference = makeReference();
  pendingTransfers.set(reference, { status: 'submitting' });

  console.log(
    `[Bridge Kit] starting ${amount} USDC ${fromChain} -> ${toChain}, wallet ${senderAddress} (ref ${reference})`
  );

  // Deliberately not awaited — this keeps running after the HTTP response
  // that called startBridge() has already been sent.
  (async () => {
    try {
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

  // No automatic mainnet signing from a status GET. The external browser
  // bridge has its own receipt/Iris recovery and never calls this SDK path.
  // A pending approval is not permission to submit a missing burn either.
  if (getArcNetworkName() === 'mainnet' || !extractBurnTxHash(tracked.result)) return tracked;

  // Preserve legacy testnet destination-mint recovery only after a source
  // hash exists. SDK retry cannot reopen source signing, even for an
  // ambiguous/pending burn or a future change to its step analysis.
  const { kit, adapter } = getKitAndAdapter();
  const updated = await kit.retry(tracked.result, { from: withReadOnlyBridgeAdapter(adapter), to: adapter });
  const next: TrackedTransfer = { status: 'settled', result: updated };
  pendingTransfers.set(reference, next);
  return next;
}

// Bridge Kit's own step objects already carry a ready-made explorerUrl
// (per-chain, so the source burn and destination mint links are correct
// for whichever chain that step actually happened on) — just look the
// step up by name instead of reconstructing a URL ourselves.
//
// Step names are lowercase at runtime in the installed SDK
// ('approve' | 'burn' | 'fetchAttestation' | 'mint'; QUICKSTART also
// documents 'depositForBurn' for the source-tx leg), so match
// case-insensitively and accept the depositForBurn burn alias.
const BURN_STEP_ALIASES = new Set(['burn', 'depositforburn', 'deposit_for_burn']);
export function findStep(result: BridgeResult, name: 'Approve' | 'Burn' | 'Mint') {
  const want = name.toLowerCase();
  return result.steps.find((s) => {
    const n = String(s.name ?? '').toLowerCase();
    if (want === 'burn') return n === 'burn' || BURN_STEP_ALIASES.has(n);
    return n === want;
  });
}
