// src/lib/wallet/usdcBalance.ts
// On-chain USDC balance lookup against a wallet address on Arc Testnet —
// the exact logic the consumer dashboard's /api/consumer/balance route
// uses, extracted so the Telegram bot (/balance) reuses it instead of
// duplicating it.

import { ethers } from 'ethers';

const ERC20_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];

export async function getUsdcBalance(walletAddress: string): Promise<number> {
  const usdcAddress = process.env.ARC_USDC_ADDRESS;
  if (!usdcAddress || !process.env.ARC_TESTNET_RPC) {
    throw new Error('Arc RPC/USDC address not configured.');
  }
  const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC);
  const usdc = new ethers.Contract(usdcAddress, ERC20_BALANCE_ABI, provider);
  const raw = await usdc.balanceOf(walletAddress);
  return Number(ethers.formatUnits(raw, 6)); // USDC = 6 decimals
}