// src/lib/agents/resolveAgentRef.ts
// Central Agent identifier resolver (Track 2).
//
// ArcFlare has three distinct AgentRegistry identifiers that are NOT
// interchangeable:
//   - `id`         — internal database integer (canonical; ledger, track-record)
//   - `tokenId`    — ERC-8004 identity token, a string of digits, usually large
//                    (reputation, validation, agent cards)
//   - `scaAddress` — the agent's Circle SCA wallet address (0x…)
//
// This resolver exists so user-facing flows can accept a pasted/selected
// reference and land on the same canonical AgentRegistry record, WITHOUT
// silently guessing between unrelated formats. Callers must pass an explicit
// reference type; "auto" is reserved for genuinely user-facing paste fields
// (Economics ledger / Trust track-record) and never for internal services.
//
// Semantics:
//   - `id`         : strict small-integer DB id via findUnique. A large number
//                    that is not a real registry id simply returns null — it is
//                    never re-interpreted as a tokenId.
//   - `tokenId`    : exact string match on the unique tokenId. A numeric
//                    tokenId is NEVER treated as a database id.
//   - `scaAddress` : case-insensitive match (same semantics as
//                    resolveAgentIdBySca / reputation route).
//   - `auto`       : deterministic disambiguation only. Matches on id and
//                    tokenId are computed independently; if both hit different
//                    records the result is ambiguous and rejected (no silent
//                    guessing). A 0x-address routes to scaAddress.

import { prisma } from "@/lib/prisma";

export type AgentRefType = "id" | "tokenId" | "scaAddress" | "auto";

export interface ResolveAgentRefResult {
  agent: any | null;
  /** which reference type actually matched ("auto" reports the concrete one) */
  matchedBy: AgentRefType | null;
  /** true only for "auto" when both id and tokenId match different agents */
  ambiguous: boolean;
}

const SCA_RE = /^0x[a-fA-F0-9]{40}$/;
/**
 * DB ids are small autoincrement ints; ERC-8004 token ids on Arc are 6+ digit
 * big-ints. Guarding the id branch keeps a pasted tokenId from ever being
 * interpreted as a registry id in the auto path.
 */
const MAX_PLAUSIBLE_REGISTRY_ID = 1_000_000;

/**
 * Prisma maps `AgentRegistry.id` to Postgres INTEGER (signed int4, max 2^31-1).
 * The explicit-`id` branch must never hand an int4-overflowing (or non-safe)
 * integer to Prisma — a bare `Number.isInteger` guard lets values like
 * 3000000000 or a 30-digit tokenId reached it and Prisma would throw instead
 * of returning null. Bound to the int4 range so the never-throws contract
 * (clean not-found) holds. (The `auto` path separately bounds ids to
 * MAX_PLAUSIBLE_REGISTRY_ID, so it never reaches here out of range.)
 */
const INT4_MAX = 2_147_483_647;

function normalizeSca(value: string): string {
  return value.trim();
}

async function findById(rawId: string | number): Promise<any | null> {
  const id = typeof rawId === "number" ? rawId : Number(String(rawId).trim());
  if (!Number.isSafeInteger(id) || id <= 0 || id > INT4_MAX) return null;
  return (prisma as any).agentRegistry.findUnique({ where: { id } });
}

async function findByTokenId(tokenId: string | number): Promise<any | null> {
  const t = String(tokenId).trim();
  // tokenId is an ERC-8004 identity token — digits only. Reject 0x addresses
  // and anything non-numeric instead of letting Prisma coerce garbage.
  if (!/^\d+$/.test(t)) return null;
  return (prisma as any).agentRegistry.findUnique({ where: { tokenId: t } });
}

async function findBySca(sca: string): Promise<any | null> {
  const s = normalizeSca(sca);
  if (!SCA_RE.test(s)) return null;
  return (prisma as any).agentRegistry.findFirst({
    where: { scaAddress: { equals: s, mode: "insensitive" } },
  });
}

/**
 * Resolve a reference to the canonical AgentRegistry record.
 * Returns null agent (never throws) when the reference is unknown or
 * malformed, so callers can produce a clean 404 instead of a 500.
 */
export async function resolveAgentRef(
  ref: string | number | null | undefined,
  type: AgentRefType
): Promise<ResolveAgentRefResult> {
  const fail = (matchedBy: AgentRefType | null = null, ambiguous = false): ResolveAgentRefResult =>
    ({ agent: null, matchedBy, ambiguous });

  if (ref === null || ref === undefined) return fail();
  const raw = String(ref).trim();
  if (!raw) return fail();

  switch (type) {
    case "id": {
      const agent = await findById(raw);
      return agent ? { agent, matchedBy: "id", ambiguous: false } : fail("id");
    }

    case "tokenId": {
      const agent = await findByTokenId(raw);
      return agent ? { agent, matchedBy: "tokenId", ambiguous: false } : fail("tokenId");
    }

    case "scaAddress": {
      const agent = await findBySca(raw);
      return agent ? { agent, matchedBy: "scaAddress", ambiguous: false } : fail("scaAddress");
    }

    case "auto": {
      // Address-shaped → scaAddress, unambiguously.
      if (SCA_RE.test(raw)) {
        const agent = await findBySca(raw);
        return agent ? { agent, matchedBy: "scaAddress", ambiguous: false } : fail("scaAddress");
      }
      // Digits → could be a registry id or an ERC-8004 tokenId. Disambiguate
      // explicitly; if both match different records, refuse.
      if (!/^\d+$/.test(raw)) return fail();
      const asId = Number(raw);
      const byId =
        Number.isInteger(asId) && asId > 0 && asId <= MAX_PLAUSIBLE_REGISTRY_ID
          ? await findById(asId)
          : null;
      const byToken = await findByTokenId(raw);
      if (byId && byToken) {
        if (byId.id === byToken.id) return { agent: byId, matchedBy: "id", ambiguous: false };
        return fail("id", true); // ambiguous: same digits, two different agents
      }
      if (byId) return { agent: byId, matchedBy: "id", ambiguous: false };
      if (byToken) return { agent: byToken, matchedBy: "tokenId", ambiguous: false };
      return fail();
    }

    default:
      return fail();
  }
}
