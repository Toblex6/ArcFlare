import { createConfig, http } from 'wagmi';

import { injected, walletConnect } from 'wagmi/connectors';

import { defineChain } from 'viem';

export const arcTestnet = defineChain({
  id: 5042002, // verified live: rpc.testnet.arc.network eth_chainId = 0x4cef52

  name: 'Arc Testnet',

  nativeCurrency: {
    decimals: 18,
    name: 'ARC',
    symbol: 'ARC',
  },

  rpcUrls: {
    default: {
      http: ['https://rpc.testnet.arc.network'],
    },
  },

  blockExplorers: {
    default: {
      name: 'ArcScan',
      url: 'https://testnet.arcscan.app',
    },
  },

  testnet: true,
});

// Injected wallets (MetaMask/Rabby/etc.) — wagmi's injected() supports
// EIP-6963 discovery automatically: each announced wallet shows up as its
// own connector entry with correct name/icon, rather than forcing a single
// "Injected" button that always picks MetaMask. No manual window.ethereum
// shim needed; wagmi handles deduplication.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// Diagnose WC misconfiguration loudly in dev so mobile deep-links don't stay
// silently disabled (production hostnames rely on WalletConnect Cloud allowlist).
if (typeof window !== 'undefined' && !walletConnectProjectId) {
  console.warn(
    '[FlareHQ] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set — WalletConnect will be unavailable. ' +
      'Add it in WalletConnect Cloud (allow https://flarehq.xyz + preview hosts) or payments will be desktop-extension-only.'
  );
}

// CRITICAL: @walletconnect/ethereum-provider touches indexedDB the moment
// it's constructed. Next.js runs this module on the SERVER too (to render
// the initial page, even though providers.tsx is a client component) —
// there is no indexedDB in Node, so building it unconditionally crashes
// SSR/production builds with "ReferenceError: indexedDB is not defined".
// Only ever construct it when actually running in a browser. The client
// bundle re-runs this module in the real browser after hydration and
// picks it up correctly there — nothing is lost for real users.
const isBrowser = typeof window !== 'undefined';

export const config = createConfig({
  chains: [arcTestnet],

  connectors: [
    // EIP-6963 multi-wallet discovery enabled by default in wagmi 3.x's
    // injected(). Each detected wallet (MetaMask, Rabby, etc.) surfaces as
    // a distinct connector with proper name — no single MetaMask lock-in.
    injected(),
    ...(isBrowser && walletConnectProjectId
      ? [
        walletConnect({
          projectId: walletConnectProjectId,
          // showQrModal: true gives desktop QR + mobile deep-link chooser
          // (MetaMask / Rainbow / Trust etc.) when showQrModal's modal opens.
          // On mobile WC handles universal/deep links; if the project is
          // allow-listed for flarehq.xyz the "Open" button is enabled.
          metadata: {
            name: 'FlareHQ',
            description: 'Stablecoin payment infrastructure on Arc',
            // Must match one of the allowed origins registered in
            // WalletConnect Cloud for this projectId (production host +
            // preview hosts). Mismatch disables deep-link "Open" on mobile.
            url: typeof window !== 'undefined' ? window.location.origin : 'https://flarehq.xyz',
            icons: ['https://flarehq.xyz/flarehq-logo.png'],
          },
          showQrModal: true,
        }),
      ]
      : []),
  ],

  transports: {
    [arcTestnet.id]: http(),
  },

  // Tells wagmi itself to be careful about browser-only APIs (localStorage
  // etc) during the SSR pass, separate from the indexedDB issue above but
  // the same category of problem — belt and suspenders.
  ssr: true,
});