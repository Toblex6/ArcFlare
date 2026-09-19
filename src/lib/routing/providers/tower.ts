// src/lib/routing/providers/tower.ts
//
// Tower swap quote client — Phase 1 (quote only, no execution).
//
// SERVER-ONLY MODULE: the Tower API key lives in process.env and must never
// reach client code. Importing this module in a browser bundle throws.
//
// Allowed endpoints:
//   GET  /api/public/swap/dexes   (venue catalog)
//   POST /api/public/swap/quote   (optimal quote)
// Explicitly NOT allowed in Phase 1:
//   /api/public/swap/build-tx, transaction creation, wallet interaction.
//
// Every Tower response field is UNTRUSTED provider input: token identity and
// amounts are validated and parsed through normalize.ts (canonical 6-dec
// Arc base units; mismatched decimals claims are rejected, never coerced).
//
// Tower docs note (docs.tower.exchange, Get Optimal Swap Quote): the example
// response annotates outputAmount as "(18 decimals for EURC)" even though
// USDC/EURC are 6 decimals on Arc. The quote response carries NO decimals
// field, so Phase 1 passes NO decimals claim into normalize() (canonical
// resolution is authoritative). Phase 2 must re-verify Tower's actual unit
// convention live before any execution use — no silent rescaling here.

import { getTokenBySymbol } from '../../tokens/supportedTokens';
import { routingError } from '../canonical';
import { normalizeProviderQuote } from './normalize';
import {
  notImplemented,
  type NormalizedProviderQuote,
  type QuoteContext,
  type SwapProvider,
  type UnsignedExecution,
} from './types';

/** Tower Developer API base (docs curl examples use www.tower.exchange). */
export const TOWER_SWAP_BASE_URL_DEFAULT = 'https://www.tower.exchange';

export interface TowerSwapConfig {
  baseUrl: string;
  apiKey: string;
}

/** Resolve Tower config — server-side only, fails closed without an API key. */
export function getTowerConfig(
  env: Record<string, string | undefined> = process.env
): TowerSwapConfig {
  if (typeof window !== 'undefined') {
    throw routingError(500, '[tower] Tower client is server-only — API credentials must never load in the browser.');
  }
  const apiKey = (env.TOWER_SWAP_API_KEY ?? '').trim();
  if (!apiKey) {
    throw routingError(503, '[tower] Tower quoting is not configured (TOWER_SWAP_API_KEY missing).');
  }
  const baseUrl = ((env.TOWER_SWAP_BASE_URL ?? '').trim() || TOWER_SWAP_BASE_URL_DEFAULT).replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl)) {
    throw routingError(503, '[tower] Tower base URL must be https (TOWER_SWAP_BASE_URL).');
  }
  return { baseUrl, apiKey };
}

function towerHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

/** Per-attempt timeout for Tower fetches (Tower is normally sub-second when
 * healthy; 15s already exceeds the 8–10s reasonable ceiling — the prod
 * aborts at 15s because Tower's origin hangs ~16s before returning 502,
 * not because the ceiling is too low). */
