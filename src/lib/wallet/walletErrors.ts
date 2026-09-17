// src/lib/wallet/walletErrors.ts
//
// Shared wallet error mapping — the single source for user-facing wallet
// copy. No component may render `err.message` / `err.shortMessage` / viem
// internals directly.
//
// Keeps raw error in console/Sentry for debugging.

export type WalletErrorKind =
  | 'USER_REJECTED'
  | 'WALLET_NOT_RESPONDING'
  | 'WALLET_NOT_FOUND'
  | 'WC_TIMEOUT'
  | 'UNSUPPORTED_NETWORK'
  | 'INSUFFICIENT_FUNDS'
  | 'GENERIC';

const VIEM_VERSION_RE = /Version:\s*viem@[^\s]+/gi;
const WAGMI_VERSION_RE = /Version:\s*@wagmi\/[^\s]+/gi;

function stripVersions(msg: string): string {
  return msg.replace(VIEM_VERSION_RE, '').replace(WAGMI_VERSION_RE, '').trim();
}

export function mapWalletError(err: unknown): { kind: WalletErrorKind; message: string } {
  const raw = String((err as any)?.shortMessage ?? (err as any)?.message ?? err ?? '');
  const lower = raw.toLowerCase();
  // Always log raw for operator debugging, without leaking to user
  if (raw) console.error('[wallet-error]', stripVersions(raw), err);

  // 1. User explicitly cancelled in wallet UI
  if (
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('rejected the request') ||
    lower.includes('request rejected') ||
    lower.includes('user cancelled') ||
    lower.includes('action rejected')
  ) {
    return { kind: 'USER_REJECTED', message: 'Connection cancelled. No changes were made.' };
  }

  // 2. Provider / wallet not found in this browser
  if (
    lower.includes('provider not found') ||
    lower.includes('no provider') ||
    lower.includes('no injected') ||
    lower.includes('connector not found') ||
    lower.includes("no wallet") ||
    lower.includes('no ethereum provider')
  ) {
    return {
      kind: 'WALLET_NOT_FOUND',
      message: "We couldn't find a wallet in this browser. Install a wallet extension or use WalletConnect.",
    };
  }

  // 3. WalletConnect / timeout / connection reset
  if (
    lower.includes('connection request reset') ||
    lower.includes('connection request failed') ||
    lower.includes('connection timeout') ||
    lower.includes('request timeout') ||
    lower.includes('timeout') && lower.includes('walletconnect') ||
    lower.includes('wc:') && lower.includes('timeout') ||
    lower.includes('qr code') ||
    lower.includes('session disconnected')
  ) {
    return {
      kind: 'WC_TIMEOUT',
      message: "We couldn't open your wallet app. Try again, or copy this link and open it in your wallet app.",
    };
  }

  // 4. Wallet didn't respond (hung popup, mobile deep-link not returned)
  if (
    lower.includes('timed out waiting for your wallet') ||
    lower.includes('did not respond') ||
    lower.includes("didn't respond")
  ) {
    return {
      kind: 'WALLET_NOT_RESPONDING',
      message: "Your wallet didn't respond. Open your wallet app and try again.",
    };
  }

  // 5. Network / chain not configured — let callers handle with richer fallback;
  // we still map here so generic catch doesn't leak
  if (
    lower.includes('unrecognized chain') ||
    lower.includes('unknown chain') ||
    lower.includes('addethereumnchain') ||
    lower.includes('wallet_addethereumchain') ||
    lower.includes('unsupported chain') ||
    lower.includes('unsupported network')
  ) {
    return {
      kind: 'UNSUPPORTED_NETWORK',
      message: 'This payment uses Arc Testnet. We\'ll try to switch your wallet automatically.',
    };
  }

  // 5b. Wallet on the wrong chain (viem chain-mismatch, e.g. "The current
  // chain of the wallet (id: 42161) does not match the target chain for the
  // transaction"). Every transaction-building surface must switch to Arc
  // Testnet BEFORE sending; this mapping is the safety net for a chain
  // change between the switch and the send. The raw chain-id text is never
  // surfaced — the user gets the same switch prompt as the proactive path.
  if (
    lower.includes('does not match the target chain') ||
    lower.includes('current chain of the wallet') ||
    lower.includes('target chain for the transaction') ||
    lower.includes('chain mismatch') ||
    lower.includes('chain id mismatch')
  ) {
    return {
      kind: 'UNSUPPORTED_NETWORK',
      message: 'Please switch your wallet to Arc Testnet to continue.',
    };
  }

  // 6. Not enough funds / gas allowance to complete the send. Note: a funds
  // failure can also surface AFTER a broadcast (the chain reverted the tx),
  // so we must NOT claim "no changes were made" here.
  if (
    lower.includes('outoffunds') ||
    lower.includes('out of funds') ||
    lower.includes('gas required exceeds allowance')
  ) {
    return {
      kind: 'INSUFFICIENT_FUNDS',
      message:
        "This payment can't be completed with the funds currently in this wallet. Top up (or check the token allowance) and try again.",
    };
  }

  // 7. Fallback — never expose raw package internals
  return {
    kind: 'GENERIC',
    message: "We couldn't connect your wallet. Please try again.",
  };
}

export function friendlyWalletError(err: unknown): string {
  return mapWalletError(err).message;
}

export function isUserRejection(err: unknown): boolean {
  return mapWalletError(err).kind === 'USER_REJECTED';
}
