// Bridge Kit retry may execute missing approval/burn steps. Status polling
// must never give it a source signing edge, even if its step analysis changes.
const SIGNING_EDGES = new Set([
  'prepare', 'prepareAction', 'executeAction', 'sendTransaction', 'signTypedData',
  'batchExecute', 'getSdk', 'initializeWalletClient',
]);

export function withReadOnlyBridgeAdapter<T extends object>(adapter: T): T {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (SIGNING_EDGES.has(String(property))) return async () => {
        throw Object.assign(new Error('Bridge recovery cannot submit approval or burn transactions. Recover the existing burn; do not spend again.'), {
          code: 'BRIDGE_RECOVERY_READ_ONLY',
        });
      };
      if (property === 'resolveAdapter') return async (...args: any[]) => withReadOnlyBridgeAdapter(await value.apply(target, args));
      return value.bind(receiver);
    },
  });
}