export const TOWER_FETCH_TIMEOUT_MS = 15_000;
/** One retry with backoff on network/timeout/5xx only (never on 4xx). */
export const TOWER_FETCH_MAX_ATTEMPTS = 2;
const TOWER_FETCH_RETRY_DELAY_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function towerFetchJson(url: string, init: RequestInit): Promise<any> {
  // Temporary diagnostic: log raw HTTP status per Tower call without ever
  // logging the API key value (headers are never printed).
  let path = url;
  let host = 'unknown-host';
  try {
    const u = new URL(url);
    path = u.pathname;
    host = u.host;
  } catch {
    /* keep raw url as path fallback */
  }
  const method = String((init as any)?.method ?? 'GET').toUpperCase();
  // One retry with backoff on network/timeout errors and HTTP 5xx (transient
  // origin failures). 4xx fails closed immediately — retrying a rejected
  // request cannot succeed and only adds origin load.
  let lastError: any = null;
  for (let attempt = 1; attempt <= TOWER_FETCH_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: (init as any)?.signal ?? AbortSignal.timeout(TOWER_FETCH_TIMEOUT_MS) });
    } catch (e: any) {
      lastError = routingError(503, `[tower] Tower request failed: ${e?.message ?? e}`);
      console.error(`[tower-diag] towerFetch ${method} ${host}${path} network-error attempt=${attempt}/${TOWER_FETCH_MAX_ATTEMPTS} message=${String(e?.message ?? e).slice(0, 160)}`);
      if (attempt < TOWER_FETCH_MAX_ATTEMPTS) await sleep(TOWER_FETCH_RETRY_DELAY_MS * attempt);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    const bodySuccess = (body as any)?.success;
    if (!res.ok || bodySuccess === false) {
      const rawStatus = res.status;
      const errSnippet =
        typeof (body as any)?.error === 'string' ? String((body as any).error).slice(0, 120) : '';
      // Keep the raw upstream HTTP status in both the log line and the thrown
      // message so getTowerCandidate()'s truncated note still carries it.
      console.error(
        `[tower-diag] towerFetch ${method} ${host}${path} -> HTTP ${rawStatus} success=${String(bodySuccess)} attempt=${attempt}/${TOWER_FETCH_MAX_ATTEMPTS}` +
          (errSnippet ? ` error=${errSnippet}` : '')
      );
      const msg = errSnippet ? `HTTP ${rawStatus} ${errSnippet}` : `HTTP ${rawStatus}`;
      const status = rawStatus === 404 ? 503 : rawStatus >= 500 ? 503 : 400;
      lastError = routingError(status, `[tower] Tower quote unavailable: ${msg}`);
      // Retry server-side failures (5xx); client errors (4xx) fail closed now.
      if (res.status >= 500 && attempt < TOWER_FETCH_MAX_ATTEMPTS) {
        await sleep(TOWER_FETCH_RETRY_DELAY_MS * attempt);
        continue;
      }
      throw lastError;
    }
    console.log(`[tower-diag] towerFetch ${method} ${host}${path} -> HTTP ${res.status} ok attempt=${attempt}/${TOWER_FETCH_MAX_ATTEMPTS}`);
    return body;
  }
  throw lastError ?? routingError(503, '[tower] Tower request failed: retry exhausted');
}

/** Minimal Tower DEX catalog entry (all fields untrusted except presence of id). */
export interface TowerDexInfo {
  id: string;
  name?: string;
  routerAddress?: string;
  factoryAddress?: string;
  quoterAddress?: string;
  type?: string;
  chainId?: number;
  enabled?: boolean;
  supportedTokens?: string[];
}

