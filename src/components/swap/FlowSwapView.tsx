// src/components/swap/FlowSwapView.tsx
//
// Flow Swap — consumer-facing same-chain USDC↔EURC swap inside /consumer.
// Two wallet modes, one quote backend:
//
//   CIRCLE (FlareHQ wallet): ordinary in-app swap. Enter amount → quote
//   (POST /api/swap/quote) → confirm → the server executes from the
//   consumer's own Circle developer-controlled SCA (POST /api/swap/execute)
//   → verified success. No browser wallet popup, no second authentication
//   ceremony — the authenticated consumer session (+ payment PIN where
//   enrolled) is sufficient.
//   EXTERNAL (connected wallet): the browser wallet signs everything; the
//   server never signs and never sees keys. Enter amount → quote → confirm
//   → sign each server-provided step (approvals, optional wrap, swap) →
//   wait for mining → register (POST /api/swap/execute-intent) → verify
//   on-chain (POST /api/swap/verify) → [USDC-output only] receive step
//   (POST /api/swap/unwrap → sign withdraw → POST /api/swap/verify-unwrap)
//   → verified success.
//
// The UnitFlow pools settle the USDC leg in WUSDC, so a swap INTO USDC
// credits WUSDC first; the receive step burns exactly the verified proceeds
// into native USDC in the user's own wallet. The user experiences
// EURC → USDC — WUSDC is never presented as the result.
//
// Success is shown ONLY after server verification. The verified
// actualOutput is authoritative — the pre-execution quote is never presented
// as the received amount.
//
// Safety properties (verified in code, see the integration checklist):
// - No client-controlled payer or recipient: the server derives both from
//   the authenticated session; the UI sends no addresses and renders no
//   address inputs.
// - No private keys, no Tower execution, no cross-chain path, no tokens
//   beyond USDC/EURC.
// - No pool/router/fee-tier/calldata internals are displayed. The execution
//   venue label (from the backend quote) and the informational Tower
//   rate-discovery candidate are shown as secondary provenance only —
//   derived from the backend response, never hardcoded.

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
} from 'wagmi';
import type { Address } from 'viem';
import { getNetworkConfig, explorerTxUrl } from '@/lib/config/network';
import { ensureArcNetwork } from '@/lib/wallet/ensureArcNetwork';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';
import {
  friendlyConnectorLabel,
} from '@/lib/wallet/walletLabels';
import { useGuardedConnect } from '@/hooks/useGuardedConnect';
import { useSwapBalances } from './useSwapBalances';
import { useSwapQuote, type SwapQuoteView } from './useSwapQuote';
import {
  formatCanonical,
  formatCountdown,
  friendlySwapError,
  friendlySwapWalletError,
  friendlyVenueLabel,
  parseAmountToBaseUnits,
  shortAddress,
  shortHash,
  truncateToSixDecimals,
  validateSwapAmount,
  type SwapSymbol,
} from './swapCopy';

const ARC_CHAIN_ID = getNetworkConfig().chainId;

type FlowPhase = 'form' | 'executing' | 'mined' | 'verifying' | 'verified' | 'failed';

interface ExecStepState {
  key: string;
  label: string;
  status: 'pending' | 'active' | 'done';
  hash: string | null;
}

interface VerifiedSwap {
  actualInput: string;
  actualOutput: string;
  inputSymbol: SwapSymbol;
  outputSymbol: SwapSymbol;
  executionTxHash: string | null;
  wrapTxHash: string | null;
  /** Present only for USDC-output swaps (the WUSDC→native exit). */
  unwrapTxHash: string | null;
  alreadySettled: boolean;
}

