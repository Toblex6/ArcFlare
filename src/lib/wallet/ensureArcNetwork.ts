// src/lib/wallet/ensureArcNetwork.ts
//
// Safest supported sequence for Arc Testnet switching:
//
// current chain != Arc Testnet
//   -> try switch
//   -> if unknown (4902 / Unrecognized chain) try add(eip3085) then retry switch
//
// Uses the single `arcTestnet` definition — no duplicated chainId/rpc/nativeCurrency.

import { arcTestnet } from '@/lib/wagmi';

export type EnsureArcResult =
  | { ok: true }
  | { ok: false; reason: 'REJECTED' | 'UNSUPPORTED' | 'TIMEOUT' | 'GENERIC'; message: string };

async function addArcTestnetViaProvider(provider: any): Promise<void> {
  if (!provider?.request) throw new Error('no ethereum provider');
  const hexChainId = '0x' + arcTestnet.id.toString(16);
  await provider.request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: hexChainId,
        chainName: arcTestnet.name,
        nativeCurrency: arcTestnet.nativeCurrency,
        rpcUrls: arcTestnet.rpcUrls.default.http,
        blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
      },
    ],
  });
}

async function addArcTestnet(opts?: { getProvider?: () => Promise<any> }): Promise<void> {
  // Prefer the active connector's provider (WalletConnect) when available,
  // otherwise fall back to window.ethereum for injected wallets.
  let provider: any = null;
  if (opts?.getProvider) {
    try {
      provider = await opts.getProvider();
    } catch {
      // ignore — fall back to window.ethereum
    }
  }
  if (!provider) provider = (window as any)?.ethereum;
  return addArcTestnetViaProvider(provider);
}

export async function ensureArcNetwork(opts: {
  chainId: number | undefined;
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>;
  /** Optional: active connector's provider (WalletConnect) for eip3085 add. */
  getProvider?: () => Promise<any>;
}): Promise<EnsureArcResult> {
  const { chainId, switchChainAsync } = opts;
  if (chainId === arcTestnet.id) return { ok: true };

  // 1. try normal switch
  try {
    await switchChainAsync({ chainId: arcTestnet.id });
    return { ok: true };
  } catch (err: any) {
    const msg = String(err?.message ?? '').toLowerCase();
    const code = (err as any)?.code;
    const isUnknownChain =
      code === 4902 ||
      msg.includes('unrecognized chain') ||
      msg.includes('unknown chain') ||
      msg.includes('chain not added') ||
      msg.includes('does not exist') ||
      msg.includes('not added');

    // 2. user explicitly rejected switch
    const isRejected =
      msg.includes('user rejected') || msg.includes('user denied') || msg.includes('rejected the request');
    if (isRejected && !isUnknownChain) {
      return { ok: false, reason: 'REJECTED', message: 'Network switch was cancelled. Please try again.' };
    }

    // 3. chain not added — try add then switch
    if (isUnknownChain) {
      try {
        await addArcTestnet({ getProvider: opts.getProvider });
        // many wallets auto-switch after add; verify, else explicitly switch
        try {
          await switchChainAsync({ chainId: arcTestnet.id });
        } catch {
          // ignore — provider may already be on new chain after add
        }
        return { ok: true };
      } catch (addErr: any) {
        const addMsg = String(addErr?.message ?? '').toLowerCase();
        const addCode = (addErr as any)?.code;
        if (addMsg.includes('user rejected') || addMsg.includes('user denied') || addCode === 4001) {
          return { ok: false, reason: 'REJECTED', message: 'Adding Arc Testnet was cancelled. Open your wallet and add it manually, then try again.' };
        }
        // wallets that don't support adding custom networks (some WC mobiles)
        if (
          addMsg.includes('not support') ||
          addMsg.includes('unsupported') ||
          addMsg.includes('not found') ||
          addMsg.includes('does not support')
        ) {
          return {
            ok: false,
            reason: 'UNSUPPORTED',
            message:
              'Your wallet couldn\'t add Arc Testnet automatically. Open your wallet and select/add Arc Testnet, then return here and try again.',
          };
        }
        // timeout-ish during add
        if (addMsg.includes('timeout')) {
          return { ok: false, reason: 'TIMEOUT', message: "Your wallet didn't respond while adding the network. Open your wallet app and try again." };
        }
        return {
          ok: false,
          reason: 'UNSUPPORTED',
          message:
            "FlareHQ uses Arc Testnet for this payment. Your wallet couldn't switch automatically. Open your wallet and select/add Arc Testnet, then return here and try again.",
        };
      }
    }

    // 4. timeout while switching
    if (msg.includes('timeout')) {
      return { ok: false, reason: 'TIMEOUT', message: "Your wallet didn't respond. Open your wallet app and try again." };
    }

    // 5. generic fallback — let caller show graceful manual-add fallback
    return {
      ok: false,
      reason: 'GENERIC',
      message:
        "FlareHQ uses Arc Testnet for this payment. Your wallet couldn't switch automatically. Open your wallet and select/add Arc Testnet, then return here and try again.",
    };
  }
}
