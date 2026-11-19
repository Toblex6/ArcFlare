// Wallet network alignment is not an ownership gate: callers still use
// verifyCallerControlsAddress. These fresh read-only checks prevent a stale
// testnet wallet ID from signing in an Arc Mainnet request.
import { getArcNetworkName, getNetworkConfig } from '@/lib/config/network';
import { Transaction } from 'ethers';

export class CircleNetworkError extends Error {
  constructor(readonly code: 'WALLET_NETWORK_MISMATCH' | 'WALLET_CHECK_FAILED', readonly status: 409 | 503) {
    super(code === 'WALLET_NETWORK_MISMATCH'
      ? 'The signing wallet does not match the active Arc network. No signing request was submitted.'
      : 'Could not verify the signing wallet network. No signing request was submitted; try again.');
    this.name = 'CircleNetworkError';
  }
}

interface WalletReader {
  getWallet(input: { id: string }): Promise<{ data?: { wallet?: { id?: string; address?: string; blockchain?: string; state?: string } } }>;
  listWallets?(input: any): Promise<{ data?: { wallets?: Array<{ id?: string; address?: string; blockchain?: string }> } }>;
  getTransaction?(input: { id: string }): Promise<{ data?: { transaction?: { id?: string; walletId?: string; blockchain?: string } } }>;
}

export function assertCircleBlockchain(blockchain: unknown): void {
  if (getArcNetworkName() !== 'mainnet') return;
  const expected = getNetworkConfig().circleBlockchain;
  if (typeof blockchain !== 'string' || blockchain !== expected || /TESTNET|SEPOLIA|AMOY/i.test(blockchain)) {
    throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
  }
}

export async function assertCircleSigningNetwork(client: WalletReader, input: {
  walletId?: string;
  walletAddress?: string;
  blockchain?: string;
}): Promise<void> {
  if (getArcNetworkName() !== 'mainnet') return;
  if (input.blockchain !== undefined) assertCircleBlockchain(input.blockchain);
  let walletId = input.walletId;
  if (!walletId) {
    if (!input.walletAddress || !/^0x[0-9a-f]{40}$/i.test(input.walletAddress) || input.blockchain === undefined) {
      throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
    }
    try {
      if (!client.listWallets) throw new Error('Wallet lookup unavailable.');
      const { data } = await client.listWallets({ address: input.walletAddress, blockchain: input.blockchain });
      const matches = (data?.wallets ?? []).filter((wallet) =>
        wallet.address?.toLowerCase() === input.walletAddress!.toLowerCase() && wallet.blockchain === input.blockchain
      );
      if (matches.length !== 1 || !matches[0].id) throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
      walletId = matches[0].id;
    } catch (error) {
      if (error instanceof CircleNetworkError) throw error;
      throw new CircleNetworkError('WALLET_CHECK_FAILED', 503);
    }
  }
  let wallet: Awaited<ReturnType<WalletReader['getWallet']>>['data'];
  try {
    wallet = (await client.getWallet({ id: walletId })).data;
  } catch (error: any) {
    if (error?.status === 404 || error?.response?.status === 404) {
      throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
    }
    throw new CircleNetworkError('WALLET_CHECK_FAILED', 503);
  }
  const resource = wallet?.wallet;
  if (!resource || resource.id !== walletId || resource.state !== 'LIVE' ||
      typeof resource.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(resource.address) ||
      (input.walletAddress && resource.address?.toLowerCase() !== input.walletAddress.toLowerCase())) {
    throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
  }
  assertCircleBlockchain(resource.blockchain);
}

const SIGNING_METHODS = new Set([
  'createTransaction', 'createTransferTransaction', 'createContractExecutionTransaction',
  'signTransaction', 'signMessage', 'signTypedData', 'signDelegateAction', 'deployContract', 'deployContractTemplate',
]);

