// scripts/lib/mainnet-deployer-key.mjs
//
// Resolves MAINNET_DEPLOYER_KEY for the mainnet escrow deploy script. Key
// material is never logged or returned as text: only the derived signer
// address is compared with the pinned production deployer.
//
// Pure/offline: no RPC, no transactions. The deploy script decides whether the
// derived signer may broadcast (--execute); this module only derives and
// validates it, so read-only preflight can prove the key matches too.
import { Wallet } from 'ethers';

const PRIVATE_KEY_PATTERN = /^(0x)?[0-9a-f]{64}$/i;
export const DEPLOYER_KEY_MISMATCH = 'MAINNET_DEPLOYER_KEY does not match MAINNET_ESCROW_DEPLOYER.';
export const DEPLOYER_KEY_INVALID = 'MAINNET_DEPLOYER_KEY is invalid.';

export function resolveMainnetDeployerKey(rawKey, expectedDeployer) {
  if (!rawKey) return { signer: null, deployer: expectedDeployer, keyAddressMatches: null };
  if (!PRIVATE_KEY_PATTERN.test(rawKey)) throw new Error(DEPLOYER_KEY_INVALID);
  let signer;
  try { signer = new Wallet(rawKey); }
  catch { throw new Error(DEPLOYER_KEY_INVALID); }
  if (signer.address.toLowerCase() !== String(expectedDeployer).toLowerCase()) {
    throw new Error(DEPLOYER_KEY_MISMATCH);
  }
  return { signer, deployer: signer.address, keyAddressMatches: true };
}
