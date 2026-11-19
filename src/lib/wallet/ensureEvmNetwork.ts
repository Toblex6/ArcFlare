// Network switching succeeds only after reading the active provider's chain.
// A wagmi ChainNotConfiguredError is an app-registration error, not proof
// that the wallet lacks the chain. Use EIP-1193 directly in that case.

export interface EvmChainDefinition {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: { default: { http: readonly string[] } };
  blockExplorers?: { default: { name: string; url: string } };
}

export type EnsureEvmResult =
  | { ok: true }
  | { ok: false; reason: 'REJECTED' | 'UNSUPPORTED' | 'TIMEOUT' | 'GENERIC'; message: string };

function errorFacts(error: unknown): { text: string; codes: unknown[] } {
  const text: string[] = [];
  const codes: unknown[] = [];
  let current: any = error;
  for (let depth = 0; current && depth < 8; depth++, current = current.cause) {
    text.push(String(current.name ?? ''), String(current.message ?? current));
    codes.push(current.code);
  }
  return { text: text.join(' ').toLowerCase(), codes };
}

function isUnknownChain(error: unknown): boolean {
  const { text, codes } = errorFacts(error);
  return codes.includes(4902) || /unrecognized chain|unknown chain|chain not added|not added|does not exist/.test(text);
}

function failure(error: unknown, chain: EvmChainDefinition): EnsureEvmResult {
  const { text, codes } = errorFacts(error);
  if (codes.includes(4001) || /user rejected|user denied|rejected the request/.test(text)) {
    return { ok: false, reason: 'REJECTED', message: 'Network switch was cancelled. Please try again.' };
  }
  if (/timeout|timed out/.test(text)) {
    return { ok: false, reason: 'TIMEOUT', message: "Your wallet didn't respond. Open your wallet app and try again." };
  }
  return {
    ok: false,
    reason: /unsupported|not support|not found|notconfigured|not configured|no provider/.test(text) ? 'UNSUPPORTED' : 'GENERIC',
    message: `Your wallet couldn't switch to ${chain.name}. Open your wallet and select/add ${chain.name}, then try again.`,
  };
}

export async function ensureEvmNetwork(opts: {
  chain: EvmChainDefinition;
  /** Hook snapshot is not authoritative; eth_chainId is always re-read. */
  chainId: number | undefined;
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>;
  getProvider?: () => Promise<any>;
}): Promise<EnsureEvmResult> {
  const { chain, switchChainAsync } = opts;
  try {
    // Never fall back to a different injected wallet if an active connector
    // was supplied but failed (especially WalletConnect).
    const provider = opts.getProvider
      ? await opts.getProvider()
      : typeof window !== 'undefined' ? (window as any).ethereum : null;
    if (!provider?.request) throw new Error('No provider for the active wallet.');
    const liveChainId = async (): Promise<number> => {
      const value = await provider.request({ method: 'eth_chainId' });
      const id = typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? Number(BigInt(value)) : value;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('Could not verify wallet chain.');
      return id;
    };
    if (await liveChainId() === chain.id) return { ok: true };
    const params = [{ chainId: '0x' + chain.id.toString(16) }];
    let useProviderSwitch = false;
    const switchWallet = async (): Promise<void> => {
      if (useProviderSwitch) {
        await provider.request({ method: 'wallet_switchEthereumChain', params });
        return;
      }
      try {
        await switchChainAsync({ chainId: chain.id });
      } catch (error) {
        const { text } = errorFacts(error);
        if (!/chainnotconfigurederror|chain not configured/.test(text)) throw error;
        useProviderSwitch = true;
        await provider.request({ method: 'wallet_switchEthereumChain', params });
      }
    };
    try {
      await switchWallet();
    } catch (error) {
      if (!isUnknownChain(error)) throw error;
      const explorer = chain.blockExplorers?.default?.url;
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            ...params[0],
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: [...chain.rpcUrls.default.http],
            ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
          }],
        });
      } catch (addError) {
        // Keep the add-network cancellation distinct from the first switch.
        const failed = failure(addError, chain);
        if (!failed.ok && failed.reason === 'REJECTED') return {
          ...failed,
          message: `Adding ${chain.name} was cancelled. Open your wallet and add it manually, then try again.`,
        };
        throw addError;
      }
      // Some wallets switch when adding; otherwise a failed/rejected switch
      // must propagate. Adding a network alone is never success.
      if (await liveChainId() !== chain.id) await switchWallet();
    }
    if (await liveChainId() !== chain.id) {
      return { ok: false, reason: 'UNSUPPORTED', message: `Switch your wallet to ${chain.name} to continue.` };
    }
    return { ok: true };
  } catch (error) {
    return failure(error, chain);
  }
}