// SDK inputs are plain request data. Copy nested arrays/objects before any
// asynchronous lookup, including adapter contexts and execution overrides.
function snapshotRequest<T>(input: T): T {
  if (Array.isArray(input)) return input.map(snapshotRequest) as T;
  if (input && typeof input === 'object' &&
      (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)) {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, snapshotRequest(value)])) as T;
  }
  return input;
}

function assertSigningPayloadChain(method: string, input: any): void {
  if (getArcNetworkName() !== 'mainnet') return;
  const expected = BigInt(getNetworkConfig().chainId);
  try {
    if (method === 'signTypedData') {
      const domain = JSON.parse(input.data)?.domain;
      if (domain?.chainId === undefined || BigInt(domain.chainId) !== expected) throw new Error('Unbound or foreign typed-data chain.');
    }
    if (method === 'signTransaction') {
      const chainId = input.rawTransaction
        ? Transaction.from(input.rawTransaction).chainId
        : JSON.parse(input.transaction)?.chainId;
      // Unbound transactions can be replayed on testnet: refuse them too.
      if (chainId === undefined || BigInt(chainId) !== expected) throw new Error('Wrong transaction chain.');
    }
    // The installed SDK exposes an opaque base64 delegate-action payload,
    // not an Arc EVM transaction. It cannot establish a mainnet chain binding.
    if (method === 'signDelegateAction') throw new Error('Unverifiable delegate-action chain.');
  } catch {
    throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
  }
}

async function assertTransactionSigningNetwork(client: WalletReader, id: unknown): Promise<void> {
  if (getArcNetworkName() !== 'mainnet') return;
  if (typeof id !== 'string' || !id) throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
  let transaction;
  try {
    if (!client.getTransaction) throw new Error('Transaction lookup unavailable.');
    transaction = (await client.getTransaction({ id })).data?.transaction;
  } catch {
    throw new CircleNetworkError('WALLET_CHECK_FAILED', 503);
  }
  if (!transaction?.walletId || transaction.id !== id) throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
  assertCircleBlockchain(transaction.blockchain);
  await assertCircleSigningNetwork(client, { walletId: transaction.walletId, blockchain: transaction.blockchain });
}

/** Preserve the SDK type and read APIs; guard every shared signing entry. */
export function withCircleNetworkGuard<T extends object>(client: T, walletReader: WalletReader = client as unknown as WalletReader): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      // TypeScript-private SDK params expose its generated API client and
      // bypass the public signing methods. Internal SDK calls keep raw this.
      if (property === 'params') return undefined;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && SIGNING_METHODS.has(property)) {
        return async (input: any, ...rest: any[]) => {
          // Snapshot identity fields before the asynchronous read, so callers
          // cannot substitute a wallet while the check is in flight.
          const request = input && typeof input === 'object' ? snapshotRequest(input) : {};
          assertSigningPayloadChain(property, request);
          await assertCircleSigningNetwork(walletReader, request);
          return value.call(target, request, ...rest);
        };
      }
      if (property === 'accelerateTransaction' || property === 'cancelTransaction') {
        return async (input: any, ...rest: any[]) => {
          const request = snapshotRequest({ ...input });
          await assertTransactionSigningNetwork(walletReader, request.id);
          return value.call(target, request, ...rest);
        };
      }
      if (property === 'deriveWallet' || property === 'deriveWalletByAddress') {
        return async (input: any, ...rest: any[]) => {
          const request = snapshotRequest({ ...input });
          if (getArcNetworkName() === 'mainnet') {
            if (property === 'deriveWallet') {
              assertCircleBlockchain(request.blockchain);
              await assertCircleSigningNetwork(walletReader, { walletId: request.id });
            } else {
              assertCircleBlockchain(request.sourceBlockchain);
              assertCircleBlockchain(request.targetBlockchain);
              await assertCircleSigningNetwork(walletReader, { walletAddress: request.walletAddress, blockchain: request.sourceBlockchain });
            }
          }
          return value.call(target, request, ...rest);
        };
      }
      if (property === 'createWallets') {
        return async (input: any, ...rest: any[]) => {
          const request = snapshotRequest({ ...input });
          if (getArcNetworkName() === 'mainnet') {
            if (!Array.isArray(request.blockchains) || !request.blockchains.length) assertCircleBlockchain(undefined);
            for (const blockchain of request.blockchains) assertCircleBlockchain(blockchain);
          }
          return value.call(target, request, ...rest);
        };
      }
      return value.bind(target);
    },
  });
}

