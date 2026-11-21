import { NextRequest, NextResponse } from 'next/server';
import { getCallerControlledAddresses, verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { resolveExactJobWallet } from '@/lib/jobs/flarehqEscrowActions';
import { checkRateLimit } from '@/lib/ratelimit';

// Read-only wallet choices. No caller-supplied address, payer fallback, wallet
// provisioning, secret ids, signing, or transaction execution in this route.
export async function GET(req: NextRequest) {
  const limit = await checkRateLimit(req, 'session');
  if (!limit.allowed) return limit.response as NextResponse;
  try {
    const addresses = await getCallerControlledAddresses(req);
    const wallets = [];
    for (const address of addresses) {
      const actor = await verifyCallerControlsAddress(req, address);
      if (!actor) continue;
      const exact = await resolveExactJobWallet(address);
      if (!exact) continue;
      wallets.push({ address: exact.address, mode: exact.mode, source: exact.source, actorType: actor.type });
    }
    return NextResponse.json({ success: true, wallets });
  } catch {
    return NextResponse.json({ success: false, error: 'Could not load your signed-in wallets.' }, { status: 503 });
  }
}
