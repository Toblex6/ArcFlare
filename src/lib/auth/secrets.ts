// src/lib/auth/secrets.ts
// Single source of truth for JWT secrets. There is no fallback value: if an
// env secret is missing, verification fails closed (null -> 401) and
// token issuance throws (no token can be minted with a predictable secret).

import { TextEncoder } from 'util';

const MIN_SECRET_LENGTH = 32;

export function requireJwtSecret(name: string): Uint8Array {
  const value = process.env[name];
  if (!value || value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT secret ${name} is not configured (min ${MIN_SECRET_LENGTH} chars). ` +
        'Set it in the environment before issuing tokens.'
    );
  }
  return new TextEncoder().encode(value);
}

export function tryJwtSecret(name: string): Uint8Array | null {
  const value = process.env[name];
  if (!value || value.length < MIN_SECRET_LENGTH) return null;
  return new TextEncoder().encode(value);
}