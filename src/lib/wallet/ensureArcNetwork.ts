// src/lib/wallet/ensureArcNetwork.ts
//
// Safest supported sequence for Arc Testnet switching (delegates to the
// generic ensureEvmNetwork — same behavior, single implementation):
//
// current chain != Arc Testnet
//   -> try switch
//   -> if unknown (4902 / Unrecognized chain) try add(eip3085) then retry switch
//
// Uses the single `arcTestnet` definition — no duplicated chainId/rpc/nativeCurrency.

import { arcTestnet } from '@/lib/wagmi';
import { ensureEvmNetwork, type EnsureEvmResult } from '@/lib/wallet/ensureEvmNetwork';

export type EnsureArcResult = EnsureEvmResult;

export async function ensureArcNetwork(opts: {
  chainId: number | undefined;
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>;
  /** Optional: active connector's provider (WalletConnect) for eip3085 add. */
  getProvider?: () => Promise<any>;
}): Promise<EnsureArcResult> {
  return ensureEvmNetwork({ chain: arcTestnet, ...opts });
}
