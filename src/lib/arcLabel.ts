// src/lib/arcLabel.ts
//
// User-visible Arc network label for public copy (hero, footers, stats,
// docs). Dynamic by selected network so labels stay correct on mainnet:
//   mainnet → "Arc", anything else → "Arc Testnet".
//
// Display-only: never throws (a fail-closed config error must not break page
// rendering — money paths enforce configuration separately), and never used
// for chain selection, token resolution, or signing. Client-safe.
import { getNetworkConfig } from '@/lib/config/network';

export function arcLabel(): string {
  try {
    return getNetworkConfig().name === 'mainnet' ? 'Arc' : 'Arc Testnet';
  } catch {
    return 'Arc Testnet';
  }
}
