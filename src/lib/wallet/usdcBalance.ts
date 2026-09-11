// src/lib/wallet/usdcBalance.ts
// On-chain USDC balance lookup against a wallet address on Arc Testnet —
// the exact logic the consumer dashboard's /api/consumer/balance route
// uses, extracted so the Telegram bot (/balance) reuses it instead of
// duplicating it.

import { ethers } from 'ethers';
import { getNetworkConfig } from "@/lib/config/network";

const ERC20_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];

export async function getUsdcBalance(walletAddress: string): Promise<number> {
  // Token address flows from the authoritative network config (legacy
  // ARC_USDC_ADDRESS still wins when set); testnet value unchanged.
  const usdcAddress = process.env.ARC_USDC_ADDRESS || getNetworkConfig().usdcAddress;
  if (!usdcAddress || !getNetworkConfig().primaryRpc) {
    throw new Error('Arc RPC/USDC address not configured.');
  }
  const provider = new ethers.JsonRpcProvider(getNetworkConfig().primaryRpc);
  const usdc = new ethers.Contract(usdcAddress, ERC20_BALANCE_ABI, provider);
  const raw = await usdc.balanceOf(walletAddress);
  return Number(ethers.formatUnits(raw, 6)); // USDC = 6 decimals
}