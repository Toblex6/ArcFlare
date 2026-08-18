// src/lib/env/walletEnvCheck.ts
//
// Fail-closed wallet/key configuration validation.
//
// Every env var that names a wallet address the app is expected to sign with
// must have a corresponding private key configured — and the key must actually
// derive that address. Otherwise the app refuses to start instead of silently
// proceeding until funds land in an unsignable address (the SELLER_WALLET_ADDRESS
// incident: 0.554 USDC stranded in a depositor whose address has no key).
//
// Hooks:
//   - src/instrumentation.ts → runs on every Next.js server start (nodejs).
//   - scripts/test-wallet-env-validation.ts → negative/positive test cases.
//
// Rules applied:
//   SIGNER_PAIRS   — address var + key var, key must derive the address.
//   KEY_ONLY       — key-only vars (address derived from the key) must be
//                    present, valid 32-byte hex, and not a placeholder.
//   DEPRECATED     — legacy address vars with no key are a hard error: remove
//                    them from the environment (they are dead fallbacks).
//   CUSTODY_WALLET — Circle-custody SCA vars (no private key expected; keys
//                    live with Circle). Only address format is checked.
//
// Placeholder detection: "YOUR_…" prefixes, "changeme", and near-zero keys.

import { Wallet } from "ethers";

export interface SignerPair {
  addressVar: string;
  keyVar: string;
  description: string;
}

export const SIGNER_PAIRS: SignerPair[] = [
  { addressVar: "SELLER_ADDRESS", keyVar: "SELLER_PRIVATE_KEY", description: "x402 seller gateway payTo (payroll/settlement)" },
  { addressVar: "BUYER_ADDRESS", keyVar: "BUYER_PRIVATE_KEY", description: "x402 payer / relayer EOA" },
];

export const KEY_ONLY: { keyVar: string; description: string }[] = [
  { keyVar: "EOA_PRIVATE_KEY", description: "relayer EOA (job escrow tests + gas sponsorship)" },
  { keyVar: "RELAYER_PRIVATE_KEY", description: "relayer EOA (payroll/escrow/x402 settlement)" },
  { keyVar: "ARC_ADMIN_PRIVATE_KEY", description: "admin signer (settlement, CCTP, agent pay)" },
  { keyVar: "ESCROW_ADMIN_PRIVATE_KEY", description: "escrow admin signer (dispute resolution)" },
  { keyVar: "PRIVATE_KEY", description: "hardhat deployer / generic signer" },
];

export const DEPRECATED_UNKEYED_SIGNER_VARS: { addressVar: string; description: string }[] = [
  { addressVar: "SELLER_WALLET_ADDRESS", description: "legacy x402 seller payTo — no private key exists; use SELLER_ADDRESS" },
];

export const CUSTODY_WALLET_VARS: string[] = [
  "AGENT_OWNER_WALLET_ADDRESS",
  "AGENT_VALIDATOR_WALLET_ADDRESS",
];

const HEX_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PLACEHOLDER_RE = /^(0x)?(YOUR_|CHANGE|changeme|0000+)/;

function isValidKey(key: string | undefined): boolean {
  if (!key) return false;
  if (!HEX_KEY_RE.test(key)) return false;
  if (PLACEHOLDER_RE.test(key)) return false;
  return true;
}

export interface WalletEnvValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateWalletEnv(env: Record<string, string | undefined> = process.env): WalletEnvValidationResult {
  const errors: string[] = [];

  for (const { addressVar, keyVar, description } of SIGNER_PAIRS) {
    const address = env[addressVar];
    const key = env[keyVar];

    if (!address || !ADDRESS_RE.test(address)) {
      errors.push(`${addressVar}: missing or invalid address (${description})`);
      continue;
    }
    if (!isValidKey(key)) {
      errors.push(`${addressVar}: ${keyVar} is missing, invalid, or a placeholder (${description})`);
      continue;
    }

    let derived: string;
    try {
      derived = new Wallet(key as string).address;
    } catch {
      errors.push(`${addressVar}: ${keyVar} is not a valid private key (${description})`);
      continue;
    }
    if (derived.toLowerCase() !== address.toLowerCase()) {
      errors.push(
        `${addressVar} does not match ${keyVar}: configured ${address}, but the key derives ${derived} (${description})`
      );
    }
  }

  for (const { keyVar, description } of KEY_ONLY) {
    if (!isValidKey(env[keyVar])) {
      errors.push(`${keyVar}: missing, invalid, or placeholder (${description})`);
    }
  }

  for (const { addressVar, description } of DEPRECATED_UNKEYED_SIGNER_VARS) {
    if (env[addressVar]) {
      errors.push(`${addressVar}: deprecated signer address with NO private key (${description}). Remove it from the environment.`);
    }
  }

  for (const varName of CUSTODY_WALLET_VARS) {
    const value = env[varName];
    if (value && !ADDRESS_RE.test(value)) {
      errors.push(`${varName}: invalid address format (Circle-custody SCA, no private key expected)`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertWalletEnv(env: Record<string, string | undefined> = process.env): void {
  const result = validateWalletEnv(env);
  if (!result.ok) {
    throw new Error(
      "Fail-closed wallet/key configuration error — refusing to start.\n" +
        "Fix these before running:\n  - " +
        result.errors.join("\n  - ")
    );
  }
}
