// src/lib/wallet/walletLabels.ts
//
// Friendly wallet connector labels — single mapping used by CheckoutWidget,
// WalletConnectPanel, escrow-pay, and consumer onboarding.
//
// Never show wagmi internals (injected / viem / connector type) to users.
// (The old FRIENDLY_BY_TYPE allowlist is gone — see friendlyConnectorLabel.)

// Wallet names that are generic/internal placeholders rather than a real
// wallet's announced name — these get the neutral "Browser Wallet" label.
// Everything else an EIP-6963 provider announces (MetaMask, Rabby, OKX,
// Zerion, Bitget, Ledger, Taho, Enkrypt, Coinbase Wallet, …) is shown AS-IS:
// a real announced name is authoritative. We do NOT keep a known-wallet
// allowlist — that collapsed legitimate wallets into "Browser Wallet" — and
// we never invent names.
const GENERIC_WALLET_NAMES = new Set(['injected', 'browser wallet', 'wallet']);

export function friendlyConnectorLabel(connector: { type?: string; name?: string; id?: string }): string {
  const rawName = (connector.name || connector.id || '').trim();
  const lower = rawName.toLowerCase();

  // WalletConnect is explicit — always that label
  if (connector.type === 'walletConnect' || lower.includes('walletconnect')) return 'WalletConnect';

  // No announced name (or a generic/internal placeholder like "Injected") —
  // show the neutral fallback instead of wagmi internals.
  if (!rawName || GENERIC_WALLET_NAMES.has(lower) || (connector.type && lower === connector.type.toLowerCase())) {
    return 'Browser Wallet';
  }

  // Real announced wallet name — trust it as-is.
  return rawName;
}

/**
 * Stable dedup by connector identity — never by display name alone.
 * Two distinct wallets can legitimately share the same display name
 * (e.g. two "MetaMask" entries via different EIP-6963 providers).
 * We dedupe only on the stable connector identity (uid > id+type).
 */
export function dedupeConnectors<T>(connectors: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of connectors) {
    const anyC = c as { uid?: string; id?: string; type?: string; name?: string };
    // uid is the stable per-connector identity wagmi assigns
    const key = anyC?.uid
      ? `uid:${anyC.uid}`
      : `id:${anyC?.id ?? ''}|type:${anyC?.type ?? ''}|name:${anyC?.name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Mobile detection helpers shared across panels
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
  // narrow viewport as secondary signal (tablet/mobile)
  return window.innerWidth < 768;
}

export function hasInjectedProvider(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as any).ethereum;
}

// For timeouts: wrap a promise with a deadline that maps to a wallet error
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage = 'Wallet connection timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
