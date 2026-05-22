"use client";

import "@rainbow-me/rainbowkit/styles.css";

import {
  getDefaultConfig,
  RainbowKitProvider,
} from "@rainbow-me/rainbowkit";

import {
  WagmiProvider,
} from "wagmi";

import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";

import {
  http,
} from "viem";

import {
  defineChain,
} from "viem";

const arcTestnet = defineChain({
  id: 11155111,

  name: "Arc Testnet",

  nativeCurrency: {
    decimals: 18,
    name: "ETH",
    symbol: "ETH",
  },

  rpcUrls: {
    default: {
      http: [
        "https://rpc.ankr.com/eth_sepolia",
      ],
    },
  },

  testnet: true,
});

const config = getDefaultConfig({
  appName: "ArcFlare",

  projectId: "arcflare",

  chains: [arcTestnet],

  transports: {
    [arcTestnet.id]: http(),
  },
});

const queryClient =
  new QueryClient();

export default function Providers({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <WagmiProvider config={config}>

      <QueryClientProvider
        client={queryClient}
      >

        <RainbowKitProvider>

          {children}

        </RainbowKitProvider>

      </QueryClientProvider>

    </WagmiProvider>
  );
}