/** The Bridge Kit Circle adapter has its own SDK; guard its execution edge. */
export function withCircleBridgeAdapterGuard<T extends object>(adapter: T, client: WalletReader): T {
  const adapters = new WeakMap<object, any>();
  const clients = new WeakMap<object, Map<string, any>>();
  const maps = new WeakMap<object, any>();
  const mismatch = () => { throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409); };
  const assertChain = (chain: any) => {
    if (getArcNetworkName() !== 'mainnet') return;
    const expected = getNetworkConfig().chainId;
    const matches = typeof chain === 'string' ? chain === 'Arc'
      : (chain?.id === expected || chain?.chainId === expected) &&
        (chain.id === undefined || chain.id === expected) &&
        (chain.chainId === undefined || chain.chainId === expected) &&
        (chain.chain === undefined || chain.chain === 'Arc') &&
        (chain.type === undefined || chain.type === 'evm') &&
        chain.testnet !== true && chain.isTestnet !== true;
    if (!matches) mismatch();
  };
  const checkContext = async (context: any) => {
    if (getArcNetworkName() !== 'mainnet') return;
    const config = getNetworkConfig();
    assertChain(context?.chain);
    await assertCircleSigningNetwork(client, { walletAddress: context?.address, blockchain: config.circleBlockchain });
  };
  const checkWalletRequest = async (request: any, chain: any) => {
    if (getArcNetworkName() !== 'mainnet') return;
    const expected = getNetworkConfig().chainId;
    const suppliedChain = request?.chain;
    let chainIdMatches = true;
    try {
      if (request?.chainId !== undefined) chainIdMatches = BigInt(request.chainId) === BigInt(expected);
      for (const authorization of request?.authorizationList ?? []) {
        if (authorization.chainId === undefined || BigInt(authorization.chainId) !== BigInt(expected)) chainIdMatches = false;
      }
    }
    catch { chainIdMatches = false; }
    if (!chainIdMatches || (suppliedChain !== undefined && suppliedChain?.id !== expected)) {
      throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
    }
    const address = typeof request?.account === 'string' ? request.account : request?.account?.address ?? request?.from;
    if (request?.from !== undefined && (typeof request.from !== 'string' || typeof address !== 'string' || address.toLowerCase() !== request.from.toLowerCase())) {
      throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
    }
    await checkContext({ chain, address });
  };
  const json = (value: any) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
  const readRpc = (method: unknown) => /^(eth_(chainId|blockNumber|get\w+|call|estimateGas|feeHistory|maxPriorityFeePerGas|gasPrice)|wallet_get\w+)$/.test(String(method));
  const checkRpc = async (request: any, chain: any, readOnly: boolean) => {
    if (getArcNetworkName() !== 'mainnet' || readRpc(request?.method)) return;
    if (readOnly) mismatch();
    const params = request?.params;
    if (!Array.isArray(params)) mismatch();
    switch (request.method) {
      case 'eth_sendTransaction':
      case 'eth_signTransaction':
        await checkWalletRequest(params[0], chain);
        return;
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4':
        assertSigningPayloadChain('signTypedData', { data: typeof params[1] === 'string' ? params[1] : json(params[1]) });
        await checkWalletRequest({ account: params[0] }, chain);
        return;
      case 'eth_sign':
        await checkWalletRequest({ account: params[0] }, chain);
        return;
      case 'personal_sign':
        await checkWalletRequest({ account: params[1] }, chain);
        return;
      case 'wallet_sendCalls':
        await checkWalletRequest(params[0], chain);
        return;
      default:
        // Raw broadcasts and unknown writes have no provable wallet identity.
        mismatch();
    }
  };
  const guardMap = (map: Map<any, any>, wrap: (value: any, key: any) => any): any => {
    if (maps.has(map)) return maps.get(map);
    const proxy = new Proxy(map, {
      get(target, key) {
        if (key === 'get') return (id: any) => wrap(target.get(id), id);
        if (key === 'set') return (id: any, value: any) => { target.set(id, wrap(value, id)); return proxy; };
        if (key === 'values') return function* () { for (const [id, value] of target) yield wrap(value, id); };
        if (key === 'entries' || key === Symbol.iterator) return function* () { for (const [id, value] of target) yield [id, wrap(value, id)]; };
        if (key === 'forEach') return (fn: any, thisArg: any) => target.forEach((value, id) => fn.call(thisArg, wrap(value, id), id, proxy));
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    maps.set(map, proxy);
    return proxy;
  };
  const walletMethods = new Set([
    'sendTransaction', 'sendTransactionSync', 'writeContract', 'writeContractSync', 'deployContract',
    'signTransaction', 'signMessage', 'signTypedData', 'signAuthorization', 'sendCalls', 'sendCallsSync',
    'approve', 'approveSync', 'transfer', 'transferSync',
  ]);
  const guardClient = (wallet: any, chain: any, readOnly = false): any => {
    if (!wallet || typeof wallet !== 'object') return wallet;
    chain = snapshotRequest(chain);
    const key = `${readOnly}:${typeof chain === 'string' ? chain : chain?.chainId ?? chain?.id ?? 'unbound'}`;
    let cache = clients.get(wallet);
    if (cache?.has(key)) return cache.get(key);
    if (!cache) { cache = new Map(); clients.set(wallet, cache); }
    const guardRpcObject = (rpc: any): any => rpc && typeof rpc === 'object' ? new Proxy(rpc, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'request' && typeof value === 'function') return async (...args: any[]) => {
          args = snapshotRequest(args);
          if (getArcNetworkName() === 'mainnet' && !readRpc(args[0]?.method) && wallet.chain !== undefined) assertChain(wallet.chain);
          await checkRpc(args[0], chain, readOnly);
          return value.apply(target, args);
        };
        if (value && typeof value === 'object') return guardRpcObject(value);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) : rpc;
    const guardedAction = (method: any, name: string, target: any): any => {
      const action = async (input: any, ...rest: any[]) => {
        const request = snapshotRequest(input ?? {});
        if (getArcNetworkName() === 'mainnet') {
          if (readOnly) mismatch();
          if (wallet.chain !== undefined) assertChain(wallet.chain);
          // Circle clients never need a caller-supplied local signing account.
          if (request.account && typeof request.account === 'object' && request.account.type !== 'json-rpc') mismatch();
          await checkWalletRequest({ ...request, account: request.account ?? wallet.account }, chain);
          if (name === 'signTypedData') assertSigningPayloadChain('signTypedData', { data: json(request) });
        }
        return method.call(target, request, ...rest);
      };
      // viem token decorators also expose read/simulation/call-data helpers.
      for (const helper of Object.keys(method)) {
        if (typeof method[helper] === 'function') Object.defineProperty(action, helper, { value: method[helper].bind(target), enumerable: true });
      }
      return action;
    };
    const proxy = new Proxy(wallet, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver);
        if (property === 'transport' || property === 'provider') return guardRpcObject(method);
        if (property === 'account' && method && typeof method === 'object') return new Proxy(method, {
          get(account, name) {
            const value = Reflect.get(account, name, account);
            if (/^sign/.test(String(name)) && typeof value === 'function') return async (...args: any[]) => {
              if (getArcNetworkName() === 'mainnet') mismatch();
              return value.apply(account, args);
            };
            return value;
          },
        });
        if (property === 'token' && method && typeof method === 'object') return new Proxy(method, {
          get(namespace, name) {
            const value = Reflect.get(namespace, name, namespace);
            return typeof value === 'function' && walletMethods.has(String(name)) ? guardedAction(value, String(name), namespace) : value;
          },
        });
        if (typeof method !== 'function') return method;
        if (walletMethods.has(String(property))) return guardedAction(method, String(property), target);
        if (property === 'extend') return (extend: any) => {
          // viem extend() captures the ORIGINAL base client, not its receiver.
          // Never hand that raw request/transport to an extension callback.
          const extended = method.call(target, (base: any) => extend(guardClient(base, chain, readOnly)));
          return guardClient(extended, chain, readOnly);
        };
        if (property === 'sendRawTransaction' || property === 'sendRawTransactionSync') return async (...args: any[]) => {
          if (getArcNetworkName() === 'mainnet') mismatch();
          return method.apply(target, args);
        };
        if (property === 'request') return async (...args: any[]) => {
          args = snapshotRequest(args);
          if (getArcNetworkName() === 'mainnet' && !readRpc(args[0]?.method) && wallet.chain !== undefined) assertChain(wallet.chain);
          await checkRpc(args[0], chain, readOnly);
          return method.apply(target, args);
        };
        return method.bind(target);
      },
    });
    cache.set(key, proxy);
    clients.set(proxy, cache);
    return proxy;
  };
  const guardPrepared = (prepared: any, context: any): any => new Proxy(prepared, {
    get(request, key, receiver) {
      const method = Reflect.get(request, key, receiver);
      if (key === 'execute') return async (...args: any[]) => {
        args = snapshotRequest(args);
        if (getArcNetworkName() === 'mainnet' && args[0]) {
          await checkWalletRequest({ account: context.address, ...args[0] }, context.chain);
          const account = args[0].account;
          const address = typeof account === 'string' ? account : account?.address;
          if (address && address.toLowerCase() !== context.address.toLowerCase()) mismatch();
        }
        await checkContext(context); // fresh read, not preparation-time liveness
        return method.apply(request, args);
      };
      return typeof method === 'function' ? method.bind(request) : method;
    },
  });
  const guardAdapter = (raw: any): any => {
    if (!raw || typeof raw !== 'object') return raw;
    if (adapters.has(raw)) return adapters.get(raw);
    // Install guarded factories ON the SDK instance: the hybrid's augmented
    // methods capture raw sub-adapters and do not call proxy.resolveAdapter.
    if (raw.options) {
      for (const [name, wrap] of Object.entries({
        getAdapterForChain: (value: any) => guardAdapter(value),
        getWalletClient: (value: any, chain: any) => guardClient(value, chain),
        getPublicClient: (value: any, chain: any) => guardClient(value, chain, true),
      })) {
        const original = raw.options[name];
        if (typeof original !== 'function') continue;
        raw.options[name] = function (...args: any[]) {
          args = snapshotRequest(args);
          const value = original.apply(this, args);
          const chain = args[0]?.chain;
          return value?.then ? value.then((result: any) => wrap(result, chain)) : wrap(value, chain);
        };
      }
    }
    const proxy = new Proxy(raw, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === 'adapterCache' && value instanceof Map) return guardMap(value, guardAdapter);
        if (['cachedWalletClients', 'walletClientInitPromises', 'cachedPublicClients'].includes(String(property)) && value instanceof Map) {
          return guardMap(value, (entry, id) => {
            const wrap = (result: any) => guardClient(result, result?.chain ?? { id: Number(id) }, property === 'cachedPublicClients');
            return entry?.then ? entry.then(wrap) : wrap(entry);
          });
        }
        if (property === 'actionRegistry' && value) return guardAdapter(value);
        if (property === 'actionHandlers' && value instanceof Map) return guardMap(value, (handler) => typeof handler === 'function' ? async (params: any, context: any) => {
          [params, context] = snapshotRequest([params, context]);
          await checkContext(context);
          return guardPrepared(await handler(params, context), context);
        } : handler);
        if (typeof value !== 'function') return value;
        if (property === 'prepare' || property === 'prepareAction' || property === 'executeAction') {
          return async (...args: any[]) => {
            const contextIndex = property === 'prepare' ? 1 : 2;
            args = snapshotRequest(args);
            const context = args[contextIndex];
            await checkContext(context);
            const prepared = await value.apply(receiver, args);
            return guardPrepared(prepared, context);
          };
        }
        if (property === 'prepareNativeTransfer' || property === 'prepareStateChangingFunction') return async (...args: any[]) => {
          args = snapshotRequest(args);
          const context = { chain: args[2], address: args[3] };
          await checkContext(context);
          return guardPrepared(await value.apply(receiver, args), context);
        };
        if (property === 'signTypedData') return async (...args: any[]) => {
          args = snapshotRequest(args);
          const context = args[1];
          const typedData = args[0];
          assertSigningPayloadChain('signTypedData', { data: JSON.stringify(typedData, (_, item) => typeof item === 'bigint' ? item.toString() : item) });
          await checkContext(context);
          if (getArcNetworkName() === 'mainnet' && target.options?.getAdapterForChain) {
            // Its factory-captured signTypedData() bypasses resolveAdapter().
            // Warm the same closure's sub-adapter so its client factories are
            // guarded before the captured method can initialize a signer.
            await target.options.getAdapterForChain(typeof context.chain === 'string'
              ? { chain: 'Arc', chainId: getNetworkConfig().chainId, isTestnet: false, type: 'evm' }
              : context.chain);
          }
          args[0] = typedData;
          args[1] = context;
          return value.apply(receiver, args);
        };
        if (property === 'sendTransaction') return async (...args: any[]) => {
          args = snapshotRequest(args);
          if (getArcNetworkName() === 'mainnet') {
            await checkWalletRequest({ account: args[2], ...args[0], ...args[3] }, args[1]);
            const account = args[3]?.account;
            const address = typeof account === 'string' ? account : account?.address;
            if (address && address.toLowerCase() !== args[2]?.toLowerCase()) throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
          }
          await checkContext({ chain: args[1], address: args[2] });
          return value.apply(receiver, args);
        };
        if (property === 'initializeWalletClient' || property === 'getPublicClient') return async (...args: any[]) => {
          args = snapshotRequest(args);
          return guardClient(await value.apply(receiver, args), args[0], property === 'getPublicClient');
        };
        if (property === 'batchExecute' && getArcNetworkName() === 'mainnet') return async () => {
          // The installed developer-controlled batch API has no explicit sender
          // context. Do not infer a wallet or bypass per-wallet verification.
          throw new CircleNetworkError('WALLET_NETWORK_MISMATCH', 409);
        };
        if (property === 'getSdk') return async (...args: any[]) => {
          const sdk = await value.apply(target, args);
          // adapter-circle-wallets 1.4.3 returns { devc, scp }, not a bare DCW
          // client. Preserve the SDK envelope while guarding its signing client.
          return sdk?.devc ? {
            ...sdk,
            devc: withCircleNetworkGuard(sdk.devc),
            ...(sdk.scp ? { scp: withCircleNetworkGuard(sdk.scp, client) } : {}),
          } : withCircleNetworkGuard(sdk);
        };
        if (property === 'resolveAdapter') return async (...args: any[]) => guardAdapter(await value.apply(receiver, snapshotRequest(args)));
        return value.bind(receiver);
      },
    });
    adapters.set(raw, proxy);
    adapters.set(proxy, proxy);
    return proxy;
  };
  return guardAdapter(adapter);
}
