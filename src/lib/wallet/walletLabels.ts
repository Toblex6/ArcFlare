// src/lib/wallet/walletLabels.ts
//
// Friendly wallet connector labels — single mapping used by CheckoutWidget,
// WalletConnectPanel, escrow-pay, and consumer onboarding.
//
// Never show wagmi internals (injected / viem / connector type) to users.

const FRIENDLY_BY_TYPE: Record<string, string> = {
  injected: 'Browser Wallet',
  walletConnect: 'WalletConnect',
  coinbaseWallet: 'Coinbase Wallet',
};

const KNOWN_WALLET_NAMES = ['MetaMask', 'Rabby', 'Coinbase Wallet', 'Brave Wallet', 'Trust Wallet', 'Phantom', 'Rainbow', 'Safe'];

export function friendlyConnectorLabel(connector: { type?: string; name?: string; id?: string }): string {
  const rawName = (connector.name || connector.id || '').trim();
  const lower = rawName.toLowerCase();

  // WalletConnect is explicit — always that label
  if (connector.type === 'walletConnect' || lower.includes('walletconnect')) return 'WalletConnect';

  // If EIP-6963 / connector already advertises a known wallet name, use it
  for (const known of KNOWN_WALLET_NAMES) {
    if (lower.includes(known.toLowerCase())) return known;
  }

  // Injected generic: don't show "Injected"
  if (connector.type === 'injected' || lower === 'injected' || !rawName) {
    return 'Browser Wallet';
  }

  // Fallback to mapped type or the raw name as-is (already nicer than "injected")
  if (connector.type && FRIENDLY_BY_TYPE[connector.type]) return FRIENDLY_BY_TYPE[connector.type];
  return rawName || 'Browser Wallet';
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
