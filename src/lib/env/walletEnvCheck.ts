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
  // NOTE: PRIVATE_KEY is deliberately NOT required here — it is a deploy-time
  // variable consumed only by hardhat.config.js and scripts/deploy-*.mjs, which
  // never run inside the Next.js server. Requiring it at startup broke hosting
  // deploys that legitimately don't carry a deployer key.
];

export const DEPRECATED_UNKEYED_SIGNER_VARS: { addressVar: string; description: string }[] = [
  { addressVar: "SELLER_WALLET_ADDRESS", description: "legacy x402 seller payTo — no private key exists; use SELLER_ADDRESS" },
];

export const CUSTODY_WALLET_VARS: string[] = [
  "AGENT_OWNER_WALLET_ADDRESS",
  "AGENT_VALIDATOR_WALLET_ADDRESS",
];

// ── M10: secrets + contract configuration ─────────────────────────────────────
// Hard failures (the app is broken without them). Format checks are cheap
// and catch paste errors (truncated keys, addresses with the wrong length,
// secrets shipped as "changeme").
export const REQUIRED_SECRETS: { keyVar: string; description: string; minLen?: number }[] = [
  { keyVar: "X402_WALLET_ENCRYPTION_KEY", description: "AES-GCM key for agent payment EOAs at rest", minLen: 32 },
  { keyVar: "CONSUMER_JWT_SECRET", description: "consumer session token signing", minLen: 32 },
  { keyVar: "MERCHANT_JWT_SECRET", description: "merchant session token signing", minLen: 32 },
  { keyVar: "INTERNAL_SETTLEMENT_API_KEY", description: "internal service-to-service settlements", minLen: 16 },
  { keyVar: "TELEGRAM_BOT_TOKEN", description: "Telegram bot (withdraw confirmations)", minLen: 32 },
  { keyVar: "TELEGRAM_WEBHOOK_SECRET", description: "Telegram webhook HMAC verification", minLen: 16 },
];

export const REQUIRED_CONTRACT_ADDRESSES: { addressVar: string; description: string }[] = [
  { addressVar: "PAYROLL_CONTRACT_ADDRESS", description: "ArcFlarePayroll" },
  { addressVar: "SPEND_LIMIT_CONTRACT_ADDRESS", description: "ArcFlareSpendLimit" },
  { addressVar: "SWAP_POOL_CONTRACT_ADDRESS", description: "ArcFlareSwapPool" },
  { addressVar: "JOB_ESCROW_CONTRACT_ADDRESS", description: "job escrow" },
  { addressVar: "ARC_FLARE_STREAM_CONTRACT_ADDRESS", description: "ArcFlareStream (nanopayments)" },
];

export const OPTIONAL_ADDRESS_LISTS: { listVar: string; description: string }[] = [
  { listVar: "SELLER_GATEWAY_TREASURY_ADDRESSES", description: "seller-gateway withdraw allowlist" },
];

export const REQUIRED_CIRCLE_CREDS: { keyVar: string; description: string }[] = [
  { keyVar: "CIRCLE_API_KEY", description: "Circle API" },
  { keyVar: "CIRCLE_WALLET_SET_ID", description: "Circle wallet set" },
  { keyVar: "CIRCLE_ENTITY_SECRET", description: "Circle entity secret" },
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

  // M10 — hard-fail on missing/placeholder secrets, malformed contract
  // addresses, and malformed allowlist entries.
  for (const { keyVar, description, minLen } of REQUIRED_SECRETS) {
    const value = env[keyVar];
    if (!value || PLACEHOLDER_RE.test(value) || (minLen && value.length < minLen)) {
      errors.push(`${keyVar}: missing, placeholder, or too short (${description})`);
    }
  }

  for (const { addressVar, description } of REQUIRED_CONTRACT_ADDRESSES) {
    const value = env[addressVar];
    if (!value || !ADDRESS_RE.test(value)) {
      errors.push(`${addressVar}: missing or invalid address (${description})`);
    }
  }

  for (const { listVar, description } of OPTIONAL_ADDRESS_LISTS) {
    const value = env[listVar];
    if (!value) continue;
    const entries = value.split(",").map((s) => s.trim()).filter(Boolean);
    if (entries.length === 0) {
      errors.push(`${listVar}: empty allowlist (${description})`);
      continue;
    }
    const bad = entries.filter((e) => !ADDRESS_RE.test(e));
    if (bad.length > 0) {
      errors.push(`${listVar}: invalid allowlist entries (${description}): ${bad.join(", ")}`);
    }
  }

  for (const { keyVar, description } of REQUIRED_CIRCLE_CREDS) {
    const value = env[keyVar];
    if (!value || PLACEHOLDER_RE.test(value) || value.length < 16) {
      errors.push(`${keyVar}: missing or placeholder (${description})`);
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