function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function FlowSwapView({
  walletAddress,
  walletType,
  circleWalletId,
  onSwitchWallet,
  onStayManaged,
  onSwapVerified,
  authedPost,
}: {
  walletAddress: string;
  walletType: string | null;
  /** Circle developer-controlled wallet id (CIRCLE only; null for EXTERNAL). */
  circleWalletId?: string | null;
  onSwitchWallet?: () => void;
  /** Optional: leave the managed wallet in place and go back (e.g. Home). */
  onStayManaged?: () => void;
  /** Called once per verified swap so the parent can refresh activity. */
  onSwapVerified?: () => void;
  /**
   * PIN-aware POST helper wired by the parent (step-up headers). Used for
   * the CIRCLE server-execution call so an enrolled payment PIN is
   * requested exactly once per session instead of failing the swap.
   * Falls back to plain fetch when absent.
   */
  authedPost?: (url: string, body: unknown) => Promise<any>;
}) {
  const [inputSymbol, setInputSymbol] = useState<SwapSymbol>('USDC');
  const [outputSymbol, setOutputSymbol] = useState<SwapSymbol>('EURC');
  const [amount, setAmount] = useState('');

  const [flow, setFlow] = useState<FlowPhase>('form');
  const [steps, setSteps] = useState<ExecStepState[]>([]);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowRawError, setFlowRawError] = useState<string | null>(null);
  const [verified, setVerified] = useState<VerifiedSwap | null>(null);
  const [minedExecHash, setMinedExecHash] = useState<string | null>(null);
  const [minedWrapHash, setMinedWrapHash] = useState<string | null>(null);
  const [minedUnwrapHash, setMinedUnwrapHash] = useState<string | null>(null);
  const [lastIntentId, setLastIntentId] = useState<string | null>(null);
  const [lastOutputSymbol, setLastOutputSymbol] = useState<SwapSymbol | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  // In-flight guard: Confirm is disabled once the flow leaves 'form', but two
  // rapid clicks before re-render would both pass the render-time check and
  // broadcast twice. The ref closes that gap (reset on every terminal path).
  const confirmBusyRef = useRef(false);

  // ── Wallet plumbing (existing wagmi infrastructure, no second system) ──
  const { address: connectedAddress, isConnected, connector: activeConnector } = useAccount();
  // Guarded connect: synchronous ref lock suppresses double-fire re-entry.
  const { connectors, connectAsync: guardedConnectAsync, isConnecting, dedupedConnectors } = useGuardedConnect();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const { sendTransactionAsync, isPending: isSending } = useSendTransaction();

  const sessionLive = walletAddress.trim() !== '';
  const walletsMatch =
    isConnected && !!connectedAddress && connectedAddress.toLowerCase() === walletAddress.trim().toLowerCase();
  // Two wallet modes: CIRCLE = FlareHQ wallet (the server executes from the
  // consumer's own Circle developer-controlled SCA — no browser signing);
  // EXTERNAL = connected wallet (the browser signs every step). Anything
  // else fails closed below.
  const sessionIsExternal = (walletType ?? '').toUpperCase() === 'EXTERNAL';
  const sessionIsCircle = (walletType ?? '').toUpperCase() === 'CIRCLE';
  // A CIRCLE row without its Circle signing binding cannot be
  // server-executed — recoverable account state, never a guessed wallet.
  const circleUnbound = sessionIsCircle && !circleWalletId;
  const canSwapHere = sessionIsExternal || (sessionIsCircle && !circleUnbound);
  const wrongNetwork = isConnected && chainId !== ARC_CHAIN_ID;

  const balances = useSwapBalances(sessionLive);
  const quoteActive = sessionLive && flow === 'form';
  const quote = useSwapQuote(inputSymbol, outputSymbol, amount, quoteActive);

  // A fresh live quote supersedes the expired-quote notice from a previous
  // confirm attempt — clear it so the form doesn't cry wolf.
  useEffect(() => {
    if (quote.status === 'quoted' && flow === 'form') {
      setFlowError((prev) => (prev !== null && prev.includes('expired') ? null : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote.status, quote.quote?.intentId]);

  // Component-scope signing helpers so both the swap sequence (handleConfirm)
  // and the chained receive step (registerAndVerify) sign exactly the
  // server-provided transactions, wait for mining, and fail fast on revert.
  const markStep = (key: string, patch: Partial<ExecStepState>) =>
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const sendAndMine = async (to: string, data: `0x${string}`, value: string): Promise<string> => {
    if (!publicClient) throw new Error('Swap service unavailable — reconnect your wallet and try again.');
    const hash = await sendTransactionAsync({
      to: to as Address,
      data,
      value: BigInt(value),
      chainId: ARC_CHAIN_ID,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    // Fail fast on a reverted step instead of broadcasting the remaining
    // steps against a broken sequence — verification below stays the
    // success gate either way.
    if (receipt.status !== 'success') throw new Error('Transaction reverted on-chain.');
    return hash;
  };

  const amountError = validateSwapAmount(amount);
  const inputBaseUnits = useMemo(() => parseAmountToBaseUnits(amount), [amount]);
  const inputBalanceBase = useMemo(() => {
    const b = balances.balances[inputSymbol];
    if (b === null) return null;
    try {
      const [whole, frac = ''] = b.split('.');
      const padded = (frac + '000000').slice(0, 6);
      return BigInt(`${whole === '' ? '0' : whole}${padded}`);
    } catch {
      return null;
    }
  }, [balances.balances, inputSymbol]);
  const insufficientBalance =
    inputBaseUnits !== null && inputBalanceBase !== null && inputBaseUnits > inputBalanceBase;

  const pickSymbol = (side: 'in' | 'out', next: SwapSymbol) => {
    if (flow !== 'form') return;
    if (side === 'in') {
      setInputSymbol(next);
      if (next === outputSymbol) setOutputSymbol(next === 'USDC' ? 'EURC' : 'USDC');
    } else {
      setOutputSymbol(next);
      if (next === inputSymbol) setInputSymbol(next === 'USDC' ? 'EURC' : 'USDC');
    }
  };

  const toggleDirection = () => {
    if (flow !== 'form') return;
    setInputSymbol(outputSymbol);
    setOutputSymbol(inputSymbol);
  };

  const maxAmount = () => {
    const b = balances.balances[inputSymbol];
    // Truncate (never round up): raw balance strings can carry more than 6
    // decimals, which the amount field itself would reject.
    if (b !== null) setAmount(truncateToSixDecimals(b));
  };

  const resetAfterSuccess = () => {
    confirmBusyRef.current = false;
    setAmount('');
    setFlow('form');
    setSteps([]);
    setFlowError(null);
    setFlowRawError(null);
    setVerified(null);
    setMinedExecHash(null);
    setMinedWrapHash(null);
    setMinedUnwrapHash(null);
    setLastIntentId(null);
    setLastOutputSymbol(null);
    balances.refresh();
  };

  const startOver = () => {
    confirmBusyRef.current = false;
    setFlow('form');
    setSteps([]);
    setFlowError(null);
    setFlowRawError(null);
    quote.refresh();
  };

  // ── Execution: sign each server-provided step, wait for mining ──
  const handleConfirm = async () => {
    if (confirmBusyRef.current) return;
    const live = quote.quote;
    if (!live || quote.status !== 'quoted' || quote.secondsLeft <= 0) {
      // Prefer a fresh quote over a dead-end failure state: stay in the form
      // and re-request automatically. Nothing was signed, nothing was lost.
      quote.refresh();
      setFlowError('That quote expired before it could be used. Getting a fresh quote — confirm again once it arrives.');
      setFlowRawError(null);
      return;
    }
    if (!walletsMatch) {
      setFlowError('Connect the same wallet you signed in with before swapping.');
      setFlowRawError(null);
      setFlow('failed');
      return;
    }
    if (insufficientBalance) {
      setFlowError(
        `Insufficient ${inputSymbol} balance for this swap. Lower the amount and try again.`
      );
      setFlowRawError(null);
      setFlow('failed');
      return;
    }
    setFlowError(null);
    setFlowRawError(null);
    setVerified(null);
    setMinedExecHash(null);
    setMinedWrapHash(null);
    setMinedUnwrapHash(null);
    setLastIntentId(live.intentId);
    setLastOutputSymbol(live.output.symbol);
    confirmBusyRef.current = true;
    setFlow('executing');

    const initialSteps: ExecStepState[] = [
      ...live.unsigned.approvals.map((a, i) => ({
        key: `approve-${i}`,
        label: `Approve ${inputSymbol}`,
        status: 'pending' as const,
        hash: null as string | null,
      })),
      ...(live.unsigned.wrapTx
        ? [{ key: 'wrap', label: `Wrap ${inputSymbol}`, status: 'pending' as const, hash: null as string | null }]
        : []),
      { key: 'swap', label: 'Confirm swap', status: 'pending' as const, hash: null as string | null },
    ];
    setSteps(initialSteps);

    try {
      // Network safety first (existing ensureArcNetwork, never silent).
      if (chainId !== ARC_CHAIN_ID) {
        const providerGetter = async () => {
          try {
            return await (activeConnector as unknown as { getProvider?: () => Promise<unknown> })?.getProvider?.();
          } catch {
            return null;
          }
        };
        const net = await ensureArcNetwork({ chainId, switchChainAsync, getProvider: providerGetter });
        if (!net.ok) throw new Error(net.message);
      }
      if (!publicClient) throw new Error('Swap service unavailable — reconnect your wallet and try again.');

      // Step(s): approvals exactly as the server issued them, in order.
      for (let i = 0; i < live.unsigned.approvals.length; i++) {
        const tx = live.unsigned.approvals[i]!;
        markStep(`approve-${i}`, { status: 'active' });
        const hash = await sendAndMine(tx.to, tx.data, tx.value);
        markStep(`approve-${i}`, { status: 'done', hash });
      }

      // Step: wrap (present only when the intent requires it).
      let wrapHash: string | null = null;
      if (live.unsigned.wrapTx) {
        markStep('wrap', { status: 'active' });
        wrapHash = await sendAndMine(live.unsigned.wrapTx.to, live.unsigned.wrapTx.data, live.unsigned.wrapTx.value);
        markStep('wrap', { status: 'done', hash: wrapHash });
        setMinedWrapHash(wrapHash);
      }

      // Step: swap. The wallet submission is NOT success — mining + server
      // verification below decide the outcome.
      markStep('swap', { status: 'active' });
      const execHash = await sendAndMine(live.unsigned.swapTx.to, live.unsigned.swapTx.data, live.unsigned.swapTx.value);
      markStep('swap', { status: 'done', hash: execHash });
      setMinedExecHash(execHash);
      setFlow('mined');

      await registerAndVerify(live, wrapHash, execHash);
    } catch (err: unknown) {
      confirmBusyRef.current = false;
      const raw = err instanceof Error ? err.message : String(err ?? '');
      const lower = raw.toLowerCase();
      // On-chain failures (revert / missing receipt) already have precise
      // product copy — prefer it over the generic wallet-step message.
      const onchain = lower.includes('revert') || lower.includes('not found on-chain') || lower.includes('receipt not found');
      const headline = onchain
        ? friendlySwapError(raw).headline
        : lower.includes("couldn't switch") ||
          lower.includes('arc testnet') ||
          lower.includes('cancelled') ||
          lower.includes('network switch was cancelled')
          ? raw
          : friendlySwapWalletError(err);
      setFlowError(headline);
      setFlowRawError(raw || null);
      setFlow('failed');
    }
  };

  // Register broadcast hashes (best-effort) then verify on-chain. Verify is
  // the gate: nothing here shows success.
  const registerAndVerify = async (live: SwapQuoteView, wrapHash: string | null, execHash: string) => {
    setFlow('verifying');
    try {
      await fetchWithTimeout(
        '/api/swap/execute-intent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intentId: live.intentId,
            ...(wrapHash ? { wrapTxHash: wrapHash } : {}),
            executionTxHash: execHash,
          }),
        },
        30000
      ).catch(() => null); // best-effort: verify below carries the same evidence
    } catch {
      // Registration hiccups must not block verification — verify resubmits
      // the same evidence and is idempotent for this intent.
    }
    const verifyRes = await fetchWithTimeout(
      '/api/swap/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId: live.intentId,
          ...(wrapHash ? { wrapTxHash: wrapHash } : {}),
          executionTxHash: execHash,
        }),
      },
      90000
    );
    const verifyData = (await verifyRes.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
      actualInput?: string;
      actualOutput?: string;
      executionTxHash?: string;
      wrapTxHash?: string | null;
      alreadySettled?: boolean;
    } | null;
    if (!verifyRes.ok || !verifyData || verifyData.success !== true) {
      const { headline, raw } = friendlySwapError(verifyData?.error);
      setFlowError(headline);
      setFlowRawError(raw);
      setFlow('failed');
      return;
    }
    const swapActualInput = String(verifyData.actualInput ?? live.input.amount);
    const swapActualOutput = String(verifyData.actualOutput ?? '0');
    const swapExecHash = verifyData.executionTxHash ?? execHash;
    const swapWrapHash = verifyData.wrapTxHash ?? wrapHash;

    // USDC-output swaps credit WUSDC first — the receive step burns exactly
    // the verified proceeds into native USDC before any success is shown.
    // EURC-output swaps settle directly and skip this step entirely.
    if (live.output.symbol !== 'USDC') {
      // Authoritative actuals come from verification — never from the quote.
      setVerified({
        actualInput: swapActualInput,
        actualOutput: swapActualOutput,
        inputSymbol: live.input.symbol,
        outputSymbol: live.output.symbol,
        executionTxHash: swapExecHash,
        wrapTxHash: swapWrapHash,
        unwrapTxHash: null,
        alreadySettled: !!verifyData.alreadySettled,
      });
      setFlow('verified');
      balances.refresh();
      onSwapVerified?.();
      return;
    }

    setSteps((prev) => [
      ...prev,
      { key: 'unwrap', label: 'Receive USDC', status: 'pending' as const, hash: null as string | null },
    ]);
    setFlow('executing');
    const unwrapRes = await fetchWithTimeout(
      '/api/swap/unwrap',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId: live.intentId }),
      },
      30000
    );
    const unwrapData = (await unwrapRes.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
      unwrapTx?: { to: string; data: `0x${string}`; value: string; label: string };
      finalReceived?: string;
    } | null;
    if (!unwrapRes.ok || !unwrapData || unwrapData.success !== true || !unwrapData.unwrapTx) {
      const { headline, raw } = friendlySwapError(unwrapData?.error ?? 'The receive step could not be prepared.');
      setFlowError(headline);
      setFlowRawError(raw);
      setFlow('failed');
      return;
    }
    markStep('unwrap', { status: 'active' });
    const unwrapHash = await sendAndMine(unwrapData.unwrapTx.to, unwrapData.unwrapTx.data, unwrapData.unwrapTx.value);
    markStep('unwrap', { status: 'done', hash: unwrapHash });
    setMinedUnwrapHash(unwrapHash);
    setFlow('verifying');

    const unwrapVerifyRes = await fetchWithTimeout(
      '/api/swap/verify-unwrap',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId: live.intentId, unwrapTxHash: unwrapHash }),
      },
      90000
    );
    const unwrapVerifyData = (await unwrapVerifyRes.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
      finalReceived?: string;
      unwrapTxHash?: string;
    } | null;
    if (!unwrapVerifyRes.ok || !unwrapVerifyData || unwrapVerifyData.success !== true) {
      const { headline, raw } = friendlySwapError(unwrapVerifyData?.error ?? 'The receive step could not be verified.');
      setFlowError(headline);
      setFlowRawError(raw);
      setFlow('failed');
      return;
    }
    // Final USDC received comes from unwrap verification — the native
    // settlement proof — never from the quote.
    setVerified({
      actualInput: swapActualInput,
      actualOutput: String(unwrapVerifyData.finalReceived ?? swapActualOutput),
      inputSymbol: live.input.symbol,
      outputSymbol: live.output.symbol,
      executionTxHash: swapExecHash,
      wrapTxHash: swapWrapHash,
      unwrapTxHash: unwrapVerifyData.unwrapTxHash ?? unwrapHash,
      alreadySettled: !!verifyData.alreadySettled,
    });
    setFlow('verified');
    balances.refresh();
    onSwapVerified?.();
  };

  // Manual "verify again" — resubmits evidence for the same mined
  // transaction. Never rebroadcasts a money-moving transaction. When the
  // receive step already mined, it re-verifies the unwrap (not the swap).
  const retryVerify = async () => {
    if (!lastIntentId || !minedExecHash) return;
    const live = quote.quote;
    setFlowError(null);
    setFlowRawError(null);
    setFlow('verifying');
    if (minedUnwrapHash) {
      try {
        const unwrapVerifyRes = await fetchWithTimeout(
          '/api/swap/verify-unwrap',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ intentId: lastIntentId, unwrapTxHash: minedUnwrapHash }),
          },
          90000
        );
        const unwrapVerifyData = (await unwrapVerifyRes.json().catch(() => null)) as {
          success?: boolean;
          error?: string;
          finalReceived?: string;
          unwrapTxHash?: string;
        } | null;
        if (!unwrapVerifyRes.ok || !unwrapVerifyData || unwrapVerifyData.success !== true) {
          const { headline, raw } = friendlySwapError(unwrapVerifyData?.error);
          setFlowError(headline);
          setFlowRawError(raw);
          setFlow('failed');
          return;
        }
        setVerified({
          actualInput: verified?.actualInput ?? '0',
          actualOutput: String(unwrapVerifyData.finalReceived ?? verified?.actualOutput ?? '0'),
          inputSymbol: live?.input.symbol ?? inputSymbol,
          outputSymbol: (lastOutputSymbol ?? live?.output.symbol ?? outputSymbol) as SwapSymbol,
          executionTxHash: minedExecHash,
          wrapTxHash: minedWrapHash,
          unwrapTxHash: unwrapVerifyData.unwrapTxHash ?? minedUnwrapHash,
          alreadySettled: false,
        });
        setFlow('verified');
        balances.refresh();
        onSwapVerified?.();
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err ?? '');
        const { headline, raw: mappedRaw } = friendlySwapError(raw);
        setFlowError(headline);
        setFlowRawError(mappedRaw);
        setFlow('failed');
      }
      return;
    }
    try {
      const verifyRes = await fetchWithTimeout(
        '/api/swap/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intentId: lastIntentId,
            ...(minedWrapHash ? { wrapTxHash: minedWrapHash } : {}),
            executionTxHash: minedExecHash,
          }),
        },
        90000
      );
      const verifyData = (await verifyRes.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        actualInput?: string;
        actualOutput?: string;
        executionTxHash?: string;
        wrapTxHash?: string | null;
        alreadySettled?: boolean;
      } | null;
      if (!verifyRes.ok || !verifyData || verifyData.success !== true) {
        const { headline, raw } = friendlySwapError(verifyData?.error);
        setFlowError(headline);
        setFlowRawError(raw);
        setFlow('failed');
        return;
      }
      setVerified({
        actualInput: String(verifyData.actualInput ?? '0'),
        actualOutput: String(verifyData.actualOutput ?? '0'),
        inputSymbol: live?.input.symbol ?? inputSymbol,
        outputSymbol: live?.output.symbol ?? outputSymbol,
        executionTxHash: verifyData.executionTxHash ?? minedExecHash,
        wrapTxHash: verifyData.wrapTxHash ?? minedWrapHash,
        unwrapTxHash: null,
        alreadySettled: !!verifyData.alreadySettled,
      });
      setFlow('verified');
      balances.refresh();
      onSwapVerified?.();
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err ?? '');
      const { headline, raw: mappedRaw } = friendlySwapError(raw);
      setFlowError(headline);
      setFlowRawError(mappedRaw);
      setFlow('failed');
    }
  };

  // ── CIRCLE execution: the server swaps from the consumer's own FlareHQ
  // wallet (Circle developer-controlled SCA) and returns the verified
  // result. No browser wallet, no popup — ordinary in-app progress until
  // the verified receipt lands. Backend typed codes are surfaced honestly:
  // EXTERNAL_* never occurs here; CIRCLE_WALLET_UNBOUND is recoverable
  // account state; expired quotes re-quote instead of failing.
  const [circleBusy, setCircleBusy] = useState(false);
  const handleCircleConfirm = async () => {
    if (circleBusy || confirmBusyRef.current) return;
    const live = quote.quote;
    if (!live || quote.status !== 'quoted' || quote.secondsLeft <= 0) {
      quote.refresh();
      setFlowError('That quote expired before it could be used. Getting a fresh quote — confirm again once it arrives.');
      setFlowRawError(null);
      return;
    }
    if (insufficientBalance) {
      setFlowError(`Insufficient ${inputSymbol} balance for this swap. Lower the amount and try again.`);
      setFlowRawError(null);
      setFlow('failed');
      return;
    }
    setFlowError(null);
    setFlowRawError(null);
    setVerified(null);
    setMinedExecHash(null);
    setMinedWrapHash(null);
    setMinedUnwrapHash(null);
    setLastIntentId(live.intentId);
    setLastOutputSymbol(live.output.symbol);
    confirmBusyRef.current = true;
    setCircleBusy(true);
    setSteps([{ key: 'server-swap', label: 'Swapping in your FlareHQ wallet', status: 'active', hash: null }]);
    setFlow('executing');
    try {
      const post = authedPost
        ? (body: unknown) => authedPost('/api/swap/execute', body)
        : async (body: unknown) => {
            const res = await fetchWithTimeout(
              '/api/swap/execute',
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
              300000
            );
            const data = (await res.json().catch(() => null)) as any;
            if (!res.ok || !data || data.success !== true) {
              const err = new Error(data?.error || 'Swap execution failed.') as any;
              err.code = data?.code;
              throw err;
            }
            return data;
          };
      const data = (await post({ intentId: live.intentId, quoteHash: live.quoteHash })) as {
        success?: boolean;
        error?: string;
        code?: string;
        intentId?: string;
        status?: string;
        alreadySettled?: boolean;
        input?: { symbol: string; amount: string };
        output?: { symbol: string; actual: string };
        executionTxHash?: string | null;
        wrapTxHash?: string | null;
        unwrapTxHash?: string | null;
      };
      markStep('server-swap', { status: 'done', hash: data.executionTxHash ?? null });
      if (data.executionTxHash) setMinedExecHash(data.executionTxHash);
      if (data.wrapTxHash) setMinedWrapHash(data.wrapTxHash);
      if (data.unwrapTxHash) setMinedUnwrapHash(data.unwrapTxHash);
      // The server verified every step on-chain before responding — its
      // actuals are authoritative, never the pre-execution quote.
      setVerified({
        actualInput: String(data.input?.amount ?? live.input.amount),
        actualOutput: String(data.output?.actual ?? '0'),
        inputSymbol: live.input.symbol,
        outputSymbol: live.output.symbol,
        executionTxHash: data.executionTxHash ?? null,
        wrapTxHash: data.wrapTxHash ?? null,
        unwrapTxHash: data.unwrapTxHash ?? null,
        alreadySettled: !!data.alreadySettled,
      });
      setFlow('verified');
      balances.refresh();
      onSwapVerified?.();
    } catch (err: unknown) {
      const code = (err as any)?.code ? String((err as any).code) : '';
      const raw = err instanceof Error ? err.message : String(err ?? '');
      if (code === 'CIRCLE_WALLET_UNBOUND') {
        setFlowError('Your FlareHQ wallet needs attention before it can swap — no funds moved. Try again later or contact support.');
      } else if (code === 'EXTERNAL_REQUIRES_BROWSER_SIGNATURE') {
        setFlowError('This wallet signs in the browser — connect it below and confirm again.');
      } else if (code === 'STEP_UP_REQUIRED' || code === 'STEP_UP_FAILED') {
        setFlowError('Your payment PIN is required for this swap. Try again and enter it when asked.');
      } else if (code === 'WALLET_UNSUPPORTED') {
        setFlowError('This wallet type is no longer supported for swaps.');
      } else {
        const { headline } = friendlySwapError(raw);
        setFlowError(headline);
      }
      setFlowRawError(raw || null);
      setFlow('failed');
    } finally {
      confirmBusyRef.current = false;
      setCircleBusy(false);
    }
  };

  const circleConfirmDisabled =
    flow !== 'form' ||
    quote.status !== 'quoted' ||
    quote.secondsLeft <= 0 ||
    inputBaseUnits === null ||
    insufficientBalance ||
    circleBusy;

  const circleConfirmHint =
    insufficientBalance
      ? `Amount exceeds your available ${inputSymbol} balance.`
      : quote.status === 'error' || quote.status === 'expired'
        ? 'Get a fresh quote to continue.'
        : quote.status !== 'quoted'
          ? 'Enter an amount to get a quote.'
          : null;

  // Guarded by useGuardedConnect's synchronous ref lock: a second tap
  // before re-render no-ops inside guardedConnectAsync instead of opening
  // a second WalletConnect session. Error behavior unchanged.
  const connectWith = async (connectorUid: string) => {
    setConnectError(null);
    try {
      const target = connectors.find((c) => c.uid === connectorUid);
      if (!target) throw new Error('Wallet connector unavailable.');
      await guardedConnectAsync(target);
    } catch (err: unknown) {
      setConnectError(friendlyWalletError(err));
    }
  };

  const confirmDisabled =
    flow !== 'form' ||
    quote.status !== 'quoted' ||
    quote.secondsLeft <= 0 ||
    inputBaseUnits === null ||
    insufficientBalance ||
    !walletsMatch ||
    wrongNetwork ||
    isSending;

  const confirmHint = !walletsMatch
    ? 'Connect the matching wallet to continue.'
    : wrongNetwork
      ? 'Switch to Arc Testnet to continue.'
      : insufficientBalance
        ? `Amount exceeds your available ${inputSymbol} balance.`
        : quote.status === 'error' || quote.status === 'expired'
          ? 'Get a fresh quote to continue.'
          : quote.status !== 'quoted'
            ? 'Enter an amount to get a quote.'
            : null;

  return (
    <section style={styles.card}>
      <h2 style={styles.title}>Swap</h2>
      <p style={styles.sub}>
        {sessionIsCircle
          ? 'Swap USDC and EURC right inside your FlareHQ wallet — no wallet popups.'
          : 'Swap USDC and EURC directly on Arc. Approve each step in your connected wallet.'}
      </p>
      <div style={styles.line}>
        <span style={styles.dot} />
        <span style={styles.stroke} />
        <span style={styles.dot} />
      </div>

      {/* ── Session / custody gate ── */}
      {!sessionLive && (
        <div style={styles.errorBox}>
          <p style={styles.boxText}>Sign in to use Flow Swap.</p>
        </div>
      )}
      {sessionLive && sessionIsCircle && circleUnbound && (
        <div style={styles.errorBox}>
          <p style={styles.boxTitle}>Your FlareHQ wallet needs attention</p>
          <p style={styles.boxText}>
            This wallet is missing its signing identity, so swaps are unavailable right now.
            No funds moved. Try again later or contact support.
          </p>
        </div>
      )}
      {sessionLive && !sessionIsCircle && !sessionIsExternal && (
        <div style={styles.errorBox}>
          <p style={styles.boxText}>This wallet type is no longer supported for swaps.</p>
        </div>
      )}

      {sessionLive && canSwapHere && (
        <>
          {sessionIsCircle && (
            <div style={styles.walletRow}>
              <span style={styles.walletLabel}>Swapping with</span>
              <span style={styles.walletAddr}>{shortAddress(walletAddress)}</span>
              <span style={styles.matchOk}>FlareHQ wallet · no wallet approval needed</span>
            </div>
          )}
          {sessionIsExternal && (
          <>
          {/* ── Wallet consistency (never silently substitute) ── */}
          <div style={styles.walletRow}>
            <span style={styles.walletLabel}>Swapping with</span>
            <span style={styles.walletAddr}>{shortAddress(walletAddress)}</span>
            <span style={walletsMatch ? styles.matchOk : styles.matchWarn}>
              {walletsMatch ? '✓ connected wallet matches' : '⚠ connected wallet differs'}
            </span>
          </div>
          {!walletsMatch && (
            <div style={styles.noticeBox}>
              <p style={styles.boxText}>
                {!isConnected || !connectedAddress
                  ? 'Connect the wallet you signed in with — the swap must be signed by it.'
                  : `Connected wallet ${shortAddress(connectedAddress)} is not the wallet you signed in with (${shortAddress(walletAddress)}). Reconnect the matching wallet.`}
              </p>
              {(() => {
                const pickers = dedupedConnectors;
                if (pickers.length === 0) {
                  return (
                    <p style={{ ...styles.boxText, marginTop: 8 }}>
                      No wallet connector is available in this browser. Install a wallet extension
                      first, then reconnect.{" "}
                      <a href="https://ethereum.org/en/wallets/" target="_blank" rel="noopener noreferrer" style={styles.link}>
                        Get a wallet ↗
                      </a>
                    </p>
                  );
                }
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    {pickers.map((c) => (
                      <button
                        key={c.uid}
                        style={styles.secondaryButton}
                        disabled={isConnecting}
                        onClick={() => void connectWith(c.uid)}
                      >
                        {isConnecting ? 'Connecting…' : `Connect ${friendlyConnectorLabel(c)}`}
                      </button>
                    ))}
                  </div>
                );
              })()}
              {connectError && <p style={styles.inlineError}>{connectError}</p>}
            </div>
          )}
          {walletsMatch && wrongNetwork && (
            <div style={styles.noticeBox}>
              <p style={styles.boxText}>Your wallet is on the wrong network. Flow Swap settles on Arc Testnet.</p>
              <button
                style={styles.secondaryButton}
                disabled={isSending}
                onClick={() =>
                  ensureArcNetwork({
                    chainId,
                    switchChainAsync,
                    getProvider: async () => {
                      try {
                        return await (activeConnector as unknown as { getProvider?: () => Promise<unknown> })?.getProvider?.();
                      } catch {
                        return null;
                      }
                    },
                  }).then((net) => {
                    if (!net.ok) setFlowError(net.message);
                    else setFlowError(null);
                  })
                }
              >
                Switch to Arc Testnet
              </button>
            </div>
          )}
          </>
          )}

          {/* ── Balances (both tokens, parallel) ── */}
          <div style={styles.balanceRow}>
            {(['USDC', 'EURC'] as SwapSymbol[]).map((s) => {
              const v = balances.balances[s];
              const failed = !balances.loading && v === null && balances.error !== null;
              return (
                <div key={s} style={styles.balanceChip}>
                  <span style={styles.balanceSym}>{s}</span>
                  <span
                    style={styles.balanceVal}
                    title={
                      balances.loading
                        ? 'Loading balance…'
                        : failed
                          ? 'Balance failed to load — retry below.'
                          : v === null
                            ? 'Balance not loaded yet.'
                            : `${v} ${s}`
                    }
                  >
                    {balances.loading ? '…' : v !== null ? v : failed ? '! Failed to load' : '—'}
                  </span>
                </div>
              );
            })}
            <button style={styles.miniButton} onClick={balances.refresh} disabled={balances.loading || flow !== 'form'}>
              {balances.loading ? '…' : '↻'}
            </button>
          </div>
          {balances.error && (
            <div style={styles.errorBox}>
              <p style={styles.boxText}>⚠️ {balances.error}</p>
              <button style={styles.secondaryButton} onClick={balances.refresh} disabled={balances.loading}>
                {balances.loading ? 'Retrying…' : 'Retry loading balances'}
              </button>
            </div>
          )}

          {/* ── Swap form ── */}
          {(flow === 'form' || flow === 'failed') && (
            <>
              <div style={styles.swapBox}>
                <div style={styles.field}>
                  <label style={styles.label}>From</label>
                  <div style={styles.amountRow}>
                    <input
                      style={styles.amountInput}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`Amount in ${inputSymbol}`}
                      disabled={flow !== 'form'}
                    />
                    <select
                      value={inputSymbol}
                      onChange={(e) => pickSymbol('in', e.target.value as SwapSymbol)}
                      aria-label="Input token"
                      style={styles.tokenSelect}
                      disabled={flow !== 'form'}
                    >
                      <option value="USDC">USDC</option>
                      <option value="EURC">EURC</option>
                    </select>
                  </div>
                  <div style={styles.underRow}>
                    <span style={styles.underText}>
                      Available:{' '}
                      <strong>
                        {balances.loading ? '…' : balances.balances[inputSymbol] !== null ? `${balances.balances[inputSymbol]} ${inputSymbol}` : '—'}
                      </strong>
                    </span>
                    <button style={styles.miniButton} onClick={maxAmount} disabled={flow !== 'form' || balances.loading}>
                      Max
                    </button>
                  </div>
                  {amountError && amount.trim() !== '' && <p style={styles.inlineError}>{amountError}</p>}
                  {insufficientBalance && (
                    <p style={styles.inlineError}>Amount exceeds your available {inputSymbol} balance.</p>
                  )}
                </div>

                <button style={styles.toggleButton} onClick={toggleDirection} disabled={flow !== 'form'} aria-label="Swap direction">
                  ⇅
                </button>

                <div style={styles.field}>
                  <label style={styles.label}>To</label>
                  <div style={styles.amountRow}>
                    <div style={styles.outputPreview} aria-live="polite">
                      {quote.status === 'quoted' && quote.quote
                        ? `${quote.quote.quotedDisplay} ${outputSymbol}`
                        : quote.status === 'loading'
                          ? 'Getting quote…'
                          : '—'}
                    </div>
                    <select
                      value={outputSymbol}
                      onChange={(e) => pickSymbol('out', e.target.value as SwapSymbol)}
                      aria-label="Output token"
                      style={styles.tokenSelect}
                      disabled={flow !== 'form'}
                    >
                      <option value="USDC">USDC</option>
                      <option value="EURC">EURC</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* ── Quote panel ── */}
              {quote.status === 'quoted' && quote.quote && (
                <div style={styles.quoteBox}>
                  <div style={styles.quoteRow}>
                    <span style={styles.quoteLabel}>Rate</span>
                    <span style={styles.quoteVal}>{quote.quote.rateDisplay}</span>
                  </div>
                  <div style={styles.quoteRow}>
                    <span style={styles.quoteLabel}>Minimum received</span>
                    <span style={styles.quoteVal}>
                      {quote.quote.minOutDisplay} {outputSymbol}
                    </span>
                  </div>
                  <div style={styles.quoteRow}>
                    <span style={styles.quoteLabel}>Expires in</span>
                    <span style={styles.quoteVal}>
                      {quote.refreshing ? 'Refreshing…' : formatCountdown(quote.secondsLeft)}
                    </span>
                  </div>
                  {/* Routing provenance (secondary): who executes this quote,
                      plus the informational Tower rate-discovery candidate
                      when the backend consulted it. Tower never executes. */}
                  {quote.quote.venueId && (
                    <p style={styles.routeNote}>
                      Route selected · Execution via {friendlyVenueLabel(quote.quote.venueId)}
                    </p>
                  )}
                  {quote.quote.tower?.consulted && quote.quote.tower.available && (
                    <p style={styles.routeNote}>
                      Rate comparison via {friendlyVenueLabel('tower')} — info only, execution stays
                      with {friendlyVenueLabel(quote.quote.venueId ?? 'unitflow-v3')}.
                    </p>
                  )}
                  <button style={styles.linkButton} onClick={quote.refresh} disabled={quote.refreshing}>
                    {quote.refreshing ? 'Refreshing quote…' : 'Refresh quote'}
                  </button>
                </div>
              )}
              {quote.status === 'loading' && !quote.quote && (
                <div style={styles.quoteBox}>
                  <p style={styles.boxText}>Searching for the best available rate…</p>
                </div>
              )}
              {flow === 'form' && flowError && (
                <div style={styles.noticeBox}>
                  <p style={styles.boxText}>⚠️ {flowError}</p>
                </div>
              )}
              {(quote.status === 'error' || quote.status === 'expired') && (
                <div style={styles.errorBox}>
                  <p style={styles.boxText}>{quote.headline ?? 'Could not get a quote.'}</p>
                  <button style={styles.secondaryButton} onClick={quote.refresh}>
                    Try again
                  </button>
                </div>
              )}

              {flow === 'failed' && flowError && (
                <div style={styles.errorBox}>
                  <p style={styles.boxText}>⚠️ {flowError}</p>
                  {minedExecHash && (
                    <p style={styles.hashLine}>
                      Transaction:{' '}
                      <a href={explorerTxUrl(minedExecHash)} target="_blank" rel="noopener noreferrer" style={styles.link}>
                        {shortHash(minedExecHash)} ↗
                      </a>
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {minedExecHash && lastIntentId && (
                      <button style={styles.secondaryButton} onClick={() => void retryVerify()}>
                        Verify again
                      </button>
                    )}
                    <button style={styles.secondaryButton} onClick={startOver}>
                      Start over
                    </button>
                  </div>
                  {flowRawError && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--flow-text-faint)' }}>
                        Technical details
                      </summary>
                      <p style={styles.rawText}>{flowRawError}</p>
                    </details>
                  )}
                </div>
              )}

              {sessionIsCircle ? (
                <>
                  <button style={styles.submitButton} disabled={circleConfirmDisabled} onClick={() => void handleCircleConfirm()}>
                    {circleBusy ? 'Swapping…' : 'Confirm swap'}
                  </button>
                  {circleConfirmHint && flow === 'form' && <p style={styles.hint}>{circleConfirmHint}</p>}
                </>
              ) : (
                <>
                  <button style={styles.submitButton} disabled={confirmDisabled} onClick={() => void handleConfirm()}>
                    Confirm swap
                  </button>
                  {confirmHint && <p style={styles.hint}>{confirmHint}</p>}
                </>
              )}
            </>
          )}

          {/* ── Execution / verification progress ── */}
          {(flow === 'executing' || flow === 'mined' || flow === 'verifying') && (
            <div style={styles.progressBox}>
              <p style={styles.boxTitle}>
                {flow === 'executing' && (sessionIsCircle ? 'Swapping in your FlareHQ wallet…' : isSending ? 'Check your wallet…' : 'Swapping…')}
                {flow === 'mined' && 'Transaction mined — verifying…'}
                {flow === 'verifying' && 'Swap submitted — verifying on-chain…'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                {steps.map((s) => (
                  <div key={s.key} style={styles.stepRow}>
                    <span style={s.status === 'done' ? styles.stepDone : s.status === 'active' ? styles.stepActive : styles.stepPending}>
                      {s.status === 'done' ? '✓' : s.status === 'active' ? '…' : '○'}
                    </span>
                    <span style={styles.stepLabel}>{s.label}</span>
                    {s.hash && (
                      <a href={explorerTxUrl(s.hash)} target="_blank" rel="noopener noreferrer" style={styles.link}>
                        {shortHash(s.hash)} ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
              {flow === 'verifying' && (
                <p style={styles.underText}>Your transaction is mined. The server is now confirming the swap on-chain — success is shown only after that check passes.</p>
              )}
            </div>
          )}

          {/* ── Verified success (authoritative actuals only) ── */}
          {flow === 'verified' && verified && (
            <div style={styles.successBox}>
              <p style={styles.successIcon}>✓</p>
              <p style={styles.boxTitle}>Swap completed</p>
              <p style={styles.boxText}>
                Received <strong>{formatCanonical(verified.actualOutput)} {verified.outputSymbol}</strong>
                {' '}for {formatCanonical(verified.actualInput)} {verified.inputSymbol}.
              </p>
              {verified.alreadySettled && (
                <p style={styles.underText}>This swap was already verified — showing the recorded result.</p>
              )}
              {verified.executionTxHash && (
                <p style={styles.hashLine}>
                  Swap transaction:{' '}
                  <a href={explorerTxUrl(verified.executionTxHash)} target="_blank" rel="noopener noreferrer" style={styles.link}>
                    {shortHash(verified.executionTxHash)} ↗
                  </a>
                </p>
              )}
              {verified.wrapTxHash && (
                <p style={styles.hashLine}>
                  Preparation transaction:{' '}
                  <a href={explorerTxUrl(verified.wrapTxHash)} target="_blank" rel="noopener noreferrer" style={styles.link}>
                    {shortHash(verified.wrapTxHash)} ↗
                  </a>
                </p>
              )}
              {verified.unwrapTxHash && (
                <p style={styles.hashLine}>
                  Settlement transaction:{' '}
                  <a href={explorerTxUrl(verified.unwrapTxHash)} target="_blank" rel="noopener noreferrer" style={styles.link}>
                    {shortHash(verified.unwrapTxHash)} ↗
                  </a>
                </p>
              )}
              <button style={styles.submitButton} onClick={resetAfterSuccess}>
                Swap again
              </button>
              <p style={styles.underText}>This verified result is your receipt — you'll also find it in Recent Activity on Home.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { paddingTop: 16, width: '100%', maxWidth: '100%', boxSizing: 'border-box', overflowX: 'hidden' },
  title: { fontFamily: "'Fraunces', serif", fontSize: 'clamp(22px, 4vw, 26px)', fontWeight: 500, margin: '0 0 8px' },
  sub: { color: 'var(--flow-text-faint)', fontSize: 'clamp(13px, 1.2vw, 15px)', margin: '0 0 20px', lineHeight: 1.5 },
  line: { display: 'flex', alignItems: 'center', gap: 0, marginBottom: 20 },
  dot: { width: 8, height: 8, borderRadius: '50%', background: '#5C7A5C', flexShrink: 0 },
  stroke: { flex: 1, height: 2, background: 'linear-gradient(90deg, #5C7A5C, #E8714A)', margin: '0 6px' },
  walletRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 },
  walletLabel: { color: 'var(--flow-text-faint)' },
  walletAddr: { fontFamily: 'monospace', fontWeight: 700 },
  matchOk: { color: '#3F7A57', fontWeight: 600 },
  matchWarn: { color: '#B07A2A', fontWeight: 600 },
  noticeBox: { background: 'var(--flow-surface)', border: '1px solid var(--flow-border)', borderRadius: 14, padding: '14px 16px', marginBottom: 12 },
  errorBox: { background: 'var(--flow-surface)', border: '1px solid #F0D5C9', borderRadius: 14, padding: '14px 16px', marginBottom: 12 },
  progressBox: { background: 'var(--flow-surface)', border: '1px solid var(--flow-border)', borderRadius: 14, padding: '14px 16px', marginBottom: 12 },
  successBox: { textAlign: 'center', padding: '24px 16px', background: 'var(--flow-surface)', border: '1px solid #D6E2D6', borderRadius: 18, marginBottom: 12 },
  successIcon: { fontSize: 28, margin: '0 0 10px', color: '#5C7A5C' },
  boxTitle: { margin: '0 0 6px', fontWeight: 700, fontSize: 14 },
  boxText: { margin: 0, fontSize: 13, lineHeight: 1.5 },
  balanceRow: { display: 'flex', gap: 8, alignItems: 'stretch', marginBottom: 12, flexWrap: 'wrap' },
  balanceChip: { flex: '1 1 140px', minWidth: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--flow-surface-2)', borderRadius: 12, padding: '10px 14px' },
  balanceSym: { fontSize: 11, fontWeight: 700, color: 'var(--flow-text-muted)', flexShrink: 0 },
  balanceVal: { fontSize: 14, fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  miniButton: { background: 'var(--flow-surface-2)', border: '1px solid var(--flow-border)', borderRadius: 8, fontSize: 12, fontWeight: 700, color: 'var(--flow-text)', padding: '4px 10px', cursor: 'pointer' },
  inlineError: { margin: '6px 0 0', fontSize: 12, color: '#C0563A' },
  swapBox: { background: 'var(--flow-surface)', border: '1px solid var(--flow-border)', borderRadius: 18, padding: 16, marginBottom: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: 'var(--flow-text-muted)' },
  amountRow: { display: 'flex', gap: 8, flexWrap: 'wrap', minWidth: 0 },
  amountInput: { flex: 1, minWidth: 0, padding: '12px 14px', borderRadius: 12, border: '1px solid var(--flow-border)', background: 'var(--flow-bg)', fontSize: 16, color: 'var(--flow-text)', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' },
  tokenSelect: { padding: '12px 10px', borderRadius: 12, border: '1px solid var(--flow-border)', background: 'var(--flow-surface-2)', fontSize: 14, fontWeight: 700, color: 'var(--flow-text)', cursor: 'pointer', fontFamily: 'inherit' },
  outputPreview: { flex: 1, minWidth: 0, padding: '12px 14px', borderRadius: 12, border: '1px solid var(--flow-border)', background: 'var(--flow-surface-2)', fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  underRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 },
  underText: { fontSize: 12, color: 'var(--flow-text-faint)' },
  toggleButton: { alignSelf: 'center', margin: '10px auto', width: 36, height: 36, borderRadius: '50%', border: '1px solid var(--flow-border)', background: 'var(--flow-surface-2)', fontSize: 16, cursor: 'pointer', color: 'var(--flow-text)' },
  quoteBox: { background: 'var(--flow-surface-2)', borderRadius: 14, padding: '14px 16px', marginBottom: 12 },
  quoteRow: { display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6 },
  quoteLabel: { fontSize: 12, color: 'var(--flow-text-muted)' },
  quoteVal: { fontSize: 13, fontWeight: 700, textAlign: 'right' },
  routeNote: { margin: '8px 0 0', fontSize: 11, color: 'var(--flow-text-faint)', lineHeight: 1.5 },
  linkButton: { background: 'none', border: 'none', color: '#E8714A', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, marginTop: 4 },
  link: { fontSize: 12, color: '#E8714A', fontWeight: 600, fontFamily: 'monospace', wordBreak: 'break-all' },
  hashLine: { margin: '8px 0 0', fontSize: 12, color: 'var(--flow-text-muted)', wordBreak: 'break-all' },
  rawText: { fontSize: 11, fontFamily: 'monospace', color: 'var(--flow-text-faint)', wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
  secondaryButton: { padding: '10px 0', borderRadius: 12, border: '1px solid var(--flow-text)', background: 'transparent', color: 'var(--flow-text)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', width: '100%', marginTop: 8 },
  submitButton: { marginTop: 8, padding: '14px 0', borderRadius: 14, border: 'none', background: '#1C1B19', color: '#FBF8F3', fontSize: 'clamp(14px, 1.5vw, 16px)', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', width: '100%' },
  hint: { margin: '8px 0 0', fontSize: 12, color: 'var(--flow-text-faint)', textAlign: 'center' },
  stepRow: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 },
  stepDone: { color: '#3F7A57', fontWeight: 800 },
  stepActive: { color: '#E8714A', fontWeight: 800 },
  stepPending: { color: 'var(--flow-text-faint)', fontWeight: 800 },
  stepLabel: { flex: 1, fontWeight: 600 },
};
