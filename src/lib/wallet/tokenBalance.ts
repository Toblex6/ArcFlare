// src/lib/wallet/tokenBalance.ts
//
// Generic supported-token balance lookup on Arc Testnet (multicurrency Phase 2B).
//
// Server-only (ethers + env RPC). The token contract + decimals always come
// from the canonical registry via `resolveCurrency` — never from the caller,
// never hardcoded here. `getUsdcBalance` in usdcBalance.ts is untouched;
// this module is the multicurrency-safe path for balance display needed to
// select the correct token (checkout, consumer send/request).

import { ethers } from 'ethers';
import { resolveCurrency } from '@/src/lib/tokens/resolveCurrency';

const ERC20_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];

export interface TokenBalance {
  balance: number;
  currency: 'USDC' | 'EURC';
  address: string;
  decimals: number;
  walletAddress: string;
}

function rpcUrl(): string {
  const url =
    process.env.ARC_TESTNET_RPC ||
    process.env.NEXT_PUBLIC_ARC_RPC ||
    'https://rpc.testnet.arc.network';
  if (!url) throw new Error('Arc RPC not configured.');
  return url;
}

/**
 * Read a wallet's balance in the requested supported token.
 * `currency` defaults to USDC (legacy callers); unsupported symbols throw
 * (400 upstream) instead of silently returning a wrong-token balance.
 */
export async function getTokenBalance(
  walletAddress: string,
  currency?: string | null
): Promise<TokenBalance> {
  const token = resolveCurrency({ currency: currency ?? 'USDC' });
  const provider = new ethers.JsonRpcProvider(rpcUrl());
  const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, provider);
  const raw = await contract.balanceOf(walletAddress);
  return {
    balance: Number(ethers.formatUnits(raw, token.decimals)),
    currency: token.symbol,
    address: token.address,
    decimals: token.decimals,
    walletAddress,
  };
}
