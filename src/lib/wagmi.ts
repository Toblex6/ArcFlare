import { createConfig, http } from 'wagmi';

import { injected, walletConnect } from 'wagmi/connectors';

import { defineChain } from 'viem';
// Testnet source chains for the EXTERNAL Bridge flow (balance reads + wallet
// switching). Imported from viem's own chain registry — the SUPPORTED SET
// (which of these the Bridge UI offers) lives in the canonical
// src/lib/bridge/sourceChains.ts, never in this connector list.
import { arbitrumSepolia, baseSepolia, optimismSepolia, sepolia, polygonAmoy } from 'viem/chains';

import { getArcChain, getNetworkConfig } from '@/lib/config/network';
import { arcMainnet } from '@/lib/wallet/arcChains';

// Chain definition now flows from the authoritative network config (testnet:
// chainId 5042002 verified live; mainnet: ARC_MAINNET_* inputs, fail-closed).
// The exported name is kept so existing importers (ensureArcNetwork,
// routing/canonical) keep working unchanged.
//
// PRODUCTION NOTE: this object is evaluated at BUNDLE BUILD time from
// NEXT_PUBLIC_ARC_NETWORK, which the browser cannot see from the server's
// ARC_NETWORK. Wallet-switching call sites must therefore NOT rely on this
// object alone — they select their target via useActiveArcChain()
// (server-resolved chain id, production-safe mainnet default). The static
// arcMainnet below guarantees chain 5042 is always registered even when the
// bundle was built without the public network variable.
const arcChainDef = getArcChain();

export const arcTestnet = defineChain({
  id: arcChainDef.id,
  name: arcChainDef.name,
  nativeCurrency: {
    decimals: 18,
    name: 'ARC',
    symbol: 'ARC',
  },
  rpcUrls: {
    default: {
      http: [getNetworkConfig().primaryRpc],
    },
  },
  blockExplorers: {
    default: {
      name: 'ArcScan',
      url: getNetworkConfig().explorerBaseUrl,
    },
  },
  testnet: arcChainDef.testnet,
});

// Injected wallets (MetaMask/Rabby/etc.) — wagmi's injected() supports
// EIP-6963 discovery automatically: each announced wallet shows up as its
// own connector entry with correct name/icon, rather than forcing a single
// "Injected" button that always picks MetaMask. No manual window.ethereum
// shim needed; wagmi handles deduplication.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// Explicit configuration failure — never let a missing project ID silently
// look like a working mobile WalletConnect feature. Without it, NO walletConnect
// connector is registered at all, so mobile users get no QR / deep-link path
// and desktop is extension-only. We say so loudly, in both dev and production,
// without exposing anything beyond the public project-ID variable name. The
// WalletConnect Cloud origin allow-list itself cannot be verified from code —
// it must be configured in the WalletConnect Cloud dashboard for whichever
// origins this deployment serves (window.location.origin at runtime).
if (typeof window !== 'undefined' && !walletConnectProjectId) {
  console.warn(
    '[FlareHQ] Configuration error: NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set — ' +
      'mobile WalletConnect is DISABLED (no QR/deep-link connector is registered; only ' +
      'desktop browser-extension wallets can connect). Create a project in WalletConnect ' +
      'Cloud and set the variable, allow-listing this deployment origin (' +
      (typeof window !== 'undefined' ? window.location.origin : 'the production origin') +
      '), to enable mobile payments.'
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
  // Arc is first (default chain for Swap/checkout/Send). arcTestnet is the
  // env-resolved chain (testnet 5042002 unless the bundle was built with
  // NEXT_PUBLIC_ARC_NETWORK=mainnet); arcMainnet is the STATIC mainnet
  // definition (5042) so production browsers always carry the mainnet chain
  // even when the bundle was built without the public network variable.
  // Deduped by id: a mainnet-built bundle keeps the env-resolved entry.
  // The Sepolia/Amoy entries exist so EXTERNAL Bridge wallets can switch to
  // a supported source chain and read USDC balances there — they do NOT make
  // those chains payment chains. The Bridge UI only offers the canonical
  // supported set from src/lib/bridge/sourceChains.ts.
  chains: (() => {
    const all = [arcTestnet, arcMainnet, arbitrumSepolia, baseSepolia, optimismSepolia, sepolia, polygonAmoy] as const;
    return all.filter((c, i) => all.findIndex((x) => x.id === c.id) === i) as unknown as [typeof arcTestnet, ...typeof arcTestnet[]];
  })(),

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
            icons: ['https://flarehq.xyz/arcflare-logo.png'],
          },
          showQrModal: true,
        }),
      ]
      : []),
  ],

  transports: {
    [arcTestnet.id]: http(),
    [arcMainnet.id]: http(),
    [arbitrumSepolia.id]: http(),
    [baseSepolia.id]: http(),
    [optimismSepolia.id]: http(),
    [sepolia.id]: http(),
    [polygonAmoy.id]: http(),
  },

  // Tells wagmi itself to be careful about browser-only APIs (localStorage
  // etc) during the SSR pass, separate from the indexedDB issue above but
  // the same category of problem — belt and suspenders.
  ssr: true,
});