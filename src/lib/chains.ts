import { getNetworkConfig } from '@/lib/config/network';

export const supportedChains = {
  ethereum: {
    chainId: 11155111,
    name: 'Ethereum Sepolia',
  },

  base: {
    chainId: 84532,
    name: 'Base Sepolia',
  },

  arbitrum: {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
  },

  arc: {
    // Chain ID + name flow from the authoritative network config (testnet:
    // 5042002 verified live; mainnet: ARC_MAINNET_CHAIN_ID, fail-closed).
    chainId: getNetworkConfig().chainId,
    name: getNetworkConfig().name === 'mainnet' ? 'Arc' : 'Arc Testnet',
  },
};
