// src/lib/wallet/ensureArcNetwork.ts
//
// Safest supported sequence for Arc network switching (delegates to the
// generic ensureEvmNetwork — same behavior, single implementation):
//
// current chain != target Arc chain
//   -> try switch
//   -> if unknown (4902 / Unrecognized chain) try add(eip3085) then retry switch
//
// The target chain MUST be the server-resolved one (useActiveArcChain().chain
// from GET /api/network) — never a build-time chain object. The default is
// Arc Mainnet (production-safe): the production browser must never silently
// fall back to testnet. Testnet development passes the testnet chain
// explicitly via the same hook (a testnet server resolves 5042002).

import type { Chain } from 'viem';
import { arcMainnet } from '@/lib/wallet/arcChains';
import { ensureEvmNetwork, type EnsureEvmResult } from '@/lib/wallet/ensureEvmNetwork';

export type EnsureArcResult = EnsureEvmResult;

export async function ensureArcNetwork(opts: {
  chainId: number | undefined;
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>;
  /** Optional: active connector's provider (WalletConnect) for eip3085 add. */
  getProvider?: () => Promise<any>;
  /**
   * Target Arc chain object. Defaults to Arc Mainnet (chain 5042).
   * Browser call sites MUST pass useActiveArcChain().chain so the wallet
   * follows the server-selected network.
   */
  chain?: Chain;
}): Promise<EnsureArcResult> {
  const { chain, ...rest } = opts;
  return ensureEvmNetwork({ chain: chain ?? arcMainnet, ...rest });
}
