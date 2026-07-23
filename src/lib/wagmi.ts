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
      name: 'Arc Explorer',
      url: 'https://explorer-testnet.arc.xyz',
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

export const config = createConfig({
  chains: [arcTestnet],

  connectors: [
    injected(),
    ...(walletConnectProjectId
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
});