// src/lib/arcLabel.ts
//
// User-visible Arc network label for public copy (hero, footers, stats,
// docs). Dynamic by selected network so labels stay correct on mainnet:
//   mainnet → "Arc", anything else → "Arc Testnet".
//
// Display-only: never throws (a fail-closed config error must not break page
// rendering — money paths enforce configuration separately), and never used
// for chain selection, token resolution, or signing. Client-safe.
//
// PRODUCTION SAFETY: the fallback is the production label ("Arc"), never a
// test label. The browser bundle can only see NEXT_PUBLIC_ARC_NETWORK
// (build-time); when the server runs ARC_NETWORK=mainnet but the client was
// built without the public variable, getNetworkConfig() on the client
// resolves to testnet (or throws on a misconfigured mainnet) — both cases
// must render the production-safe label, never "Arc Testnet". The
// server-resolved label is available at runtime via useArcLabel() from
// src/components/NetworkContext.tsx (backed by GET /api/network);
// this sync helper keeps its safe default for SSR/first-paint.
import { getNetworkConfig } from '@/lib/config/network';

export function arcLabel(): string {
  try {
    return getNetworkConfig().name === 'mainnet' ? 'Arc' : 'Arc Testnet';
  } catch {
    return 'Arc';
  }
}
