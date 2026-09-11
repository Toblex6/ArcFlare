// src/lib/routing/providers/registry.ts
//
// Venue registry for swap providers — Phase 1 foundation.
//
// Rules (fail-closed):
// - The canonical pool path registers FIRST and is the ONLY venue enabled
//   by default. Canonical quoting still lives in src/lib/routing/quoter.ts;
//   this registry is NOT wired into /api/payments/quote yet, so canonical
//   behavior is byte-for-byte unchanged when provider flags are off.
// - New venues (`tower`, `unitflow-v3`) default DISABLED. They activate only
//   when their explicit env flag is set to "1" or "true" (case-insensitive).
// - Registering an unknown venueId throws.
// - Disabled venues are NEVER returned by getActiveProviders() and CANNOT be
//   selected via selectProvider() — selection fails closed.
// - No wallet, no execution, no transaction building in this module.

import { routingError } from '../canonical';
import {
  KNOWN_VENUE_IDS,
  notImplemented,
  type NormalizedProviderQuote,
  type QuoteContext,
  type SwapProvider,
  type SwapVenueId,
  type UnsignedExecution,
} from './types';

export { KNOWN_VENUE_IDS };
export type { SwapVenueId };

function isKnownVenueId(v: string): v is SwapVenueId {
  return (KNOWN_VENUE_IDS as readonly string[]).includes(v);
}

function flagOn(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Whether a venue is enabled. Canonical is always enabled. Every other
 * venue defaults OFF and requires its explicit opt-in flag:
 *   tower        -> ROUTING_PROVIDER_TOWER_ENABLED=1|true
 *   unitflow-v3  -> ROUTING_PROVIDER_UNITFLOW_V3_ENABLED=1|true
 */
export function isVenueEnabled(
  venueId: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (venueId === 'canonical') return true;
  if (venueId === 'tower') return flagOn(env.ROUTING_PROVIDER_TOWER_ENABLED);
  if (venueId === 'unitflow-v3') return flagOn(env.ROUTING_PROVIDER_UNITFLOW_V3_ENABLED);
  return false;
}

// ── Canonical stub (registration placeholder only) ──────────────────────────
// The live canonical path remains requestQuote() in ../quoter.ts. This stub
// exists so the registry's "canonical registers first, canonical is active
// by default" invariant is testable without touching live quoting. Its
// quote() explicitly directs callers to the live path and never prices.
class CanonicalProviderStub implements SwapProvider {
  readonly venueId: SwapVenueId = 'canonical';
  quote(_ctx: QuoteContext): Promise<NormalizedProviderQuote> {
    throw routingError(
      503,
      '[canonical] provider quote() is not wired in Phase 1 — use requestQuote() in src/lib/routing/quoter.ts.'
    );
  }
  buildExecution(): Promise<UnsignedExecution> {
    return Promise.reject(notImplemented('canonical', 'buildExecution()')) as Promise<UnsignedExecution>;
  }
  verifyExecution(): Promise<unknown> {
    return Promise.reject(notImplemented('canonical', 'verifyExecution()')) as Promise<unknown>;
  }
}

/** Venue registry: fail-closed registration + enabled-only selection. */
export class VenueRegistry {
  private readonly providers = new Map<SwapVenueId, SwapProvider>();

  /** Register a provider. Throws on unknown venueId. Re-registration replaces. */
  register(provider: SwapProvider): void {
    if (!provider || !isKnownVenueId(provider.venueId)) {
      throw routingError(
        400,
        `Unknown venue registration rejected: "${(provider as any)?.venueId ?? ''}". Known venues: ${KNOWN_VENUE_IDS.join(', ')}.`
      );
    }
    this.providers.set(provider.venueId, provider);
  }

  /** Active providers only — disabled venues are never returned. Canonical first. */
  getActiveProviders(env: Record<string, string | undefined> = process.env): SwapProvider[] {
    const out: SwapProvider[] = [];
    for (const venueId of KNOWN_VENUE_IDS) {
      const p = this.providers.get(venueId);
      if (!p) continue;
      if (!isVenueEnabled(venueId, env)) continue;
      out.push(p);
    }
    return out;
  }

  /**
   * Select a single provider by venueId. Fails closed: throws when the
   * venue is unknown, unregistered, or disabled.
   */
  selectProvider(
    venueId: string,
    env: Record<string, string | undefined> = process.env
  ): SwapProvider {
    if (!isKnownVenueId(venueId)) {
      throw routingError(
        400,
        `Unknown venue "${venueId}". Known venues: ${KNOWN_VENUE_IDS.join(', ')}.`
      );
    }
    const p = this.providers.get(venueId);
    if (!p) {
      throw routingError(503, `Venue "${venueId}" is not registered.`);
    }
    if (!isVenueEnabled(venueId, env)) {
      throw routingError(403, `Venue "${venueId}" is disabled (opt-in flag off).`);
    }
    return p;
  }

  /** Registered venue ids (in KNOWN_VENUE_IDS order), regardless of enabled state. */
  registeredVenues(): SwapVenueId[] {
    return KNOWN_VENUE_IDS.filter((v) => this.providers.has(v));
  }
}

/**
 * Create a registry with the canonical pool path registered FIRST.
 * Extra providers may be supplied; they stay inactive until their opt-in
 * flag is set (new venues default disabled).
 */
export function createVenueRegistry(extra: SwapProvider[] = []): VenueRegistry {
  const registry = new VenueRegistry();
  registry.register(new CanonicalProviderStub());
  for (const p of extra) registry.register(p);
  return registry;
}
