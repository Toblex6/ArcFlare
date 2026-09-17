// src/lib/bridge/externalDestination.ts
//
// SERVER-ONLY destination resolution for EXTERNAL bridges.
//
// The browser must never be authoritative for where bridged funds land.
// The destination is always the authenticated consumer's EXISTING FlareHQ
// CIRCLE wallet on Arc, resolved server-side:
//
//   EXTERNAL session row --linkedCircleAddress--> CIRCLE row (bound
//   circleWalletId) --> its walletAddress.
//
// The link is written ONLY by the server when it provisions that CIRCLE
// wallet from the EXTERNAL session (POST /api/consumer/flare-wallet) —
// there is no browser-writable path to it, and it is not a wallet-set
// binding (no walletSetId anywhere in this model).
//
// When no valid link exists the caller fails closed with the recoverable
// CIRCLE_WALLET_UNBOUND code — never an invented wallet, never a shared
// wallet, never a browser address.

import { prisma } from '@/src/lib/prisma';

export async function resolveExternalBridgeDestination(
  sessionAccount: any
): Promise<
  | { ok: true; destination: string; circleWalletId: string }
  | { ok: false; code: 'CIRCLE_WALLET_UNBOUND'; reason: 'NO_LINKED_CIRCLE_WALLET'; error: string }
> {
  const unbound = (error: string) =>
    ({
      ok: false as const,
      code: 'CIRCLE_WALLET_UNBOUND' as const,
      reason: 'NO_LINKED_CIRCLE_WALLET' as const,
      error,
    });
  const linked =
    typeof sessionAccount?.linkedCircleAddress === 'string'
      ? sessionAccount.linkedCircleAddress.trim()
      : '';
  if (!linked || !/^0x[0-9a-fA-F]{40}$/.test(linked)) {
    return unbound(
      'No FlareHQ wallet is linked to this wallet yet. Create your free FlareHQ wallet below to receive bridged funds.'
    );
  }
  const circle = await (prisma as any).consumerAccount.findUnique({
    where: { walletAddress: linked },
  });
  if (
    !circle ||
    String(circle.walletType ?? '').toUpperCase() !== 'CIRCLE' ||
    typeof circle.circleWalletId !== 'string' ||
    !circle.circleWalletId
  ) {
    return unbound(
      'The linked FlareHQ wallet is no longer available. Create a new FlareHQ wallet below to receive bridged funds.'
    );
  }
  return { ok: true, destination: circle.walletAddress, circleWalletId: circle.circleWalletId };
}
