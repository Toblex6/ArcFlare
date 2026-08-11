import { createConfig, http } from 'wagmi';

import { injected, walletConnect } from 'wagmi/connectors';

import { defineChain } from 'viem';

export const arcTestnet = defineChain({
  id: 78600,

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

// injected() only works if the browser itself has a wallet extension
// (MetaMask, Rabby, etc). On mobile Chrome/Safari with no extension, it's a
// dead button — nothing happens when tapped. walletConnect() is what makes
// this actually work on mobile: it shows a QR code (desktop) or deep-links
// straight into whatever wallet app is installed (Trust Wallet, MetaMask
// mobile, Rainbow, etc), which then signs the transaction and hands
// control back to the browser. Without this, mobile users without a
// desktop-style extension simply cannot pay at all.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

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
    injected(),
    ...(isBrowser && walletConnectProjectId
      ? [
        walletConnect({
          projectId: walletConnectProjectId,
          metadata: {
            name: 'FlareHQ',
            description: 'Stablecoin payment infrastructure on Arc',
            url: 'https://flarehq.xyz',
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