/** GET /api/public/swap/dexes — venue catalog (quote-path discovery only). */
export async function listTowerDexes(
  env: Record<string, string | undefined> = process.env
): Promise<TowerDexInfo[]> {
  const { baseUrl, apiKey } = getTowerConfig(env);
  const body = await towerFetchJson(`${baseUrl}/api/public/swap/dexes`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = (body as any)?.data;
  if (!Array.isArray(data)) throw routingError(503, '[tower] Tower dexes response malformed (data is not an array).');
  return data
    .filter((d: any) => d && typeof d.id === 'string' && d.id.trim() !== '')
    .map((d: any) => ({
      id: String(d.id),
      ...(typeof d.name === 'string' ? { name: d.name } : {}),
      ...(typeof d.routerAddress === 'string' ? { routerAddress: d.routerAddress } : {}),
      ...(typeof d.factoryAddress === 'string' ? { factoryAddress: d.factoryAddress } : {}),
      ...(typeof d.quoterAddress === 'string' ? { quoterAddress: d.quoterAddress } : {}),
      ...(typeof d.type === 'string' ? { type: d.type } : {}),
      ...(typeof d.chainId === 'number' ? { chainId: d.chainId } : {}),
      ...(typeof d.enabled === 'boolean' ? { enabled: d.enabled } : {}),
      ...(Array.isArray(d.supportedTokens) ? { supportedTokens: d.supportedTokens.filter((t: any) => typeof t === 'string') } : {}),
    }));
}

export interface TowerQuoteRequest {
  inputSymbol: 'USDC' | 'EURC' | 'CIRBTC';
  outputSymbol: 'USDC' | 'EURC' | 'CIRBTC';
  /** Exact input in canonical Arc base units (token-native precision). */
  inputAmount: bigint;
  slippageBps?: number;
}

/**
 * POST /api/public/swap/quote — optimal Tower quote, normalized to canonical
 * Arc base units. Tower's echoed token addresses/amounts are cross-checked
 * against the request before normalization; anything unexpected throws.
 */
export async function requestTowerQuote(
  req: TowerQuoteRequest,
  env: Record<string, string | undefined> = process.env
): Promise<NormalizedProviderQuote> {
  if (req.inputSymbol === req.outputSymbol) {
    throw routingError(400, '[tower] Tower quote requires distinct input/output tokens.');
  }
  if (req.inputAmount <= 0n) throw routingError(400, '[tower] Tower quote input must be positive.');
  const { baseUrl, apiKey } = getTowerConfig(env);
  const inputToken = getTokenBySymbol(req.inputSymbol);
  const outputToken = getTokenBySymbol(req.outputSymbol);

  const body = await towerFetchJson(`${baseUrl}/api/public/swap/quote`, {
    method: 'POST',
    headers: towerHeaders(apiKey),
    body: JSON.stringify({
      inputToken: inputToken.address,
      outputToken: outputToken.address,
      inputAmount: req.inputAmount.toString(),
      ...(req.slippageBps !== undefined ? { slippageTolerance: req.slippageBps } : {}),
    }),
  });
  const data = (body as any)?.data;
  if (!data || typeof data !== 'object') throw routingError(503, '[tower] Tower quote response malformed (missing data).');

  // Cross-check Tower's echo against the request — untrusted provider input
  // must not substitute tokens or amounts.
  const eqAddr = (a: any, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!eqAddr(data.inputToken, inputToken.address)) {
    throw routingError(400, '[tower] Tower quote input token does not match the requested token.');
  }
  if (!eqAddr(data.outputToken, outputToken.address)) {
    throw routingError(400, '[tower] Tower quote output token does not match the requested token.');
  }
  if (String(data.inputAmount ?? '').trim() !== req.inputAmount.toString()) {
    throw routingError(400, '[tower] Tower quote input amount does not match the requested amount.');
  }

  // NOTE: Tower's quote payload carries no decimals fields, so no decimals
  // claims are forwarded — normalize() resolves canonical 6-dec identity
  // authoritatively. Any future Tower decimals claim MUST be forwarded and
  // will be rejected on mismatch (never coerced).
  return normalizeProviderQuote({
    venueId: 'tower',
    inputToken: String(data.inputToken),
    outputToken: String(data.outputToken),
    inputAmount: String(data.inputAmount),
    outputAmount: String(data.outputAmount ?? ''),
    ...(data.minOut !== undefined && data.minOut !== null && String(data.minOut).trim() !== ''
      ? { minOut: String(data.minOut) }
      : {}),
  });
}

/** Tower SwapProvider — quote only in Phase 1; execution stubs throw. */
export class TowerProvider implements SwapProvider {
  readonly venueId = 'tower' as const;
  quote(ctx: QuoteContext): Promise<NormalizedProviderQuote> {
    return requestTowerQuote({
      inputSymbol: ctx.inputSymbol,
      outputSymbol: ctx.outputSymbol,
      inputAmount: ctx.inputAmount,
      ...(ctx.slippageBps !== undefined ? { slippageBps: ctx.slippageBps } : {}),
    });
  }
  buildExecution(): Promise<UnsignedExecution> {
    return Promise.reject(notImplemented('tower', 'buildExecution()')) as Promise<UnsignedExecution>;
  }
  verifyExecution(): Promise<unknown> {
    return Promise.reject(notImplemented('tower', 'verifyExecution()')) as Promise<unknown>;
  }
}
