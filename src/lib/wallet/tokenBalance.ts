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
import { getTokenBySymbol } from '@/src/lib/tokens/supportedTokens';
import type { SupportedSymbol } from '@/src/lib/tokens/supportedTokens';
import { getNetworkConfig } from "@/lib/config/network";

const ERC20_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];

export interface TokenBalance {
  balance: number;
  currency: SupportedSymbol;
  address: string;
  decimals: number;
  walletAddress: string;
}

function rpcUrl(): string {
  // RPC flows from the authoritative network config (was ARC_TESTNET_RPC /
  // NEXT_PUBLIC_ARC_RPC with a hardcoded testnet fallback).
  const url = getNetworkConfig().primaryRpc;
  if (!url) throw new Error('Arc RPC not configured.');
  return url;
}

/**
 * Read a wallet's balance in the requested supported token.
 * `currency` defaults to USDC (legacy callers); unsupported symbols throw
 * (400 upstream) instead of silently returning a wrong-token balance.
 * USDC/EURC resolve through the payment currency resolver (unchanged);
 * CIRBTC resolves directly from the canonical registry (swap/balance scope
 * only — payment paths stay USDC/EURC via resolveCurrency).
 */
export async function getTokenBalance(
  walletAddress: string,
  currency?: string | null
): Promise<TokenBalance> {
  const requested = (currency ?? 'USDC').trim().toUpperCase();
  const token =
    requested === 'CIRBTC' ? getTokenBySymbol('CIRBTC') : resolveCurrency({ currency: currency ?? 'USDC' });
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
