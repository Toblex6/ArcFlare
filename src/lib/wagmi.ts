import {
  createConfig,
  http,
} from "wagmi";

import {
  injected,
} from "wagmi/connectors";

import {
  defineChain,
} from "viem";

export const arcTestnet =
  defineChain({

    id: 78600,

    name: "Arc Testnet",

    nativeCurrency: {
      decimals: 18,
      name: "ARC",
      symbol: "ARC",
    },

    rpcUrls: {
      default: {
        http: [
          "https://rpc-testnet.arc.xyz"
        ],
      },
    },

    blockExplorers: {
      default: {
        name: "Arc Explorer",
        url: "https://explorer-testnet.arc.xyz",
      },
    },

    testnet: true,
  });

export const config =
  createConfig({

    chains: [
      arcTestnet,
    ],

    connectors: [
      injected(),
    ],

    transports: {

      [arcTestnet.id]:
        http(),
    },
  });