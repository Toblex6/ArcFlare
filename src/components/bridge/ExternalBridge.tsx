// src/components/bridge/ExternalBridge.tsx
//
// EXTERNAL multi-chain Bridge UI: source-chain USDC in the user's own
// browser wallet -> Circle CCTP / BridgeKit -> Arc -> the user's
// own FlareHQ CIRCLE wallet.
//
// Non-custodial throughout: the browser wallet signs the source-chain
// approve/burn via Circle BridgeKit's viem adapter
// (createViemAdapterFromProvider over the wagmi connector's EIP-1193
// provider). The server never signs, never sees keys, and never accepts a
// browser-supplied destination — the intent route server-resolves the
// destination from the authenticated session, and verify/complete prove the
// burn and mint from on-chain receipts before anything is recorded.
//
// Double-submit protection: a synchronous busy ref + phase gating means two
// rapid taps produce exactly one kit.bridge() call. Confirmed burns resume
// settlement only. Approval/burn retries require an explicit wallet-activity
// check and reuse the SAME intent, never an automatic fresh spend.
//
// Client component (dynamic SDK imports keep SSR safe).

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { createPublicClient, http, parseAbi } from 'viem';
import {
  getBridgeSourceChains,
  validateBridgeAmount,
  formatBridgeBaseUnits,
  sourceExplorerTxUrl,
  type BridgeAmountError,
} from '@/lib/bridge/sourceChains';
import { sourceViemChainFor } from '@/lib/bridge/sourceViemChains';
import {
  saveBridgeResume,
  loadBridgeResume,
  clearBridgeResume,
  extractBurnTxHash,
} from '@/lib/bridge/resumeStore';
import {
  checkBridgePreflight,
  MIN_NATIVE_WEI,
} from '@/lib/bridge/preflight';
import { ensureEvmNetwork } from '@/lib/wallet/ensureEvmNetwork';
import { friendlyBridgeError } from '@/lib/wallet/walletErrors';
import { useNetwork } from '@/src/components/NetworkContext';
import { bridgeEventHash, bridgeHasRecoveryEvidence, bridgeNeedsBurnReview, bridgeResultFailure, canRetryBridgeBeforeBurn, selectBridgeRecoveryHash } from '@/lib/bridge/resultState';
import { pollBridgeSettlementStatus } from '@/lib/bridge/settlementPolling';

const USDC_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// Attestation + relayer mint can take minutes: bounded polling with an
// explicit "keep waiting" resume instead of an unbounded hang.
const RETRY_ROUNDS = 20;
const RETRY_DELAY_MS = 15_000;

type Phase =
  | 'form'
  | 'working'
  | 'awaiting-resume'
  | 'receipt';

