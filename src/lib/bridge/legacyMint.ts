// Legacy admin-key CCTP redemption is testnet-only. This selector-only gate
// runs before DB claims, attestation polling, or resolving any private key.
import { getArcNetworkName } from '@/lib/config/network';

export class LegacyCctpMintUnavailableError extends Error {
  readonly code = 'cctp_legacy_mint_unavailable';
  readonly status = 503;
  constructor() {
    super('Legacy admin-key CCTP minting is unavailable on Arc Mainnet. The external Bridge Kit flow is separate and has not yet been verified end to end.');
    this.name = 'LegacyCctpMintUnavailableError';
  }
}

export function requireLegacyCctpMint(): void {
  if (getArcNetworkName() === 'mainnet') throw new LegacyCctpMintUnavailableError();
}

export function legacyCctpMintUnavailableBody() {
  const error = new LegacyCctpMintUnavailableError();
  return { success: false, code: error.code, error: error.message };
}
