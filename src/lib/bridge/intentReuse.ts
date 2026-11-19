// Serialize identical requests across tabs/processes without a schema change.
// No signing, chain writes or payer fallback. The authenticated route resolves
// every tuple field before calling this helper.
export class BridgeIntentConflictError extends Error {
  readonly status = 409;
  readonly code = 'INTENT_STATE_CONFLICT';
  constructor() {
    super('This bridge reference does not match the current wallet, amount, source or destination. Recover the original bridge before starting another.');
  }
}

export interface BridgeIntentRequest {
  sourceWallet: string;
  destination: string;
  sourceChain: string;
  amount: string;
  reference?: string;
  /** Explicit pre-burn retry; never renew a funded or terminal intent. */
  renewSubmission?: boolean;
}

export async function reserveBridgeIntent(db: any, request: BridgeIntentRequest, now = new Date()) {
  const { sourceWallet, destination, sourceChain, amount, reference, renewSubmission } = request;
  return db.$transaction(async (tx: any) => {
    const lockKey = `external-bridge:${sourceWallet.toLowerCase()}:${sourceChain}:${destination.toLowerCase()}:${amount}`;
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', lockKey);
    const tuple = {
      sourceWallet: { equals: sourceWallet, mode: 'insensitive' },
      destination: { equals: destination, mode: 'insensitive' },
      sourceChain,
      amount,
    };
    let intent: any;
    if (reference) {
      intent = await tx.flowBridgeIntent.findUnique({ where: { id: reference } });
      if (!intent || intent.sourceWallet.toLowerCase() !== sourceWallet.toLowerCase() ||
          intent.destination.toLowerCase() !== destination.toLowerCase() || intent.sourceChain !== sourceChain || intent.amount !== amount) {
        throw new BridgeIntentConflictError();
      }
    } else {
      // Always prefer the already-funded bridge, even after its submission TTL.
      intent = await tx.flowBridgeIntent.findFirst({
        where: { ...tuple, status: 'BURN_CONFIRMED' }, orderBy: { createdAt: 'desc' },
      }) ?? await tx.flowBridgeIntent.findFirst({
        // Expiry does not prove that a vanished browser never submitted a
        // burn. Return the same reference for explicit review/recovery.
        where: { ...tuple, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (intent) {
      if (reference && renewSubmission && intent.status === 'PENDING' && !intent.burnTxHash && new Date(intent.expiresAt) <= now) {
        const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        const claim = await tx.flowBridgeIntent.updateMany({
          where: { id: intent.id, status: 'PENDING', burnTxHash: null }, data: { expiresAt },
        });
        if (claim.count !== 1) throw new BridgeIntentConflictError();
        intent = { ...intent, expiresAt };
      }
      return { intent, reused: true };
    }
    intent = await tx.flowBridgeIntent.create({ data: {
      sourceWallet, destination, sourceChain, amount, status: 'PENDING',
      expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    } });
    return { intent, reused: false };
  });
}
