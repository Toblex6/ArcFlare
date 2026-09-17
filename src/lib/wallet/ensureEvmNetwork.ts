// src/lib/wallet/ensureEvmNetwork.ts
//
// Generic EVM network switch/add helper — the same safest-supported sequence
// as ensureArcNetwork, parameterized by target chain:
//
// current chain != target
//   -> try switch
//   -> if unknown (4902 / Unrecognized chain) try add (eip3085) then retry switch
//
// ensureArcNetwork delegates to this module (behavior-identical wrapper), and
// the EXTERNAL Bridge flow uses it directly for testnet source chains.
// Browser-only (touches window.ethereum as a fallback provider).

export interface EvmChainDefinition {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: { default: { http: readonly string[] | string[] } };
  // Optional: viem Chain types leave explorers undefined; EIP-3085 treats
  // blockExplorerUrls as optional, so adds still succeed without one.
  blockExplorers?: { default: { name: string; url: string } };
}

export type EnsureEvmResult =
  | { ok: true }
  | { ok: false; reason: 'REJECTED' | 'UNSUPPORTED' | 'TIMEOUT' | 'GENERIC'; message: string };

async function addChainViaProvider(provider: any, chain: EvmChainDefinition): Promise<void> {
  if (!provider?.request) throw new Error('no ethereum provider');
  const hexChainId = '0x' + chain.id.toString(16);
  const explorerUrl = chain.blockExplorers?.default?.url;
  await provider.request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: hexChainId,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [...chain.rpcUrls.default.http],
        ...(explorerUrl ? { blockExplorerUrls: [explorerUrl] } : {}),
      },
    ],
  });
}

async function addChain(
  chain: EvmChainDefinition,
  opts?: { getProvider?: () => Promise<any> }
): Promise<void> {
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
  return addChainViaProvider(provider, chain);
}

export async function ensureEvmNetwork(opts: {
  chain: EvmChainDefinition;
  chainId: number | undefined;
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>;
  /** Optional: active connector's provider (WalletConnect) for eip3085 add. */
  getProvider?: () => Promise<any>;
}): Promise<EnsureEvmResult> {
  const { chain, chainId, switchChainAsync } = opts;
  if (chainId === chain.id) return { ok: true };

  // 1. try normal switch
  try {
    await switchChainAsync({ chainId: chain.id });
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
        await addChain(chain, { getProvider: opts.getProvider });
        // many wallets auto-switch after add; verify, else explicitly switch
        try {
          await switchChainAsync({ chainId: chain.id });
        } catch {
          // ignore — provider may already be on new chain after add
        }
        return { ok: true };
      } catch (addErr: any) {
        const addMsg = String(addErr?.message ?? '').toLowerCase();
        const addCode = (addErr as any)?.code;
        if (addMsg.includes('user rejected') || addMsg.includes('user denied') || addCode === 4001) {
          return { ok: false, reason: 'REJECTED', message: `Adding ${chain.name} was cancelled. Open your wallet and add it manually, then try again.` };
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
              `Your wallet couldn't add ${chain.name} automatically. Open your wallet and select/add ${chain.name}, then return here and try again.`,
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
            `FlareHQ needs ${chain.name} for this step. Your wallet couldn't switch automatically. Open your wallet and select/add ${chain.name}, then return here and try again.`,
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
        `FlareHQ needs ${chain.name} for this step. Your wallet couldn't switch automatically. Open your wallet and select/add ${chain.name}, then return here and try again.`,
    };
  }
}
