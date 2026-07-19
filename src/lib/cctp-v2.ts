// src/lib/cctp-v2.ts
import { CctpClient, SupportedChain } from "@cctp-sdk/core";
import { createWalletClient, http, parseUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  mainnet,
  sepolia,
  base,
  baseSepolia,
  arbitrum,
  arbitrumSepolia,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
} from "viem/chains";

// ── Supported source chains (where you can send USDC from) ──
export const CCTP_SOURCE_CHAINS = [
  { id: "arbitrumSepolia",  label: "Arbitrum Sepolia",  chain: arbitrumSepolia, testnet: true },
  { id: "baseSepolia",      label: "Base Sepolia",      chain: baseSepolia,     testnet: true },
  { id: "optimismSepolia",  label: "Optimism Sepolia",  chain: optimismSepolia, testnet: true },
  { id: "sepolia",          label: "Ethereum Sepolia",  chain: sepolia,          testnet: true },
  { id: "polygonAmoy",      label: "Polygon Amoy",      chain: polygonAmoy,     testnet: true },
  // Mainnets (optional)
  { id: "arbitrum", label: "Arbitrum", chain: arbitrum, testnet: false },
  { id: "base",     label: "Base",     chain: base,     testnet: false },
  { id: "optimism", label: "Optimism", chain: optimism, testnet: false },
  { id: "ethereum", label: "Ethereum", chain: mainnet,  testnet: false },
  { id: "polygon",  label: "Polygon",  chain: polygon,  testnet: false },
] as const;

// ── Destination chains (Arc is the only one we care about) ──
export const CCTP_DEST_CHAINS = [
  { id: "arc", label: "Arc Testnet", domain: 26, testnet: true },
] as const;

// ── CCTP domain IDs ──
export const CCTP_DOMAINS: Record<string, number> = {
  ethereum: 0,
  arbitrum: 3,
  base: 6,
  optimism: 2,
  polygon: 7,
  sepolia: 0,
  arbitrumSepolia: 3,
  baseSepolia: 6,
  optimismSepolia: 2,
  polygonAmoy: 7,
  arc: 26,   // Arc Testnet domain
};

// ── Get viem chain object by ID ──
export function getChainById(id: string) {
  const found = CCTP_SOURCE_CHAINS.find((c) => c.id === id);
  return found?.chain;
}

// ── Transfer function ──
export async function transferCctpV2(params: {
  fromChain: string;
  toChain: string;        // should be "arc" for our use case
  amount: string;
  recipient: string;      // address on Arc
  privateKey: `0x${string}`;
}) {
  const { fromChain, toChain, amount, recipient, privateKey } = params;

  const from = CCTP_SOURCE_CHAINS.find((c) => c.id === fromChain);
  const to   = CCTP_DEST_CHAINS.find((c) => c.id === toChain);
  if (!from || !to) throw new Error("Unsupported chain");

  const fromChainObj = from.chain;

  // 1. Create wallet client
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain: fromChainObj,
    transport: http(),
  });

  // 2. Create CCTP client
  const env = from.testnet ? "testnet" : "mainnet";
  const client = new CctpClient({ env });

  console.log(`[CCTP] Transferring ${amount} USDC from ${fromChain} to ${toChain}`);
  console.log(`[CCTP] Recipient: ${recipient}`);

  // 3. Execute transfer (fast transfer enabled)
  const transfer = await client.transfer(
    {
      from: fromChain as SupportedChain,
      to: toChain as SupportedChain,   // "arc" is recognised by the SDK
      amount: parseUnits(amount, 6),
      fast: true,
      recipient: getAddress(recipient) as `0x${string}`,
    },
    wallet
  );

  // 4. Wait for completion
  const result = await transfer.wait();

  return {
    sourceTxHash: result.sourceTxHash,
    destinationTxHash: result.destinationTxHash,
  };
}