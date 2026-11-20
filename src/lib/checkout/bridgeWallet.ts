type WalletRequest = { method: string; params?: readonly unknown[] };
type Progress = 'ready' | 'uncertain' | 'submitted';

export function trackCheckoutWallet(
  request: (args: WalletRequest) => Promise<unknown>,
  usdcAddress: string,
  record: (state: Progress, hash: string | null) => void,
) {
  let state: Progress = 'ready';
  return async (args: WalletRequest) => {
    if (/^(eth_sign|personal_sign|eth_sendRawTransaction)/.test(args.method)) {
      throw new Error('This signing method is unavailable for checkout.');
    }
    const singleTransaction = args.method === 'eth_sendTransaction' || args.method === 'wallet_sendTransaction';
    if (!singleTransaction && args.method !== 'wallet_sendCalls') return request(args);
    if (state !== 'ready') throw new Error('Check the existing transfer before sending again.');

    const tx = args.params?.[0] as { to?: string; data?: string } | undefined;
    const approval = singleTransaction
      && tx?.to?.toLowerCase() === usdcAddress.toLowerCase()
      && /^0x095ea7b3[\da-f]{128}$/i.test(tx.data ?? '');
    record('uncertain', null);
    state = 'uncertain';
    let result: unknown;
    try {
      result = await request(args);
    } catch (error) {
      if ((error as { code?: number })?.code === 4001) {
        record('ready', null);
        state = 'ready';
      }
      throw error;
    }
    if (approval) {
      record('ready', null);
      state = 'ready';
    } else if (singleTransaction && typeof result === 'string' && /^0x[\da-f]{64}$/i.test(result)) {
      state = 'submitted';
      record('submitted', result);
    }
    return result;
  };
}
