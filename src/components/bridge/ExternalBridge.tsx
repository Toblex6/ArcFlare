// src/components/bridge/ExternalBridge.tsx
//
// EXTERNAL multi-chain Bridge UI: source-chain USDC in the user's own
// browser wallet -> Circle CCTP / BridgeKit -> Arc Testnet -> the user's
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
// rapid taps produce exactly one kit.bridge() call, and a soft/partial
// BridgeKit result is resumed with kit.retry(...) — never a fresh
// kit.bridge() (which could duplicate spending).
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
  type BridgeAmountError,
} from '@/lib/bridge/sourceChains';
import { sourceViemChainFor } from '@/lib/bridge/sourceViemChains';
import { ensureEvmNetwork } from '@/lib/wallet/ensureEvmNetwork';
import { friendlyBridgeError } from '@/lib/wallet/walletErrors';

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

// ── Production-visible step trail (diagnosis instrumentation, no behavior change) ──
// bridgeDiag above is dev-only (gated by NODE_ENV), so production browsers emit
// NOTHING at each sub-step — a stall before verify leaves zero client evidence.
// bridgeTrace is ALWAYS ON (console.log, production included) and logs ONLY the
// step name + intent reference + public tx hashes / step states at the four
// sub-steps that matter: (a) intent created, (b/c) wallet signing via
// kit.bridge (approve+burn prompts), (d) verify POST. No keys, no seed phrases,
// no provider internals — reference + hashes are enough to correlate with the
// server's [bridge-stage] / [cctp/transfer/external/verify] Render log lines.
function bridgeTrace(step: string, data?: unknown): void {
  try {
    if (data === undefined) console.log(`[external-bridge] ${step}`);
    else console.log(`[external-bridge] ${step}`, data);
  } catch {
    // logging must never break the flow
  }
}

