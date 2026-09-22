// src/lib/bridge/irisNonce.ts
//
// SERVER-ONLY Circle Iris attested-nonce resolution for EXTERNAL bridges.
//
// Protocol fact (authoritative: Circle CCTP technical guide "CCTP V2 Nonces"
// + evm-cctp-contracts MessageV2._formatMessageForRelay + the ChainSecurity
// V2 audit): Circle assigns CCTP V2 message nonces OFFCHAIN. The
// MessageTransmitterV2 formats every outbound message with EMPTY_NONCE
// (bytes32 zeros) — the MessageSent event on the source chain therefore
// ALWAYS carries a zero nonce, for direct and forwarder flows alike (proven
// on-chain on Ethereum Sepolia burn 0x1b286af1… and Optimism Sepolia burn
// 0x459f2d90…, both emitting a zero nonce). The attesters fill the nonce
// (plus feeExecuted/expirationBlock/finalityThresholdExecuted) before
// signing, and the relayed message — the one MessageReceived carries on Arc
// — bears the assigned nonce (e.g. 0x139fcd… for the Optimism Sepolia burn
// above). Iris exposes it via GET /v2/messages/{sourceDomainId}
// ?transactionHash=0x… ("The nonce for each message in a transaction can be
// queried through the GET /v2/messages endpoint, using the transaction hash
// as a query parameter").
//
// Consequence: the burn↔mint binding nonce MUST come from Iris, never from
// decoding MessageSent. A zero/stored-sent nonce can never satisfy a genuine
// mint (receiveMessage even claims the 0-nonce at transmitter initialize
// time, so a zero-nonce relay is impossible on-chain).
//
// Trust model: Iris is used ONLY as Circle's nonce-assignment oracle for
// BINDING (which burn ↔ which attested nonce ↔ which mint hash). Validity
// is still proven from the on-chain receipts (receiveMessage verifies the
// attester signatures on-chain before MessageReceived is emitted; the mint
// verifier independently checks canonical transmitter, source domain,
// sender, body, MintAndWithdraw gross, and the net Transfer credit).
// Fail-closed throughout: unexpected shapes, pending attestations, and
// unreachable Iris are explicit failures, never silent fallbacks.

import { getNetworkConfig } from '@/lib/config/network';
import type { Hex } from 'viem';

if (typeof window !== 'undefined') {
  throw new Error('irisNonce is server-only (calls Circle Iris from server routes/scripts).');
}

/** The V2 EMPTY_NONCE placeholder — never a valid binding nonce. */
export const EMPTY_MESSAGE_NONCE = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export interface IrisBridgeMessage {
  ok: true;
  /** Circle's offchain-assigned bytes32 message nonce (non-zero 0x hex). */
  nonce: Hex;
  /** Arc mint tx Iris observed for forwarder-relayed messages (null when Iris reports none). */
  destinationMintTxHash: string | null;
  /** Forwarder relay tx (same as destinationMintTxHash on forwarder flows, null otherwise). */
  forwardTxHash: string | null;
}

export type IrisResolveFailureReason =
  | 'NOT_FOUND'
  | 'ATTESTATION_PENDING'
  | 'BINDING_MISMATCH'
  | 'IRIS_UNAVAILABLE';

export interface IrisResolveFailure {
  ok: false;
  reason: IrisResolveFailureReason;
  detail?: string;
}

const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const HEX_TX = /^0x[0-9a-fA-F]{64}$/;

function domainOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Pure Iris `GET /v2/messages` response parser (no fetch, no RPC, no DB —
 * unit-testable over injected payloads).
 *
 * Selects the single attested message for a burn bound to `arcDomain`:
 * exactly one domain-matching message must carry status 'complete'; its
 * Circle-assigned nonce (non-zero bytes32) is the burn↔mint binding key.
 */
export function parseIrisMessagesResponse(
  payload: unknown,
  arcDomain: number
): IrisBridgeMessage | IrisResolveFailure {
  const messages = (payload as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: 'NOT_FOUND', detail: 'Circle has no message for this burn yet.' };
  }
  const forArc = messages.filter((m) => domainOf((m as any)?.decodedMessage?.destinationDomain) === arcDomain);
  if (forArc.length === 0) {
    return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Circle reports no message to Arc for this burn.' };
  }
  const complete = forArc.filter((m) => (m as any)?.status === 'complete');
  if (complete.length === 0) {
    return { ok: false, reason: 'ATTESTATION_PENDING', detail: 'Circle has seen the burn but attestation is not complete yet.' };
  }
  if (complete.length > 1) {
    return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Circle reports multiple attested messages to Arc for this burn — refusing to guess.' };
  }
  const entry: any = complete[0];
  const nonce: unknown = entry?.decodedMessage?.nonce ?? entry?.nonce ?? entry?.eventNonce;
  if (typeof nonce !== 'string' || !HEX64.test(nonce) || nonce.toLowerCase() === EMPTY_MESSAGE_NONCE) {
    return { ok: false, reason: 'BINDING_MISMATCH', detail: 'Circle attested message carries no usable nonce.' };
  }
  const mintTx: unknown = entry?.destinationMintTxHash ?? null;
  const fwdTx: unknown = entry?.forwardTxHash ?? null;
  return {
    ok: true,
    nonce: nonce.toLowerCase() as Hex,
    destinationMintTxHash: typeof mintTx === 'string' && HEX_TX.test(mintTx) ? mintTx.toLowerCase() : null,
    forwardTxHash: typeof fwdTx === 'string' && HEX_TX.test(fwdTx) ? fwdTx.toLowerCase() : null,
  };
}

/**
 * Server-side Iris fetch for a source-chain burn hash. Never throws on
 * transport/parse failures — those are IRIS_UNAVAILABLE (retryable). Only
 * programmer/config errors (e.g. misconfigured network) throw.
 */
export async function fetchIrisBridgeMessage(params: {
  sourceDomain: number;
  burnTxHash: string;
}): Promise<IrisBridgeMessage | IrisResolveFailure> {
  const { sourceDomain, burnTxHash } = params;
  let base: string;
  try {
    base = getNetworkConfig().irisApiUrl.replace(/\/+$/, '');
  } catch (e) {
    return { ok: false, reason: 'IRIS_UNAVAILABLE', detail: 'Bridge network config unavailable.' };
  }
  const url = `${base}/messages/${sourceDomain}?transactionHash=${burnTxHash}`;
  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, reason: 'IRIS_UNAVAILABLE', detail: 'Circle Iris did not respond.' };
  }
  if (res.status === 404) {
    return { ok: false, reason: 'NOT_FOUND', detail: 'Circle has no message for this burn yet.' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'IRIS_UNAVAILABLE', detail: `Circle Iris responded with ${res.status}.` };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, reason: 'IRIS_UNAVAILABLE', detail: 'Circle Iris returned an unreadable response.' };
  }
  let arcDomain: number;
  try {
    arcDomain = getNetworkConfig().cctpDomain;
  } catch {
    return { ok: false, reason: 'IRIS_UNAVAILABLE', detail: 'Bridge network config unavailable.' };
  }
  return parseIrisMessagesResponse(payload, arcDomain);
}
