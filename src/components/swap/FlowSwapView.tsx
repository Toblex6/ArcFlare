// src/components/swap/FlowSwapView.tsx
//
// Flow Swap — consumer-facing same-chain USDC↔EURC swap inside /consumer.
//
// Self-custody flow (the browser wallet signs everything; the server never
// signs and never sees keys):
//
//   enter amount → quote (POST /api/swap/quote) → confirm → sign each
//   server-provided step (approvals, optional wrap, swap) → wait for mining
//   → register (POST /api/swap/execute-intent) → verify on-chain
//   (POST /api/swap/verify) → verified success.
//
// Success is shown ONLY after server verification. The verified
// actualOutput is authoritative — the pre-execution quote is never presented
// as the received amount.
//
// Safety properties (verified in code, see the integration checklist):
// - No client-controlled payer or recipient: the server derives both from
//   the authenticated session; the UI sends no addresses and renders no
//   address inputs.
// - No private keys, no server-side signing, no Tower execution, no
//   cross-chain path, no tokens beyond USDC/EURC.
// - No pool/router/fee-tier/calldata/provider internals are displayed.

'use client';

import React, { useMemo, useState } from 'react';
import {
  useAccount,
  useChainId,
  useConnect,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
} from 'wagmi';
import type { Address } from 'viem';
import { getNetworkConfig, explorerTxUrl } from '@/lib/config/network';
import { ensureArcNetwork } from '@/lib/wallet/ensureArcNetwork';
import { friendlyWalletError } from '@/lib/wallet/walletErrors';
import {
  dedupeConnectors,
  friendlyConnectorLabel,
  withTimeout,
} from '@/lib/wallet/walletLabels';
import { useSwapBalances } from './useSwapBalances';
import { useSwapQuote, type SwapQuoteView } from './useSwapQuote';
import {
  formatCanonical,
  formatCountdown,
  friendlySwapError,
  friendlySwapWalletError,
  parseAmountToBaseUnits,
  shortAddress,
  shortHash,
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
  onSwitchWallet,
}: {
  walletAddress: string;
  walletType: string | null;
  onSwitchWallet?: () => void;
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
  const [lastIntentId, setLastIntentId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // ── Wallet plumbing (existing wagmi infrastructure, no second system) ──
  const { address: connectedAddress, isConnected, connector: activeConnector } = useAccount();
  const { connectors, connectAsync, isPending: isConnecting } = useConnect();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const { sendTransactionAsync, isPending: isSending } = useSendTransaction();

  const sessionLive = walletAddress.trim() !== '';
  const walletsMatch =
    isConnected && !!connectedAddress && connectedAddress.toLowerCase() === walletAddress.trim().toLowerCase();
  // Flow Swap is self-custody: the browser wallet must control the session
  // wallet. FlareHQ-managed (Circle) session wallets cannot sign here.
  const sessionIsSelfCustody = (walletType ?? '').toUpperCase() === 'EXTERNAL';
  const wrongNetwork = isConnected && chainId !== ARC_CHAIN_ID;

  const balances = useSwapBalances(sessionLive);
  const quoteActive = sessionLive && flow === 'form';
  const quote = useSwapQuote(inputSymbol, outputSymbol, amount, quoteActive);

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
    if (b !== null) setAmount(b);
  };

  const resetAfterSuccess = () => {
    setAmount('');
    setFlow('form');
    setSteps([]);
    setFlowError(null);
    setFlowRawError(null);
    setVerified(null);
    setMinedExecHash(null);
    setMinedWrapHash(null);
    setLastIntentId(null);
    balances.refresh();
  };

  const startOver = () => {
    setFlow('form');
    setSteps([]);
    setFlowError(null);
    setFlowRawError(null);
    quote.refresh();
  };

  // ── Execution: sign each server-provided step, wait for mining ──
  const handleConfirm = async () => {
    const live = quote.quote;
    if (!live || quote.status !== 'quoted' || quote.secondsLeft <= 0) {
      const { headline, raw } = friendlySwapError('Swap quote expired before execution.');
      setFlowError(headline);
      setFlowRawError(raw);
      setFlow('failed');
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
    setLastIntentId(live.intentId);
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

    const markStep = (key: string, patch: Partial<ExecStepState>) =>
      setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

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

      const sendAndMine = async (to: string, data: `0x${string}`, value: string): Promise<string> => {
        const hash = await sendTransactionAsync({
          to: to as Address,
          data,
          value: BigInt(value),
          chainId: ARC_CHAIN_ID,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        return hash;
      };

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
      const raw = err instanceof Error ? err.message : String(err ?? '');
      const lower = raw.toLowerCase();
      const headline = lower.includes("couldn't switch") ||
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
    // Authoritative actuals come from verification — never from the quote.
    setVerified({
      actualInput: String(verifyData.actualInput ?? live.input.amount),
      actualOutput: String(verifyData.actualOutput ?? '0'),
      inputSymbol: live.input.symbol,
      outputSymbol: live.output.symbol,
      executionTxHash: verifyData.executionTxHash ?? execHash,
      wrapTxHash: verifyData.wrapTxHash ?? wrapHash,
      alreadySettled: !!verifyData.alreadySettled,
    });
    setFlow('verified');
    balances.refresh();
  };

  // Manual "verify again" — resubmits evidence for the same mined
  // transaction. Never rebroadcasts a money-moving transaction.
  const retryVerify = async () => {
    if (!lastIntentId || !minedExecHash) return;
    const live = quote.quote;
    setFlowError(null);
    setFlowRawError(null);
    setFlow('verifying');
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
        alreadySettled: !!verifyData.alreadySettled,
      });
      setFlow('verified');
      balances.refresh();
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err ?? '');
      const { headline, raw: mappedRaw } = friendlySwapError(raw);
      setFlowError(headline);
      setFlowRawError(mappedRaw);
      setFlow('failed');
    }
  };

  const connectWith = async (connectorUid: string) => {
    setConnectError(null);
    try {
      const target = connectors.find((c) => c.uid === connectorUid);
      if (!target) throw new Error('Wallet connector unavailable.');
      await withTimeout(connectAsync({ connector: target }), 45000, 'Wallet connection timed out');
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
      <p style={styles.sub}>Swap USDC and EURC directly on Arc. You stay in control — every step is signed in your wallet.</p>
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
      {sessionLive && !sessionIsSelfCustody && (
        <div style={styles.noticeBox}>
          <p style={styles.boxTitle}>A wallet you control is needed</p>
          <p style={styles.boxText}>
            You signed in with a FlareHQ-managed wallet ({shortAddress(walletAddress)}), which cannot sign
            swaps in this browser. Flow Swap is self-custody: reconnect with a wallet you control to swap.
          </p>
          {onSwitchWallet && (
            <button style={styles.secondaryButton} onClick={onSwitchWallet}>
              Switch to a wallet you control
            </button>
          )}
        </div>
      )}

      {sessionLive && sessionIsSelfCustody && (
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                {dedupeConnectors(connectors).map((c) => (
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

          {/* ── Balances (both tokens, parallel) ── */}
          <div style={styles.balanceRow}>
            {(['USDC', 'EURC'] as SwapSymbol[]).map((s) => (
              <div key={s} style={styles.balanceChip}>
                <span style={styles.balanceSym}>{s}</span>
                <span style={styles.balanceVal}>
                  {balances.loading ? '…' : balances.balances[s] !== null ? balances.balances[s] : '—'}
                </span>
              </div>
            ))}
            <button style={styles.miniButton} onClick={balances.refresh} disabled={balances.loading || flow !== 'form'}>
              {balances.loading ? '…' : '↻'}
            </button>
          </div>
          {balances.error && <p style={styles.inlineError}>{balances.error}</p>}

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
                  <button style={styles.linkButton} onClick={quote.refresh} disabled={quote.refreshing}>
                    {quote.refreshing ? 'Refreshing quote…' : 'Refresh quote'}
                  </button>
                </div>
              )}
              {quote.status === 'loading' && !quote.quote && (
                <div style={styles.quoteBox}>
                  <p style={styles.boxText}>Getting your quote…</p>
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

              <button style={styles.submitButton} disabled={confirmDisabled} onClick={() => void handleConfirm()}>
                Confirm swap
              </button>
              {confirmHint && <p style={styles.hint}>{confirmHint}</p>}
            </>
          )}

          {/* ── Execution / verification progress ── */}
          {(flow === 'executing' || flow === 'mined' || flow === 'verifying') && (
            <div style={styles.progressBox}>
              <p style={styles.boxTitle}>
                {flow === 'executing' && (isSending ? 'Check your wallet…' : 'Swapping…')}
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
              <button style={styles.submitButton} onClick={resetAfterSuccess}>
                Swap again
              </button>
              <p style={styles.underText}>Recent Activity on Home does not list swaps yet — this verified result is your receipt.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { paddingTop: 16 },
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
  balanceRow: { display: 'flex', gap: 8, alignItems: 'stretch', marginBottom: 12 },
  balanceChip: { flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--flow-surface-2)', borderRadius: 12, padding: '10px 14px' },
  balanceSym: { fontSize: 11, fontWeight: 700, color: 'var(--flow-text-muted)' },
  balanceVal: { fontSize: 14, fontWeight: 700 },
  miniButton: { background: 'var(--flow-surface-2)', border: '1px solid var(--flow-border)', borderRadius: 8, fontSize: 12, fontWeight: 700, color: 'var(--flow-text)', padding: '4px 10px', cursor: 'pointer' },
  inlineError: { margin: '6px 0 0', fontSize: 12, color: '#C0563A' },
  swapBox: { background: 'var(--flow-surface)', border: '1px solid var(--flow-border)', borderRadius: 18, padding: 16, marginBottom: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: 'var(--flow-text-muted)' },
  amountRow: { display: 'flex', gap: 8 },
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