function stepOf(result: any, name: 'Approve' | 'Burn' | 'Mint'): KitStep | null {
  const steps: KitStep[] = Array.isArray(result?.steps) ? result.steps : [];
  return steps.find((s) => s?.name === name) ?? null;
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
  FAILED: 'Bridge failed',
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
  const sources = useMemo(() => getBridgeSourceChains(), []);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? 'Arbitrum_Sepolia');
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

  const [phase, setPhase] = useState<Phase>('form');
  const [stages, setStages] = useState<StageState[]>([]);
  const [stageNote, setStageNote] = useState<string | null>(null);
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
  // Soft/partial BridgeKit result kept for kit.retry resume (never a fresh
  // kit.bridge after funds may have moved).
  const resumeRef = useRef<{ result: any; intentReference: string } | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sessionLower = sessionAddress.trim().toLowerCase();
  const connectedLower = (connectedAddress ?? '').toLowerCase();
  const walletsMatch = isConnected && !!connectedAddress && connectedLower === sessionLower;

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
    fetch('/api/cctp/transfer/external/destination')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.success && d.destination) {
          setDestination(d.destination);
          bridgeDiag('D. FlareHQ CIRCLE destination', d.destination);
        } else if (d?.code === 'CIRCLE_WALLET_UNBOUND') {
          setDestination(null);
          setDestUnbound(d.error ?? 'No FlareHQ wallet is linked yet.');
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
    phase !== 'form' ||
    !walletsMatch ||
    !validation.ok ||
    balanceLoading ||
    destLoading ||
    // No linked destination: the wallet-creation path is email onboarding
    // (the unbound card), never a spend that the server would reject.
    (!!destUnbound && !destination);

  async function getProvider(): Promise<any> {
    try {
      return await (
        activeConnector as unknown as { getProvider?: () => Promise<unknown> }
      )?.getProvider?.();
    } catch {
      return (window as any)?.ethereum ?? null;
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
    if (approve?.state === 'success') setStage('approve', 'done');
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

  /** Bounded attestation/mint wait via kit.retry (resumes, never restarts). */
  async function waitForSettlement(
    kit: any,
    adapter: any,
    result: any,
    intentReference: string
  ): Promise<any> {
    let current = result;
    for (let i = 0; i < RETRY_ROUNDS; i++) {
      if (!mountedRef.current) throw new Error('Bridge interrupted.');
      if (current?.state === 'success' || current?.state === 'error') return current;
      setStageNote(
        current?.state === 'pending'
          ? 'Waiting for Circle attestation… Minting on Arc…'
          : 'Checking bridge status…'
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      try {
        // eslint-disable-next-line no-await-in-loop
        current = await kit.retry(current, { from: adapter, to: undefined });
        resumeRef.current = { result: current, intentReference };
        markStepsFromResult(current);
      } catch (e) {
        console.error('[external-bridge] retry poll failed (will retry):', e);
      }
    }
    return current;
  }

  async function verifyAndComplete(
    intentReference: string,
    burnTxHash: string | undefined,
    mintTxHash: string | undefined
  ): Promise<void> {
    if (!burnTxHash) {
      throw new Error(
        'Bridge transaction was not completed. No USDC left your wallet unless a transaction was confirmed.'
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
      throw new Error(v?.error ?? 'Bridge could not be completed.');
    }
    setStageNote('Confirming the Arc mint…');
    if (!mintTxHash) {
      // Burn proven, mint hash not yet available — the loop below keeps
      // polling server status; completion follows when the mint lands.
      throw new Error(
        'Burn verified — waiting for the Arc mint. Keep this open; completion follows automatically.'
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
        throw new Error(c.error);
      }
      throw new Error(c?.error ?? 'Bridge could not be completed.');
    }
    setReceipt({
      amountDisplay: c.amountDisplay ?? formatBridgeBaseUnits(BigInt(c.amount ?? '0')),
      actualDisplay: c.actualAmountDisplay ?? c.amountDisplay ?? '',
      sourceLabel: c.sourceLabel ?? source.label,
      destination: c.destination,
      burnTxHash: stepOf(resumeRef.current?.result, 'Burn')?.txHash ?? burnTxHash,
      mintTxHash: mintTxHash,
      sourceExplorerUrl: c.sourceExplorerUrl ?? null,
      destinationExplorerUrl: c.destinationExplorerUrl ?? null,
    });
    bridgeDiag('L. completion (server-verified)', {
      destination: c.destination,
      actual: c.actualAmountDisplay ?? c.actualAmount ?? null,
      mintTxHash,
    });
    setPhase('receipt');
    onBridgeCompleted();
  }

  async function runBridgeFlow(intentReference: string, kit: any, adapter: any): Promise<void> {
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
    let result: any;
    try {
      result = await (kit as any).bridge({
      from: {
        adapter,
        chain: source.id,
        address: sessionLower as `0x${string}`,
      },
      // ForwarderDestination: Circle's relayer mints on Arc — the user is
      // never asked to sign on, or switch to, the destination chain.
      to: {
        chain: 'Arc_Testnet',
        recipientAddress: destination as `0x${string}`,
        useForwarder: true,
      },
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
    }
    bridgeTrace('step-bc kit.bridge signing returned', {
      reference: intentReference,
      state: result?.state ?? null,
      approve: stepOf(result, 'Approve') ? { state: stepOf(result, 'Approve')?.state ?? null, txHash: stepOf(result, 'Approve')?.txHash ?? null } : null,
      burn: stepOf(result, 'Burn') ? { state: stepOf(result, 'Burn')?.state ?? null, txHash: stepOf(result, 'Burn')?.txHash ?? null } : null,
      mint: stepOf(result, 'Mint') ? { state: stepOf(result, 'Mint')?.state ?? null, txHash: stepOf(result, 'Mint')?.txHash ?? null } : null,
      error: result?.state === 'error' ? String(result?.error?.message ?? result?.error ?? '').slice(0, 300) : null,
    });
    bridgeDiag('G–I. kit result (approval/burn hashes + step states)', result);
    resumeRef.current = { result, intentReference };
    markStepsFromResult(result);

    if (result?.state === 'error') {
      const burn = stepOf(result, 'Burn');
      if (burn?.state === 'success') {
        // Burn moved funds but settlement failed — resume ONLY.
        setStageNote(null);
        throw Object.assign(
          new Error('Bridge could not be completed. Your burn was submitted — resume below to finish the mint (no new transaction will be created).'),
          { resumeOnly: true }
        );
      }
      if (burn?.state === 'error') {
        // The burn step itself failed (e.g. rejected at the burn prompt):
        // per the bridge lifecycle this is a failed burn — never restart it
        // automatically; the intent stays PENDING for safe retry.
        throw new Error('Bridge transaction was not completed.');
      }
      throw new Error(friendlyBridgeError(result?.error ?? result, { sourceLabel: source.label }));
    }

    let settled = result;
    if (settled?.state === 'pending') {
      setStage('approve', 'done');
      setStage('burn', 'done');
      setStage('attestation', 'active');
      settled = await waitForSettlement(kit, adapter, result, intentReference);
      resumeRef.current = { result: settled, intentReference };
      markStepsFromResult(settled);
    }

    if (settled?.state !== 'success') {
      // Budget exhausted or error after a submitted burn — resume ONLY.
      const burn = stepOf(settled, 'Burn');
      if (burn?.state === 'success' || burn?.txHash) {
        throw Object.assign(
          new Error('Still processing — the burn was submitted. Resume below to keep waiting (no new transaction will be created).'),
          { resumeOnly: true }
        );
      }
      throw new Error(friendlyBridgeError(settled?.error ?? settled, { sourceLabel: source.label }));
    }

    setStage('attestation', 'done');
    setStage('mint', 'done');
    const burnHash = stepOf(settled, 'Burn')?.txHash;
    const mintHash = stepOf(settled, 'Mint')?.txHash;
    bridgeDiag('J–K. attestation + Arc mint hash', { burnHash, mintHash });
    await verifyAndComplete(intentReference, burnHash, mintHash);
  }

  const startOver = useCallback(() => {
    // Fresh start is allowed ONLY when no step succeeded (nothing moved).
    // Otherwise the user must resume via kit.retry (guarded by the caller).
    busyRef.current = false;
    resumeRef.current = null;
    setStages([]);
    setStageNote(null);
    setError(null);
    setErrorStage(null);
    setReceipt(null);
    setPhase('form');
  }, []);

  async function handleBridge(): Promise<void> {
    // Synchronous double-submit guard (button disable alone races).
    if (busyRef.current || phase !== 'form') return;
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
      });
      if (!intent?.success) {
        if (intent?.code === 'CIRCLE_WALLET_UNBOUND') {
          setDestUnbound(intent.error);
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

      await runBridgeFlow(intentReference, kit, adapter);
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
        // Nothing was submitted (user rejected / pre-sign failure): the
        // failure message decides whether a fresh attempt is safe. Rejection
        // or wrong-chain text -> back to form. Anything ambiguous after the
        // wallet opened -> resume-safe default is form ONLY when no result
        // was captured (resumeRef null means kit.bridge never returned).
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
          msg.includes('Reconnect your wallet') ||
          msg.includes('Switch your wallet to') ||
          msg.includes('Enter a valid') ||
          msg.includes('at most 6 decimals') ||
          msg.includes('greater than zero') ||
          msg.includes('not have enough USDC') ||
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
    }
  }

  async function handleResume(): Promise<void> {
    const saved = resumeRef.current;
    if (!saved || busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setErrorStage(null);
    setPhase('working');
    try {
      await ensureOnSourceChain();
      const [{ BridgeKit }, { createViemAdapterFromProvider }] = await Promise.all([
        import('@circle-fin/bridge-kit'),
        import('@circle-fin/adapter-viem-v2'),
      ]);
      const provider = await getProvider();
      if (!provider?.request) throw new Error('Reconnect your wallet to continue.');
      const adapter = await createViemAdapterFromProvider({ provider });
      const kit: any = new (BridgeKit as any)();
      // Resume the SAME bridge — never a fresh kit.bridge().
      let settled = await waitForSettlement(kit, adapter, saved.result, saved.intentReference);
      resumeRef.current = { result: settled, intentReference: saved.intentReference };
      markStepsFromResult(settled);
      if (settled?.state !== 'success') {
        throw new Error('Still processing — the burn was submitted. Keep waiting below (no new transaction will be created).');
      }
      setStage('attestation', 'done');
      setStage('mint', 'done');
      await verifyAndComplete(
        saved.intentReference,
        stepOf(settled, 'Burn')?.txHash,
        stepOf(settled, 'Mint')?.txHash
      );
    } catch (e: any) {
      console.error('[external-bridge] resume', e);
      if (!mountedRef.current) return;
      busyRef.current = false;
      setPhase('awaiting-resume');
      const msg = String(e?.message ?? '');
      setError(
        msg.includes('Still processing') || msg.includes('waiting for the Arc mint')
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
    }
  }

  const working = phase === 'working';

  return (
    <div>
      <p style={{ color: 'var(--flow-text-faint)', fontSize: 'clamp(13px, 1.2vw, 15px)', margin: '0 0 16px' }}>
        Bring USDC from another wallet to your FlareHQ wallet.
      </p>

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
            disabled={working}
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
            disabled={working}
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
              <span style={styles.mono}>{shortAddr(destination)}</span>
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
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={styles.submitButton} onClick={handleResume}>
                  Resume bridge
                </button>
                <button
                  style={styles.secondaryButton}
                  onClick={() => {
                    // Abandon ONLY when nothing succeeded — otherwise the
                    // resume path above is the only safe action.
                    const r = resumeRef.current?.result;
                    const moved = (r?.steps ?? []).some((s: any) => s?.state === 'success');
                    if (moved) {
                      setError('A step already succeeded on-chain — resume above to finish (starting over could duplicate spending).');
                      return;
                    }
                    startOver();
                  }}
                >
                  Start over
                </button>
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
                <button style={styles.submitButton} disabled={formBlocked} onClick={handleBridge}>
                  {balanceLoading
                    ? 'Loading balance…'
                    : !walletsMatch
                      ? 'Reconnect your wallet to continue'
                      : 'Bridge USDC'}
                </button>
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