type StageKey = 'approve' | 'burn' | 'attestation' | 'mint';
interface StageState {
  key: StageKey;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function amountCopy(e: BridgeAmountError, label: string): string {
  switch (e) {
    case 'EMPTY':
      return '';
    case 'MALFORMED':
      return 'Enter a valid USDC amount (numbers only, e.g. 10.00).';
    case 'TOO_MANY_DECIMALS':
      return 'USDC supports at most 6 decimals.';
    case 'ZERO_OR_NEGATIVE':
      return 'Bridge amount must be greater than zero.';
    case 'INSUFFICIENT_BALANCE':
      return `Your connected wallet does not have enough USDC on ${label}.`;
  }
}

interface KitStep {
  name?: string;
  state?: string;
  txHash?: string;
}

// ── Development-safe stage diagnostics ───────────────────────────────────────
// The observable A–L failure trail (source chain, external address, balance,
// destination, intent, BridgeKit init, approval/burn hashes, attestation, Arc
// mint, completion) as a single console.debug trail in non-production builds
// only. Never rendered to the user, never sent anywhere, never in prod logs —
// it exists so a real-browser failure can be pinned to its exact stage.
const BRIDGE_DIAG_ENABLED = process.env.NODE_ENV !== 'production';
function bridgeDiag(stage: string, data: unknown): void {
  if (BRIDGE_DIAG_ENABLED) console.debug(`[external-bridge:diag] ${stage}`, data);
}

// ── Step trail (diagnosis instrumentation, no behavior change) ──
// Dev-only like bridgeDiag above (gated by NODE_ENV): production browsers
// emit NOTHING — the step name + intent reference + public tx hashes / step
// states at the four sub-steps that matter ((a) intent created, (b/c) wallet
// signing via kit.bridge, (d) verify POST) stay a local debug trail. No
// keys, no seed phrases, no provider internals. Server-side
// [bridge-stage] / [cctp/transfer/external/verify] log lines remain the
// production correlation source. console.error calls below are untouched —
// operational error logging stays.
function bridgeTrace(step: string, data?: unknown): void {
  if (!BRIDGE_DIAG_ENABLED) return;
  try {
    if (data === undefined) console.debug(`[external-bridge] ${step}`);
    else console.debug(`[external-bridge] ${step}`, data);
  } catch {
    // logging must never break the flow
  }
}

const BURN_STEP_ALIASES = new Set(['burn', 'depositforburn', 'deposit_for_burn']);

function stepOf(result: any, name: 'Approve' | 'Burn' | 'Mint'): KitStep | null {
  const steps: KitStep[] = Array.isArray(result?.steps) ? result.steps : [];
  const want = name.toLowerCase();
  return (
    steps.find((s) => {
      const n = String(s?.name ?? '').toLowerCase();
      if (!n) return false;
      // The burn leg is named 'burn' at runtime in the installed SDK, but
      // QUICKSTART documents 'depositForBurn' as the source-tx step in some
      // flows — accept both so a valid burn hash is never missed.
      if (want === 'burn') return n === 'burn' || BURN_STEP_ALIASES.has(n);
      return n === want;
    }) ?? null
  );
}

// Raw step summary for the production trace: step names exactly as the SDK
// emitted them, so a future naming variant shows up as data instead of
// silent nulls (a previous SDK-shape mismatch surfaced as
// approve/burn/mint all null with state 'success').
function rawStepSummary(result: any): Array<{ name: string | null; state: string | null; hasTx: boolean }> {
  const steps: KitStep[] = Array.isArray(result?.steps) ? result.steps : [];
  return steps.map((s) => ({
    name: typeof s?.name === 'string' ? s.name : null,
    state: typeof s?.state === 'string' ? s.state : null,
    hasTx: typeof s?.txHash === 'string' && s.txHash.length > 0,
  }));
}

// Server-side stage enum values → user-facing labels.
const STAGE_LABELS: Record<string, string> = {
  PREPARING: 'Preparing bridge',
  APPROVAL_PENDING: 'Waiting for wallet approval',
  APPROVAL_CONFIRMED: 'Approval confirmed',
  BURN_PENDING: 'Submitting source burn',
  BURN_CONFIRMED: 'Source burn confirmed',
  ATTESTATION_PENDING: 'Waiting for Circle attestation',
  ATTESTATION_CONFIRMED: 'Circle attestation received',
  MINT_PENDING: 'Minting on Arc',
  MINT_CONFIRMED: 'Mint confirmed on Arc',
  VERIFIED: 'Bridge verified',
  FAILED: 'Bridge step needs attention',
};

/**
 * Fetch the current server-side stage for an intent. Returns null on any
 * error (the existing error message is used as a fallback).
 */
async function fetchBridgeStage(reference: string): Promise<{ stage: string | null; txHash: string | null }> {
  try {
    const res = await fetch(`/api/cctp/transfer/external/status?reference=${reference}`);
    const data = await res.json();
    if (data?.success) {
      return { stage: data.currentStage ?? null, txHash: data.lastStageTxHash ?? null };
    }
  } catch {}
  return { stage: null, txHash: null };
}

export interface ExternalBridgeProps {
  /** EXTERNAL session walletAddress (the source wallet). */
  sessionAddress: string;
  /** Refresh Recent Activity after a verified completion. */
  onBridgeCompleted: () => void;
  /**
   * Enter the EXISTING email onboarding flow (OTP → verified consumer identity
   * → FlareHQ CIRCLE wallet). INVARIANT: this bridge NEVER provisions a
   * FlareHQ wallet directly — there is no wallet-creation call from here, and
   * the CIRCLE wallet is created/retrieved only after email verification by
   * /api/consumer/email-auth (the page owns the flow and returns to Bridge).
   */
  onContinueWithEmail: () => void;
  /**
   * Bumped by the page whenever the bridge-destination link may have changed
   * (returning from email onboarding, or an explicit wallet reconnect that
   * just re-proved the external wallet). The component stays MOUNTED through
   * onboarding — the email form is an overlay — and the returning session can
   * be the very same external address, so `sessionAddress` alone is not a
   * usable change signal: without this key the destination preview would keep
   * showing the stale "not linked yet" gate even after the server recorded the
   * link. Re-resolving re-runs the server-authoritative preview only; selected
   * source chain and amount are component state and are never reset.
   */
  destinationRefreshKey?: number;
}

export default function ExternalBridge({
  sessionAddress,
  onBridgeCompleted,
  onContinueWithEmail,
  destinationRefreshKey = 0,
}: ExternalBridgeProps) {
  // Server-resolved network (production-safe mainnet default until
  // /api/network resolves). Sources follow the network: Sepolia/Amoy
  // test chains on testnet, Ethereum/Base/Arbitrum/Optimism/Polygon/
  // Avalanche → Arc Mainnet on mainnet (Step D).
  const { name: networkName } = useNetwork();
  const bridgeNetwork = networkName === 'mainnet' ? 'mainnet' : 'testnet';
  const [availability, setAvailability] = useState<{
    available: boolean; network: string | null; message: string | null;
  } | null>(null);
  const bridgeAvailable = availability?.available === true && availability.network === bridgeNetwork;
  useEffect(() => {
    let cancelled = false;
    setAvailability(null);
    fetch('/api/cctp/transfer/external/availability', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setAvailability({ available: data?.available === true, network: data?.network ?? null, message: data?.message ?? null });
      })
      .catch(() => {
        if (!cancelled) setAvailability({ available: false, network: null, message: 'Could not check bridge availability. No signing request has been opened.' });
      });
    return () => { cancelled = true; };
  }, [bridgeNetwork, destinationRefreshKey]);
  const sources = useMemo(() => getBridgeSourceChains(bridgeNetwork), [bridgeNetwork]);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? 'Arbitrum_Sepolia');
  // Clamp a stale testnet/mainnet selection when the network resolves.
  useEffect(() => {
    if (!sources.some((s) => s.id === sourceId)) {
      setSourceId(sources[0]?.id ?? 'Arbitrum_Sepolia');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeNetwork]);
  const source = useMemo(
    () => sources.find((s) => s.id === sourceId) ?? sources[0]!,
    [sources, sourceId]
  );

  const { address: connectedAddress, isConnected, connector: activeConnector } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const [amount, setAmount] = useState('');
  const [balanceUnits, setBalanceUnits] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [destination, setDestination] = useState<string | null>(null);
  const [destLoading, setDestLoading] = useState(true);
  const [destUnbound, setDestUnbound] = useState<string | null>(null);
  // Server-proved mainnet liveness for the previewed destination (ARC+LIVE
  // via getWallet). Badge renders solely on this — never assumed client-side.
  const [destinationVerified, setDestinationVerified] = useState(false);

  const [phase, setPhase] = useState<Phase>('form');
  const [stages, setStages] = useState<StageState[]>([]);
  // Step D: kit.estimate fee preview (best-effort, never blocks).
  const [estimate, setEstimate] = useState<{ received: string | null; cost: string | null } | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);

  const [stageNote, setStageNote] = useState<string | null>(null);
  const [burnReviewConfirmed, setBurnReviewConfirmed] = useState(false);
  const [recoveryBurnHash, setRecoveryBurnHash] = useState('');
  const [recoveryMintHash, setRecoveryMintHash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorStage, setErrorStage] = useState<{ stage: string; txHash: string | null; label: string } | null>(null);
  const [receipt, setReceipt] = useState<{
    amountDisplay: string;
    actualDisplay: string;
    sourceLabel: string;
    destination: string;
    burnTxHash: string | null;
    mintTxHash: string | null;
    sourceExplorerUrl: string | null;
    destinationExplorerUrl: string | null;
  } | null>(null);

  // Double-submit guard: synchronous ref closes the gap between two rapid
  // taps before re-render disables the button. Reset on every terminal path.
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  // Soft/partial BridgeKit result kept only for explicit pre-burn retries.
  // No SDK signing is used after funds may have moved. The PERSISTED facts
  // (intentReference + sourceChainId + burnTxHash, see
  // src/lib/bridge/resumeStore.ts) survive a browser close/reload: mounts
  // rehydrate from localStorage and resume server-side (status → verify →
  // complete) when the in-memory BridgeKit result object is gone. `result`
  // is null on a rehydrated entry — handleResume branches on that.
  const resumeRef = useRef<{
    result: any;
    intentReference: string;
    burnTxHash?: string | null;
    mintTxHash?: string | null;
    sourceChainId?: string;
    signingStarted?: boolean;
    amount?: string;
    destination?: string | null;
  } | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sessionLower = sessionAddress.trim().toLowerCase();
  const connectedLower = (connectedAddress ?? '').toLowerCase();

  // Persist the minimal resume facts on every forward step. localStorage is
  // the reload-surviving copy; resumeRef stays the same-session authority
  // (it additionally holds the live BridgeKit result for kit.retry).
  const persistResume = useCallback(
    (intentReference: string, result: any, sourceChainId: string, signingStarted = resumeRef.current?.signingStarted) => {
      const burnTxHash = resumeRef.current?.burnTxHash ?? extractBurnTxHash(result) ?? null;
      const mintTxHash = resumeRef.current?.mintTxHash ?? stepOf(result, 'Mint')?.txHash ?? null;
      const savedAmount = resumeRef.current?.amount ?? amount.trim();
      const savedDestination = resumeRef.current?.destination ?? destination;
      resumeRef.current = { result, intentReference, burnTxHash, mintTxHash, sourceChainId, signingStarted, amount: savedAmount, destination: savedDestination };
      saveBridgeResume({
        intentReference,
        sourceChainId,
        sourceWallet: sessionLower,
        burnTxHash,
        mintTxHash,
        signingStarted,
        amount: savedAmount || undefined,
        destination: savedDestination,
      });
    },
    [amount, destination, sessionLower]
  );

  // Rehydrate after a reload: a persisted entry for THIS wallet restores the
  // "Resume bridge" card even though the BridgeKit result object is gone.
  // The rehydrated entry resumes server-side (status → verify → complete);
  // the server re-proves everything on-chain, so the stored facts are only
  // a pointer, never an authority.
  useEffect(() => {
    if (phase !== 'form' || resumeRef.current) return;
    const saved = loadBridgeResume(sessionLower);
    if (!saved) return;
    resumeRef.current = {
      result: null,
      intentReference: saved.intentReference,
      burnTxHash: saved.burnTxHash,
      mintTxHash: saved.mintTxHash,
      sourceChainId: saved.sourceChainId,
      signingStarted: saved.signingStarted,
      amount: saved.amount,
      destination: saved.destination,
    };
    if (saved.sourceChainId && saved.sourceChainId !== sourceId) {
      setSourceId(saved.sourceChainId);
    }
    if (saved.amount) setAmount(saved.amount);
    setPhase('awaiting-resume');
    setError(
      saved.burnTxHash
        ? 'A source burn hash was saved. Resume verification and settlement of this same bridge; do not burn again.'
        : 'Bridge interrupted before a burn hash was saved. Check wallet activity: approval alone is not a bridge. Recover an existing burn, or confirm no burn was submitted before retrying this same intent.'
    );
    fetchBridgeStage(saved.intentReference).then(({ stage, txHash }) => {
      if (!mountedRef.current || !stage) return;
      setErrorStage({ stage, txHash, label: STAGE_LABELS[stage] ?? stage });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionLower]);
  const walletsMatch = isConnected && !!connectedAddress && connectedLower === sessionLower;

  // Debounced fee estimate (BridgeKit quote — the estimate result is the
  // quote, never the typed input). Runs only with a connected matching
  // wallet, a valid amount, and a resolved destination; any failure hides
  // the panel without blocking the form.
  useEffect(() => {
    if (phase !== 'form' || !bridgeAvailable || !walletsMatch || !destination) {
      setEstimate(null);
      setEstimateLoading(false);
      return;
    }
    const parsed = validateBridgeAmount(amount, null);
    if (!parsed.ok) {
      setEstimate(null);
      setEstimateLoading(false);
      return;
    }
    let cancelled = false;
    setEstimateLoading(true);
    const timer = setTimeout(() => {
      (async () => {
        try {
          const [{ BridgeKit }, { createViemAdapterFromProvider }] = await Promise.all([
            import('@circle-fin/bridge-kit'),
            import('@circle-fin/adapter-viem-v2'),
          ]);
          const provider = await getProvider();
          if (!provider?.request) throw new Error('no provider');
          const adapter = await createViemAdapterFromProvider({ provider });
          const kit: any = new (BridgeKit as any)();
          const res: any = await (kit as any).estimate({
            from: { adapter, chain: source.id },
            to: {
              chain: bridgeNetwork === 'mainnet' ? 'Arc' : 'Arc_Testnet',
              recipientAddress: destination,
              useForwarder: true,
            },
            amount: amount.trim(),
            token: 'USDC',
          });
          if (cancelled) return;
          const received = res && typeof res.amountReceived !== 'undefined' && res.amountReceived !== null
            ? String(res.amountReceived) : null;
          const cost = res && typeof res.totalCost !== 'undefined' && res.totalCost !== null
            ? String(res.totalCost) : null;
          setEstimate(received || cost ? { received, cost } : null);
        } catch {
          if (!cancelled) setEstimate(null);
        } finally {
          if (!cancelled) setEstimateLoading(false);
        }
      })();
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, bridgeAvailable, walletsMatch, destination, amount, sourceId, bridgeNetwork]);

  const setStage = useCallback((key: StageKey, status: StageState['status']) => {
    setStages((prev) => prev.map((s) => (s.key === key ? { ...s, status } : s)));
  }, []);

  // ── Destination preview (display only — intent re-resolves server-side) ──
  // Re-resolves when the session wallet changes OR the page signals that the
  // link may have changed (destinationRefreshKey) — the returning email
  // onboarding path keeps this component mounted with the SAME external
  // address, so the key is what clears a stale "not linked yet" gate.
  useEffect(() => {
    let cancelled = false;
    setDestLoading(true);
    setDestUnbound(null);
    setDestinationVerified(false);
    fetch('/api/cctp/transfer/external/destination')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.success && d.destination) {
          setDestination(d.destination);
          // Server-proved only — absent/false means unverified.
          setDestinationVerified(d.walletVerified === true);
          bridgeDiag('D. FlareHQ CIRCLE destination', d.destination);
        } else if (d?.code === 'CIRCLE_WALLET_UNBOUND') {
          setDestination(null);
          setDestUnbound(d.error ?? 'No FlareHQ wallet is linked yet.');
        } else if (d?.code === 'WALLET_NEEDS_UPDATE') {
          // Display gate: the linked wallet is not ARC+LIVE — hide the
          // address and force the re-login repair path.
          setDestination(null);
          setDestUnbound(d.error ?? 'Your wallet needs updating, please log in again.');
        } else if (d?.code === 'WALLET_CHECK_FAILED') {
          // Transient Circle failure: NOT stale — retry, never claim the
          // wallet needs updating. No destination is shown either way.
          setDestination(null);
          setDestUnbound(d.error ?? 'Could not verify your wallet right now. Try again.');
        } else {
          setDestination(null);
          setDestUnbound(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDestination(null);
          setDestUnbound(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDestination(null);
          setDestUnbound(null);
        }
      })
      .finally(() => {
        if (!cancelled) setDestLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionAddress, destinationRefreshKey]);

  // ── Real source-chain USDC balance from the connected wallet/provider ──
  useEffect(() => {
    let cancelled = false;
    setBalanceUnits(null);
    setBalanceError(null);
    if (!walletsMatch || !connectedAddress) {
      setBalanceLoading(false);
      return;
    }
    const viemChain = sourceViemChainFor(source.chainId);
    if (!viemChain) {
      setBalanceError('This source chain is not currently supported.');
      return;
    }
    setBalanceLoading(true);
    const client = createPublicClient({ chain: viemChain, transport: http() });
    client
      .readContract({
        address: source.usdcAddress,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [connectedAddress as `0x${string}`],
      })
      .then((v) => {
        if (!cancelled) {
          setBalanceUnits(v as bigint);
          bridgeDiag('C. source USDC balance', {
            chain: source.id,
            address: connectedAddress,
            baseUnits: (v as bigint).toString(),
          });
        }
      })
      .catch((e) => {
        console.error('[external-bridge] balance read failed:', e);
        if (!cancelled) setBalanceError(`Couldn't load your USDC balance on ${source.label}.`);
      })
      .finally(() => {
        if (!cancelled) setBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [walletsMatch, connectedAddress, source]);

  const validation = validateBridgeAmount(amount, balanceUnits);
  const validationMsg = !validation.ok ? amountCopy(validation.error, source.label) : '';

  const formBlocked =
    !bridgeAvailable ||
    phase !== 'form' ||
    !walletsMatch ||
    !validation.ok ||
    balanceLoading ||
    destLoading ||
    // No linked destination: the wallet-creation path is email onboarding
    // (the unbound card), never a spend that the server would reject.
    !destination;

  async function getProvider(): Promise<any> {
    try {
      if (activeConnector) return await (
        activeConnector as unknown as { getProvider?: () => Promise<unknown> }
      ).getProvider?.();
      return (window as any)?.ethereum ?? null;
    } catch {
      // A failed WalletConnect connector must not sign through a different
      // injected wallet.
      return null;
    }
  }

  /** Wallet must be ON the source chain before BridgeKit is invoked. */
  async function ensureOnSourceChain(): Promise<void> {
    const viemChain = sourceViemChainFor(source.chainId);
    if (!viemChain) throw new Error('This source chain is not currently supported.');
    const providerGetter = async () => await getProvider();
    const net = await ensureEvmNetwork({
      chain: viemChain,
      chainId,
      switchChainAsync,
      getProvider: providerGetter,
    });
    if (!net.ok) throw new Error(net.message);
    // The hooks' chainId can lag the wallet — read the connector's truth.
    try {
      const live = await (
        activeConnector as unknown as { getChainId?: () => Promise<number> }
      )?.getChainId?.();
      if (typeof live === 'number' && live !== source.chainId) {
        throw new Error(`Switch your wallet to ${source.label} to continue.`);
      }
    } catch (e: any) {
      if (String(e?.message ?? '').includes(`Switch your wallet to ${source.label}`)) throw e;
      // getChainId unsupported by this connector — proceed; the signer's
      // chain mismatch (if any) surfaces as a mapped friendly error below.
    }
  }

  async function postJson(url: string, body: unknown): Promise<any> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json().catch(() => ({}));
  }

  function markStepsFromResult(result: any): void {
    const approve = stepOf(result, 'Approve');
    const burn = stepOf(result, 'Burn');
    const mint = stepOf(result, 'Mint');
    // Only mark SUCCESS when BridgeKit actually reports it — never
    // optimistically. A missing step stays pending (honest, not fake).
    // 'noop' counts as done: the SDK skips approval when allowance already
    // suffices, and there is nothing left to do for that leg.
    if (approve?.state === 'success' || approve?.state === 'noop') setStage('approve', 'done');
    else if (approve?.state === 'error') setStage('approve', 'error');
    if (burn?.state === 'success') setStage('burn', 'done');
    else if (burn?.state === 'error') setStage('burn', 'error');
    if (mint?.state === 'success') {
      setStage('attestation', 'done');
      setStage('mint', 'done');
    } else if (mint?.state === 'error') {
      setStage('attestation', 'done');
      setStage('mint', 'error');
    }
  }

  function recordKitEvent(event: any): void {
    const saved = resumeRef.current;
    if (!saved) return;
    const burn = bridgeEventHash(event, 'burn');
    const mint = bridgeEventHash(event, 'mint');
    if (burn) saved.burnTxHash = burn;
    if (mint) saved.mintTxHash = mint;
    if (burn || mint) persistResume(saved.intentReference, saved.result, saved.sourceChainId ?? source.id, true);
    if (!mountedRef.current) return;
    if (String(event?.method).toLowerCase() === 'approve') {
      setStageNote('Approval returned. The source burn is a separate wallet confirmation; approval alone does not move USDC.');
      setStage('burn', 'active');
    }
    if (burn) setStageNote('Source burn hash saved. Checking confirmation and Arc settlement…');
  }

  async function verifyAndComplete(
    intentReference: string,
    burnTxHash: string | undefined,
    mintTxHash: string | undefined
  ): Promise<void> {
    if (!burnTxHash) {
      throw new Error(
        'No source burn hash was recorded. Check wallet activity before retrying; a confirmed approval is not a completed bridge.'
      );
    }
    setStageNote('Verifying the source transaction…');
    // (d) verify POST — always-on trace so a missing server hit is provable.
    bridgeTrace('step-d verify POST', { reference: intentReference, burnTxHash });
    const v = await postJson('/api/cctp/transfer/external/verify', {
      reference: intentReference,
      burnTxHash,
    });
    bridgeTrace('step-d verify response', {
      reference: intentReference,
      ok: v?.success,
      code: v?.code ?? null,
      reason: v?.reason ?? null,
      error: v?.error ?? null,
    });
    bridgeDiag('I. verify response (server burn proof)', { ok: v?.success, code: v?.code, reason: v?.reason, error: v?.error });
    if (!v?.success) {
      throw Object.assign(new Error(v?.error ?? 'The source burn could not be verified. Resume verification of this same bridge.'), { bridgeCopy: true });
    }
    setStageNote('Confirming the Arc mint…');
    if (!mintTxHash) {
      // Burn proven, mint hash not yet available — the loop below keeps
      // polling server status; completion follows when the mint lands.
      throw new Error(
        'Burn verified — waiting for the Arc mint. Resume below to keep checking this same bridge; do not burn again.'
      );
    }
    const c = await postJson('/api/cctp/transfer/external/complete', {
      reference: intentReference,
      mintTxHash,
    });
    bridgeDiag('K–L. complete response (server mint proof)', { ok: c?.success, code: c?.code, reason: c?.reason, error: c?.error });
    if (!c?.success) {
      // Distinguish retryable (mint not yet visible) from terminal.
      if (c?.code === 'MINT_NOT_VERIFIED' && (c?.reason === 'NOT_FOUND' || c?.reason === 'RPC_UNAVAILABLE')) {
        throw Object.assign(new Error(c.error), { bridgeCopy: true });
      }
      throw Object.assign(new Error(c?.error ?? 'The Arc mint could not be verified. Resume this same bridge.'), { bridgeCopy: true });
    }
    setReceipt({
      amountDisplay: c.amountDisplay ?? resumeRef.current?.amount ?? formatBridgeBaseUnits(BigInt(c.amount ?? '0')),
      actualDisplay: c.actualAmountDisplay ?? c.amountDisplay ?? '',
      sourceLabel: c.sourceLabel ?? source.label,
      destination: c.destination ?? resumeRef.current?.destination ?? destination,
      burnTxHash: stepOf(resumeRef.current?.result, 'Burn')?.txHash ?? burnTxHash,
      mintTxHash: mintTxHash,
      sourceExplorerUrl: c.sourceExplorerUrl ?? sourceExplorerTxUrl(resumeRef.current?.sourceChainId ?? source.id, burnTxHash, bridgeNetwork),
      destinationExplorerUrl: c.destinationExplorerUrl ?? null,
    });
    bridgeDiag('L. completion (server-verified)', {
      destination: c.destination,
      actual: c.actualAmountDisplay ?? c.actualAmount ?? null,
      mintTxHash,
    });
    setPhase('receipt');
    clearBridgeResume(sessionLower);
    resumeRef.current = null;
    onBridgeCompleted();
  }

  async function runBridgeFlow(intentReference: string, kit: any, adapter: any, previousResult?: any): Promise<void> {
    if (previousResult && bridgeHasRecoveryEvidence({ result: previousResult })) {
      throw Object.assign(new Error('A burn may already exist. Resume verification / settlement; do not submit another burn.'), { bridgeCopy: true, resumeOnly: true });
    }
    setStages([
      { key: 'approve', label: 'Approve USDC', status: 'active' },
      { key: 'burn', label: 'Burn USDC', status: 'pending' },
      { key: 'attestation', label: 'Waiting for Circle attestation', status: 'pending' },
      { key: 'mint', label: 'Minting on Arc', status: 'pending' },
    ]);
    setStageNote('Waiting for wallet confirmation…');

    // (b/c) wallet signing: kit.bridge drives BOTH the approval prompt and the
    // burn prompt inside a single call (there are no separate sign calls).
    // Trace entry + exit + thrown error with the SAME reference so we can see
    // whether the session ever returned from the wallet at all. A throw here
    // is the "intent created, verify never called" stall — surfaced below with
    // name/message/code (never swallowed).
    bridgeTrace('step-bc kit.bridge signing start', { reference: intentReference });
    persistResume(intentReference, previousResult ?? null, source.id, true);
    // Installed Bridge Kit emits step payloads through the wildcard bus, but
    // retain named listeners as a compatibility backstop for providers that
    // only dispatch the specific action. recordKitEvent is idempotent.
    for (const action of ['*', 'approve', 'burn', 'mint']) kit.on(action, recordKitEvent);
    let result: any;
    try {
      // User-controlled adapter (createViemAdapterFromProvider over the
      // connected browser wallet): BridgeKit auto-resolves the source
      // address from the connected wallet and FORBIDS an explicit
      // `address` in the `from` context — passing one fails at runtime
      // (CONNECTION_FAILED.code.bridge: "Address should not be provided
      // for user-controlled adapters…"). See QUICKSTART.md "User-Controlled"
      // and AdapterContext's `address?: never` for this adapter type. The
      // developer-controlled path (server-signed Circle wallets in
      // src/lib/cctp-v2.ts) is a different adapter mode and keeps explicit
      // addresses. Source identity is still pinned server-side: the intent
      // route resolves the source from the authenticated session and the
      // echo check below refuses a substituted address.
      const bridgeFromCtx: Record<string, unknown> = {
        adapter,
        chain: source.id,
      };
      const bridgeToCtx: Record<string, unknown> = {
        chain: bridgeNetwork === 'mainnet' ? 'Arc' : 'Arc_Testnet',
        recipientAddress: destination as `0x${string}`,
        useForwarder: true,
      };
      result = previousResult
        ? await kit.retry(previousResult, { from: adapter, to: undefined })
        : await (kit as any).bridge({
      from: bridgeFromCtx as { adapter: typeof adapter; chain: string },
      // ForwarderDestination: Circle's relayer mints on Arc — the user is
      // never asked to sign on, or switch to, the destination chain.
      to: bridgeToCtx as unknown as { chain: string; recipientAddress: `0x${string}`; useForwarder: boolean },
      amount: amount.trim(),
      });
    } catch (signErr: any) {
      // Signing-layer throw (user rejected a prompt, wallet/chain error, or
      // kit.bridge threw before returning a result). Log the RAW signing error
      // with the intent reference — friendlyBridgeError mapping downstream
      // hides this detail, and without this line a stall here is silent.
      bridgeTrace('step-bc kit.bridge signing THREW', {
        reference: intentReference,
        name: signErr?.name ?? null,
        code: signErr?.code ?? null,
        shortMessage: signErr?.shortMessage ?? null,
        message: String(signErr?.message ?? signErr ?? '').slice(0, 500),
      });
      console.error('[external-bridge] kit.bridge signing failed', { reference: intentReference }, signErr);
      throw signErr;
    } finally {
      for (const action of ['*', 'approve', 'burn', 'mint']) kit.off(action, recordKitEvent);
    }
    bridgeTrace('step-bc kit.bridge signing returned', {
      reference: intentReference,
      state: result?.state ?? null,
      rawSteps: rawStepSummary(result),
      approve: stepOf(result, 'Approve') ? { state: stepOf(result, 'Approve')?.state ?? null, txHash: stepOf(result, 'Approve')?.txHash ?? null } : null,
      burn: stepOf(result, 'Burn') ? { state: stepOf(result, 'Burn')?.state ?? null, txHash: stepOf(result, 'Burn')?.txHash ?? null } : null,
      mint: stepOf(result, 'Mint') ? { state: stepOf(result, 'Mint')?.state ?? null, txHash: stepOf(result, 'Mint')?.txHash ?? null } : null,
      error: result?.state === 'error' ? String(result?.error?.message ?? result?.error ?? '').slice(0, 300) : null,
    });
    bridgeDiag('G–I. kit result (approval/burn hashes + step states)', result);
    persistResume(intentReference, result, source.id);
    markStepsFromResult(result);

    const burnHash = resumeRef.current?.burnTxHash ?? extractBurnTxHash(result);
    if (!burnHash) {
      throw Object.assign(new Error(bridgeResultFailure(result, source.label)), {
        bridgeCopy: true, resumeOnly: true,
      });
    }
    // After any observed burn, only read-only server verification/polling is
    // permitted. kit.retry is reserved for explicit pre-burn retries above;
    // an SDK polling implementation can never reopen an approval or burn.
    const verified = await postJson('/api/cctp/transfer/external/verify', {
      reference: intentReference, burnTxHash: burnHash,
    });
    if (!verified?.success) throw Object.assign(new Error(verified?.error ?? 'The burn could not be verified. Resume this same bridge; do not burn again.'), { bridgeCopy: true, resumeOnly: true });
    setStage('burn', 'done');
    setStage('attestation', 'active');
    let mintHash = resumeRef.current?.mintTxHash ?? stepOf(result, 'Mint')?.txHash;
    if (!mintHash) {
      const waited = await waitForMintViaServer(intentReference);
      mintHash = waited.mintTxHash;
    }
    bridgeDiag('J–K. attestation + Arc mint hash', { burnHash, mintHash });
    await verifyAndComplete(intentReference, burnHash, mintHash);
  }

  const startOver = useCallback(() => {
    // Used only for a verified receipt or a pre-signing failure. Ambiguous
    // attempts keep the reference for recovery/explicit same-intent retry.
    busyRef.current = false;
    resumeRef.current = null;
    clearBridgeResume(sessionLower);
    setStages([]);
    setStageNote(null);
    setError(null);
    setErrorStage(null);
    setReceipt(null);
    setBurnReviewConfirmed(false);
    setRecoveryBurnHash('');
    setRecoveryMintHash('');
    setPhase('form');
  }, [sessionLower]);

  async function handleBridge(options?: { retryBeforeBurn: boolean }): Promise<void> {
    const retryBeforeBurn = options?.retryBeforeBurn === true;
    const saved = resumeRef.current;
    // Synchronous double-submit guard (button disable alone races).
    if (busyRef.current || (retryBeforeBurn ? phase !== 'awaiting-resume' : phase !== 'form')) return;
    if (!bridgeAvailable) { setError(availability?.message ?? 'Bridge availability has not been confirmed.'); return; }
    if (retryBeforeBurn && (!saved || bridgeHasRecoveryEvidence(saved))) {
      setError('A burn may already exist. Recover this same bridge; do not submit another burn.');
      return;
    }
    if (retryBeforeBurn && !canRetryBridgeBeforeBurn(saved!, burnReviewConfirmed)) {
      setError('Check wallet activity and confirm that no burn was submitted before retrying approval and burn.');
      return;
    }
    setError(null);
    setErrorStage(null);

    if (!isConnected || !connectedAddress || !walletsMatch) {
      setError('Reconnect your wallet to continue.');
      return;
    }
    const checked = validateBridgeAmount(amount, balanceUnits);
    if (!checked.ok) {
      setError(amountCopy(checked.error, source.label) || 'Enter an amount of USDC to bridge.');
      return;
    }
    busyRef.current = true;
    setPhase('working');
    setStages([]);
    setReceipt(null);
    bridgeDiag('A. source chain selected', source.id);
    bridgeDiag('B. connected EXTERNAL address', connectedAddress);

    try {
      await ensureOnSourceChain();

      // Destination preview should already be loaded; re-check before spend.
      if (!destination) {
        const d = await fetch('/api/cctp/transfer/external/destination').then((r) => r.json()).catch(() => null);
        if (d?.success && d.destination) {
          setDestination(d.destination);
          setDestinationVerified(d.walletVerified === true);
        } else {
          busyRef.current = false;
          setPhase('form');
          setDestUnbound(d?.error ?? 'No FlareHQ wallet is linked yet.');
          setError(d?.error ?? 'No FlareHQ wallet is linked yet.');
          return;
        }
      }

      setStageNote('Reserving your bridge…');
      const intent = await postJson('/api/cctp/transfer/external/intent', {
        sourceChain: source.id,
        amount: amount.trim(),
        ...(retryBeforeBurn ? { reference: saved!.intentReference, retryBeforeBurn: true } : {}),
      });
      if (!intent?.success) {
        if (intent?.code === 'CIRCLE_WALLET_UNBOUND') {
          setDestUnbound(intent.error);
        }
        if (intent?.code === 'WALLET_NEEDS_UPDATE') {
          setDestination(null);
          setDestinationVerified(false);
          setDestUnbound(intent.error ?? 'Your wallet needs updating, please log in again.');
        }
        if (intent?.code === 'WALLET_CHECK_FAILED') {
          setDestinationVerified(false);
          setDestUnbound(intent.error ?? 'Could not verify your wallet right now. Try again.');
        }
        throw new Error(intent?.error ?? 'Could not start the bridge. Please try again.');
      }
      const intentReference = intent.reference as string;
      // (a) intent created — always-on trace (bridgeDiag above is dev-only).
      bridgeTrace('step-a intent created', {
        reference: intentReference,
        destination: intent.destination,
        amount: intent.amount,
      });
      // Server echo consistency: the intent must name THIS wallet as source
      // and the previewed destination (never a substituted address).
      if (
        (intent.sourceAddress ?? '').toLowerCase() !== sessionLower ||
        (destination && (intent.destination ?? '').toLowerCase() !== destination.toLowerCase())
      ) {
        throw new Error('Bridge could not be completed. Please try again.');
      }
      setDestination(intent.destination);

      // Persist the intent BEFORE any signing prompt: closing the browser
      // during the approve/burn prompts must still offer "Resume bridge".
      const retained = retryBeforeBurn ? saved : null;
      saveBridgeResume({
        intentReference,
        sourceChainId: source.id,
        sourceWallet: sessionLower,
        burnTxHash: intent.burnTxHash ?? null,
        mintTxHash: intent.mintTxHash ?? null,
        signingStarted: retained?.signingStarted ?? (intent.reused ? undefined : false),
        amount: amount.trim() || undefined,
        destination: intent.destination,
      });
      resumeRef.current = {
        result: retained?.result ?? null,
        intentReference,
        burnTxHash: intent.burnTxHash ?? null,
        mintTxHash: intent.mintTxHash ?? null,
        sourceChainId: source.id,
        signingStarted: retained?.signingStarted ?? (intent.reused ? undefined : false),
        amount: amount.trim(),
        destination: intent.destination,
      };

      // A reused reference is not permission to issue a second burn from a
      // second tab. Stop and review/recover unless this is an explicit retry.
      if ((!retryBeforeBurn && intent.reused) || !intent.canSubmitBurn) {
        setPhase('awaiting-resume');
        setError(intent.burnTxHash
          ? 'This amount already has a recorded burn. Resume settlement of the existing bridge; do not burn again.'
          : 'An existing bridge intent was found. Check wallet activity and recover an existing burn, or explicitly retry this same intent if no burn was submitted.');
        return;
      }

      setStageNote('Opening your wallet…');
      bridgeTrace('step-bc opening wallet (adapter/kit init)', { reference: intentReference });
      const [{ BridgeKit }, { createViemAdapterFromProvider }] = await Promise.all([
        import('@circle-fin/bridge-kit'),
        import('@circle-fin/adapter-viem-v2'),
      ]);
      const provider = await getProvider();
      if (!provider?.request) throw new Error('Reconnect your wallet to continue.');
      const adapter = await createViemAdapterFromProvider({ provider });
      // `any` by construction: BridgeKit's bridge/retry params are heavy
      // generics over chain/adapter capabilities; the runtime shape above
      // (source adapter + ForwarderDestination + useForwarder) is the
      // documented browser-wallet pattern.
      const kit: any = new (BridgeKit as any)();
      bridgeDiag('F. BridgeKit initialized', {
        chain: source.id,
        chainId: source.chainId,
        usdc: source.usdcAddress,
      });

      // Pre-signing preflight: fresh on-chain reads (never the possibly
      // stale balanceUnits preview) for BOTH native gas and USDC on the
      // selected source chain. A failure here throws BEFORE kit.bridge(),
      // so the user never signs into a stall or a wasted transaction.
      setStageNote('Checking balances…');
      {
        const viemChain = sourceViemChainFor(source.chainId);
        if (!viemChain) throw new Error('This source chain is not currently supported.');
        const preflightClient = createPublicClient({ chain: viemChain, transport: http() });
        const [nativeBal, freshUsdc] = await Promise.all([
          preflightClient
            .getBalance({ address: connectedAddress as `0x${string}` })
            .catch(() => null),
          preflightClient
            .readContract({
              address: source.usdcAddress,
              abi: USDC_ABI,
              functionName: 'balanceOf',
              args: [connectedAddress as `0x${string}`],
            })
            .catch(() => null),
        ]);
        if (freshUsdc !== null) setBalanceUnits(freshUsdc as bigint);
        const amountUnits = validateBridgeAmount(amount, null);
        const pre = checkBridgePreflight({
          nativeBalanceWei: nativeBal as bigint | null,
          usdcBalanceUnits: (freshUsdc as bigint | null) ?? balanceUnits,
          amountUnits:
            amountUnits.ok ? amountUnits.amountBaseUnits : 0n,
          sourceLabel: source.label,
          sourceChainId: source.chainId,
          minNativeWei: MIN_NATIVE_WEI,
        });
        if (!pre.ok) throw new Error(pre.error);
      }

      // Pin the actual provider account immediately before SDK signing.
      const accounts = await provider.request({ method: 'eth_accounts' });
      if (!Array.isArray(accounts) || String(accounts[0] ?? '').toLowerCase() !== sessionLower) {
        throw new Error('Reconnect your wallet to continue.');
      }
      await ensureOnSourceChain();
      await runBridgeFlow(intentReference, kit, adapter, retryBeforeBurn ? saved?.result : undefined);
    } catch (e: any) {
      console.error('[external-bridge]', e);
      if (!mountedRef.current) return;
      if (e?.resumeOnly) {
        // Partial result: funds may have moved — resume path only.
        setPhase('awaiting-resume');
        setError(e.message);
      } else if (String(e?.message ?? '').includes('Still processing') || String(e?.message ?? '').includes('waiting for the Arc mint')) {
        setPhase('awaiting-resume');
        setError(e.message);
      } else {
        // Once an intent exists, absence of a returned hash is ambiguous.
        // Keep its reference for recovery or explicit same-intent retry.
        if (resumeRef.current) {
          setPhase('awaiting-resume');
        } else {
          busyRef.current = false;
          setPhase('form');
        }
        setStages([]);
        setStageNote(null);
        const msg = String(e?.message ?? '');
        const baseError =
          e?.bridgeCopy || msg.includes('Reconnect your wallet') ||
          msg.includes('Switch your wallet to') ||
          msg.includes('Enter a valid') ||
          msg.includes('at most 6 decimals') ||
          msg.includes('greater than zero') ||
          msg.includes('not have enough USDC') ||
          msg.includes('for gas on') ||
          msg.includes('you need at least') ||
          msg.includes('not currently supported') ||
          msg.includes('Network switch was cancelled') ||
          msg.includes("couldn't switch") ||
          msg.includes('No FlareHQ wallet') ||
          msg.includes('No verified email') ||
          msg.includes('Could not start the bridge')
            ? msg
            : friendlyBridgeError(e, { sourceLabel: source.label });

        // Enrich the error with the server-side stage if available.
        const ref = resumeRef.current?.intentReference;
        if (ref) {
          const { stage, txHash } = await fetchBridgeStage(ref);
          if (stage) {
            setErrorStage({ stage, txHash, label: STAGE_LABELS[stage] ?? stage });
          }
        }
        setError(baseError);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setStageNote(null);
    }
  }

  /**
   * Read-only mint wait for both current and rehydrated attempts: polls the
   * authoritative status endpoint until the relay mint appears. No signing
   * adapter or kit.retry is reachable here. Returns the latest burn
   * and mint hashes (mint null when the budget ran out).
   */
  async function waitForMintViaServer(
    intentReference: string
  ): Promise<{ burnTxHash: string | undefined; mintTxHash: string | undefined }> {
    return pollBridgeSettlementStatus({
      reference: intentReference,
      rounds: RETRY_ROUNDS,
      delayMs: RETRY_DELAY_MS,
      isActive: () => mountedRef.current,
      onPoll: () => setStageNote('Waiting for Circle attestation… Minting on Arc…'),
      fetchStatus: async (reference) => fetch(
        `/api/cctp/transfer/external/status?reference=${encodeURIComponent(reference)}`
      ).then((response) => response.json().catch(() => null)),
    });
  }

  async function handleResume(): Promise<void> {
    const saved = resumeRef.current;
    if (!saved || busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setErrorStage(null);
    setPhase('working');
    try {
      const resumeSourceId = saved.sourceChainId ?? source.id;
      const resumeSource = sources.find((s) => s.id === resumeSourceId);
      if (!resumeSource) throw Object.assign(new Error('This bridge belongs to a different source network. Do not submit another burn.'), { bridgeCopy: true });
      const st = await fetch(`/api/cctp/transfer/external/status?reference=${encodeURIComponent(saved.intentReference)}`)
        .then((response) => response.json().catch(() => null));
      if (!st?.success || st.network !== bridgeNetwork || st.sourceChain !== resumeSourceId ||
          String(st.sourceAddress ?? '').toLowerCase() !== sessionLower) {
        throw Object.assign(new Error(st?.error ?? 'The saved bridge could not be matched to this wallet and network. No new burn was submitted.'), { bridgeCopy: true });
      }
      if (st.state === 'failed') throw Object.assign(new Error(st.error ?? 'This bridge needs manual recovery; do not burn again.'), { bridgeCopy: true });
      saved.amount = st.amountDisplay;
      saved.destination = st.destination;
      setAmount(st.amountDisplay);
      const burnHash = selectBridgeRecoveryHash(st.burnTxHash, recoveryBurnHash, saved.burnTxHash || extractBurnTxHash(saved.result));
      if (!/^0x[0-9a-f]{64}$/i.test(burnHash ?? '')) {
        throw Object.assign(new Error('No burn hash was recorded. Approval alone is not a bridge. Paste the source burn hash to recover, or check wallet activity before retrying approval and burn for this same intent.'), { bridgeCopy: true });
      }
      // No wallet switch or signing is needed for recovery. Verify the burn
      // BEFORE mint discovery, so the server can query Iris for this bridge.
      setStages([
        { key: 'approve', label: 'Approve USDC', status: 'pending' },
        { key: 'burn', label: 'Verify source burn', status: 'active' },
        { key: 'attestation', label: 'Waiting for Circle attestation', status: 'pending' },
        { key: 'mint', label: 'Minting on Arc', status: 'pending' },
      ]);
      const verified = await postJson('/api/cctp/transfer/external/verify', { reference: saved.intentReference, burnTxHash: burnHash });
      if (!verified?.success) throw Object.assign(new Error(verified?.error ?? 'Could not verify the source burn. Retry this same hash, not the burn.'), { bridgeCopy: true });
      // A typo must not become a sticky saved hash or suppress recovery with
      // the real burn. Persist a manual candidate only after the proof passes.
      saved.burnTxHash = burnHash;
      persistResume(saved.intentReference, saved.result, resumeSource.id, true);
      setStage('burn', 'done');
      setStage('attestation', 'active');
      let mintHash = selectBridgeRecoveryHash(st.mintTxHash || st.relayMintTxHash, recoveryMintHash, saved.mintTxHash);
      if (!mintHash) {
        const waited = await waitForMintViaServer(saved.intentReference);
        mintHash = waited.mintTxHash;
      }
      if (mintHash) {
        saved.mintTxHash = mintHash;
        persistResume(saved.intentReference, saved.result, resumeSource.id, true);
      }
      await verifyAndComplete(saved.intentReference, burnHash, mintHash || undefined);
    } catch (e: any) {
      console.error('[external-bridge] resume', e);
      if (!mountedRef.current) return;
      busyRef.current = false;
      setPhase('awaiting-resume');
      const msg = String(e?.message ?? '');
      setError(
        e?.bridgeCopy || msg.includes('Still processing') || msg.includes('waiting for the Arc mint')
          ? msg
          : friendlyBridgeError(e, { sourceLabel: source.label })
      );
      // Fetch the server-side stage for display.
      if (saved?.intentReference) {
        const { stage, txHash } = await fetchBridgeStage(saved.intentReference);
        if (stage) {
          setErrorStage({ stage, txHash, label: STAGE_LABELS[stage] ?? stage });
        }
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setStageNote(null);
    }
  }

  const working = phase === 'working';

  const pendingResume = resumeRef.current;
  const hasBurn = !!pendingResume && bridgeHasRecoveryEvidence(pendingResume);
  const needsBurnReview = !!pendingResume && bridgeNeedsBurnReview(pendingResume);
  const canRetryBurn = !!pendingResume && !hasBurn;

  if (!bridgeAvailable && phase === 'form') {
    return (
      <div>
        <p style={{ color: 'var(--flow-text-faint)', fontSize: 'clamp(13px, 1.2vw, 15px)', margin: '0 0 16px' }}>
          {availability === null ? 'Checking external bridge availability…' : availability.message ?? 'Bridging from an external wallet is unavailable on Arc right now.'}
        </p>
        <p style={{ color: 'var(--flow-text-faint)', fontSize: 'clamp(13px, 1.2vw, 15px)', margin: 0 }}>
          To get funds in, send USDC directly to your FlareHQ wallet on Arc.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p style={{ color: 'var(--flow-text-faint)', fontSize: 'clamp(13px, 1.2vw, 15px)', margin: '0 0 16px' }}>
        Bring USDC from another wallet to your FlareHQ wallet.
      </p>
      {availability?.message && <p style={styles.resumeText}>{availability.message}</p>}

      {phase === 'receipt' && receipt ? (
        <div style={styles.resultSuccess}>
          <p style={styles.resultIcon}>✓</p>
          <p style={styles.resultText}>
            Bridge completed — {receipt.amountDisplay} USDC moved from {receipt.sourceLabel} to your
            FlareHQ wallet on Arc.
            {receipt.actualDisplay && receipt.actualDisplay !== receipt.amountDisplay
              ? ` Received ${receipt.actualDisplay} USDC after relayer fees.`
              : ''}
          </p>
          {receipt.burnTxHash && (
            <p style={styles.hashRow}>
              Source transaction
              <span style={styles.hash}>{shortAddr(receipt.burnTxHash)}</span>
            </p>
          )}
          {receipt.mintTxHash && (
            <p style={styles.hashRow}>
              Destination transaction
              <span style={styles.hash}>{shortAddr(receipt.mintTxHash)}</span>
            </p>
          )}
          <div style={styles.linkRow}>
            {receipt.sourceExplorerUrl && (
              <a href={receipt.sourceExplorerUrl} target="_blank" rel="noopener noreferrer" style={styles.resultLink}>
                View source transaction
              </a>
            )}
            {receipt.destinationExplorerUrl && (
              <a href={receipt.destinationExplorerUrl} target="_blank" rel="noopener noreferrer" style={styles.resultLink}>
                View destination transaction
              </a>
            )}
          </div>
          <button
            style={styles.doneButton}
            onClick={() => {
              startOver();
              setAmount('');
            }}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          <label style={styles.label}>Source chain</label>
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            disabled={phase !== 'form'}
            style={styles.input}
            aria-label="Source chain"
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>

          <label style={styles.label}>Source wallet</label>
          <div style={styles.readonlyBox}>
            {walletsMatch ? (
              <span style={styles.mono}>{shortAddr(sessionAddress)}</span>
            ) : (
              <span style={{ color: '#f87171' }}>
                {isConnected
                  ? `Connected ${shortAddr(connectedAddress ?? '')} — reconnect with ${shortAddr(sessionAddress)} to continue.`
                  : 'Connect your wallet to continue.'}
              </span>
            )}
          </div>

          <label style={styles.label}>Available</label>
          <div style={styles.readonlyBox}>
            {balanceLoading ? (
              'Loading…'
            ) : balanceError ? (
              <span style={{ color: '#f87171' }}>{balanceError}</span>
            ) : balanceUnits !== null ? (
              <span>
                {formatBridgeBaseUnits(balanceUnits)} <span style={{ opacity: 0.7 }}>USDC</span>
              </span>
            ) : (
              <span style={{ opacity: 0.6 }}>—</span>
            )}
          </div>

          <label style={styles.label}>Amount</label>
          <input
            style={styles.input}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="10.00"
            inputMode="decimal"
            disabled={phase !== 'form'}
            aria-label="Bridge amount in USDC"
          />
          {validationMsg && <p style={styles.hintError}>{validationMsg}</p>}

          <label style={styles.label}>Destination</label>
          <div style={styles.readonlyBox}>
            <span style={{ opacity: 0.7 }}>FlareHQ wallet · Arc</span>
            <br />
            {destLoading ? (
              'Resolving…'
            ) : destination ? (
              <>
                <span style={styles.mono}>{shortAddr(destination)}</span>
                {/* Server-proved ARC+LIVE only (server returns true on mainnet
                    checks alone — never assumed client-side). */}
                {destinationVerified && (
                  <>
                    <br />
                    <span style={{ fontSize: 11, color: '#0D7C5F', fontWeight: 700 }}>
                      Arc Mainnet ✓ verified
                    </span>
                  </>
                )}
              </>
            ) : (
              <span style={{ color: '#fbbf24' }}>
                {destUnbound ?? 'No FlareHQ wallet linked yet.'}
              </span>
            )}
          </div>

          {phase === 'form' && destUnbound && !destination && (
            <div style={styles.unboundCard}>
              <p style={styles.unboundText}>
                Create your free FlareHQ wallet with email to receive bridged funds. Use an email
                that is not already tied to this wallet.
              </p>
              <button
                style={styles.submitButton}
                onClick={() => {
                  // Enter the EXISTING email onboarding flow (OTP → verified
                  // consumer identity → FlareHQ CIRCLE wallet). This bridge
                  // never provisions a wallet itself — the page owns the flow
                  // and returns to Bridge when it completes.
                  onContinueWithEmail();
                }}
              >
                Continue with email
              </button>
            </div>
          )}

          {phase === 'awaiting-resume' ? (
            <div style={styles.resumeCard}>
              {errorStage && (
                <p style={styles.stageError}>
                  Last known stage: <strong>{errorStage.label}</strong>
                  {errorStage.txHash && (
                    <span style={styles.hash}> · {shortAddr(errorStage.txHash)}</span>
                  )}
                </p>
              )}
              <p style={styles.resumeText}>{error}</p>
              {pendingResume && <p style={styles.resumeText}>Same bridge: <span style={styles.mono}>{pendingResume.intentReference}</span></p>}
              <label style={styles.label} htmlFor="bridge-recovery-burn">Existing source burn hash (not the approval hash)</label>
              <input id="bridge-recovery-burn" style={styles.input} value={recoveryBurnHash} onChange={(event) => setRecoveryBurnHash(event.target.value)} placeholder="0x…" />
              <p style={styles.resumeText}>You can correct an unverified candidate. A server-verified burn hash cannot be replaced.</p>
              <label style={styles.label} htmlFor="bridge-recovery-mint">Arc mint hash (optional if the relayer reports it)</label>
              <input id="bridge-recovery-mint" style={styles.input} value={recoveryMintHash} onChange={(event) => setRecoveryMintHash(event.target.value)} placeholder="0x…" />
              <div>
                <button style={styles.submitButton} onClick={handleResume}>
                  Resume verification / settlement
                </button>
                <p style={styles.resumeText}>Recovery verifies the existing hashes. It does not ask for a new approval or burn.</p>
                {canRetryBurn && (
                  <>
                    {needsBurnReview && (
                      <label style={{ ...styles.resumeText, display: 'block', marginTop: 12 }}>
                        <input type="checkbox" checked={burnReviewConfirmed} onChange={(event) => setBurnReviewConfirmed(event.target.checked)} />{' '}
                        I checked wallet activity: no burn was submitted. Only approval may have completed.
                      </label>
                    )}
                    <button style={styles.secondaryButton} disabled={!bridgeAvailable || !walletsMatch || (needsBurnReview && !burnReviewConfirmed) || !!recoveryBurnHash.trim()} onClick={() => void handleBridge({ retryBeforeBurn: true })}>
                      Retry approval / burn — same intent
                    </button>
                    <p style={styles.resumeText}>This retry can ask for source-chain signatures and spend the same USDC amount plus gas and quoted fees.</p>
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              {(working || stages.length > 0) && (
                <div style={styles.stepsCard}>
                  {stages.map((s) => (
                    <p key={s.key} style={styles.stepRow}>
                      <span>{s.status === 'done' ? '✓' : s.status === 'active' ? '…' : s.status === 'error' ? '!' : '○'}</span>
                      <span style={{ marginLeft: 8 }}>
                        {s.label}
                        {s.status === 'active' && stageNote ? ` — ${stageNote}` : ''}
                      </span>
                    </p>
                  ))}
                  {working && stages.length === 0 && (
                    <p style={styles.stepRow}>… {stageNote ?? 'Working…'}</p>
                  )}
                </div>
              )}
              {error && phase === 'form' ? (
                <div style={styles.resultError}>
                  {errorStage && (
                    <p style={styles.stageError}>
                      Failed at: <strong>{errorStage.label}</strong>
                      {errorStage.txHash && (
                        <span style={styles.hash}> · {shortAddr(errorStage.txHash)}</span>
                      )}
                    </p>
                  )}
                  <p style={styles.resultText}>⚠️ {error}</p>
                </div>
              ) : null}
              {phase === 'form' && (
                <button style={styles.submitButton} disabled={formBlocked} onClick={() => void handleBridge()}>
                  {balanceLoading
                    ? 'Loading balance…'
                    : !walletsMatch
                      ? 'Reconnect your wallet to continue'
                      : 'Bridge USDC'}
                </button>
              )}
              {phase === 'form' && (
                <p style={{ color: 'var(--flow-text-faint)', fontSize: 12, margin: '8px 0 0', lineHeight: 1.5 }}>
                  You need {source.nativeCurrency.symbol} on {source.label} for
                  gas (approve + burn). The Arc mint is relayed — no Arc gas needed.
                </p>
              )}
              {phase === 'form' && (estimateLoading || estimate) && (
                <div style={styles.stepsCard}>
                  <p style={{ ...styles.stepRow, fontWeight: 700 }}>Bridge estimate</p>
                  {estimateLoading && !estimate ? (
                    <p style={styles.stepRow}>Estimating…</p>
                  ) : estimate ? (
                    <>
                      {estimate.received ? (
                        <p style={styles.stepRow}>Est. receive on Arc ≈ {estimate.received} USDC</p>
                      ) : null}
                      {estimate.cost ? (
                        <p style={styles.stepRow}>Est. cost: {estimate.cost}</p>
                      ) : null}
                      <p style={{ ...styles.stepRow, opacity: 0.7 }}>Quoted by BridgeKit — the final mint decides.</p>
                    </>
                  ) : null}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    opacity: 0.7,
    margin: '14px 0 6px',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(148,163,184,0.35)',
    background: 'var(--flow-surface-2)',
    color: 'inherit',
    fontSize: 15,
  },
  readonlyBox: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(148,163,184,0.25)',
    background: 'rgba(148,163,184,0.08)',
    fontSize: 14,
    lineHeight: 1.5,
  },
  mono: { fontFamily: 'ui-monospace, monospace' },
  hintError: { color: '#f87171', fontSize: 12, margin: '6px 0 0' },
  submitButton: {
    width: '100%',
    marginTop: 16,
    padding: '12px',
    borderRadius: 12,
    border: 'none',
    background: '#c8975a',
    color: '#1a1207',
    fontWeight: 800,
    fontSize: 15,
    cursor: 'pointer',
  },
  secondaryButton: {
    flex: 1,
    marginTop: 16,
    padding: '12px',
    borderRadius: 12,
    border: '1px solid rgba(148,163,184,0.4)',
    background: 'transparent',
    color: 'inherit',
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
  },
  stepsCard: {
    marginTop: 16,
    padding: '12px 14px',
    borderRadius: 12,
    background: 'rgba(148,163,184,0.08)',
    border: '1px solid rgba(148,163,184,0.25)',
  },
  stepRow: { margin: '6px 0', fontSize: 14 },
  unboundCard: {
    marginTop: 12,
    padding: '12px 14px',
    borderRadius: 12,
    background: 'rgba(251,191,36,0.08)',
    border: '1px solid rgba(251,191,36,0.35)',
  },
  unboundText: { margin: '0 0 4px', fontSize: 13, lineHeight: 1.5 },
  resumeCard: {
    marginTop: 16,
    padding: '12px 14px',
    borderRadius: 12,
    background: 'rgba(96,165,250,0.08)',
    border: '1px solid rgba(96,165,250,0.35)',
  },
  resumeText: { margin: '0 0 4px', fontSize: 13, lineHeight: 1.5 },
  resultSuccess: {
    padding: '16px',
    borderRadius: 12,
    background: 'rgba(34,197,94,0.08)',
    border: '1px solid rgba(34,197,94,0.4)',
  },
  resultError: {
    marginTop: 12,
    padding: '12px 14px',
    borderRadius: 12,
    background: 'rgba(248,113,113,0.08)',
    border: '1px solid rgba(248,113,113,0.4)',
  },
  stageError: { margin: '0 0 6px', fontSize: 12, color: '#fbbf24', lineHeight: 1.4 },
  resultIcon: { fontSize: 22, margin: '0 0 6px' },
  resultText: { margin: '0 0 8px', fontSize: 14, lineHeight: 1.55 },
  hashRow: { margin: '6px 0', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' },
  hash: { fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.8 },
  linkRow: { display: 'flex', gap: 12, flexWrap: 'wrap', margin: '8px 0' },
  resultLink: { color: '#c8975a', fontSize: 13, fontWeight: 700 },
  doneButton: {
    marginTop: 8,
    padding: '10px 16px',
    borderRadius: 10,
    border: '1px solid rgba(148,163,184,0.4)',
    background: 'transparent',
    color: 'inherit',
    fontWeight: 700,
    cursor: 'pointer',
  },
};
