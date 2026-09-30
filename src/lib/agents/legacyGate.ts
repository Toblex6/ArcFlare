// src/lib/agents/legacyGate.ts
//
// Test-network agent gate (Step F) — single authority for the legacy-agent
// rule. AgentRegistry rows whose Circle wallet id the production key cannot
// find are flagged isLegacy (wallet ids are never changed by the flag).
//
// On mainnet, legacy agents: hide by default (discover), and refuse spend
// (treasury/*), deployment work (hire, deploy/recover re-link), and
// payments (pay, agentPay) with LEGACY_AGENT. Off-mainnet the flag is
// inert — testnet behavior is unchanged.

import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { getNetworkConfig } from "@/src/lib/config/network";

/** Exact user-facing copy for every legacy-agent refusal. */
export const LEGACY_AGENT_MESSAGE =
  "This agent was created on the test network. Create a new agent on Arc Mainnet.";

export class LegacyAgentError extends Error {
  status = 403;
  code = "LEGACY_AGENT";
  constructor() {
    super(LEGACY_AGENT_MESSAGE);
    this.name = "LegacyAgentError";
  }
}

/**
 * Pure refusal predicate (sync — no query). TRUE only on mainnet for a
 * flagged row. Null/flagless rows are never blocked (callers keep their
 * own not-found handling). Inert off-mainnet.
 */
export function isLegacyBlocked(
  row: { isLegacy?: boolean | null } | null | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!row || row.isLegacy !== true) return false;
  return getNetworkConfig(env).name === "mainnet";
}

/** 403 response with the exact legacy copy (routes return this directly). */
export function legacyAgentResponse(): NextResponse {
  return NextResponse.json(
    { success: false, code: "LEGACY_AGENT", error: LEGACY_AGENT_MESSAGE },
    { status: 403 }
  );
}

/**
 * Refuse a resolved agent row (sync — no query). Null rows pass (callers
 * keep their own not-found handling). Inert off-mainnet.
 */
export function assertAgentRowNotLegacy(
  row: { isLegacy?: boolean | null } | null | undefined,
  env: Record<string, string | undefined> = process.env
): void {
  if (isLegacyBlocked(row, env)) throw new LegacyAgentError();
}

/**
 * Refuse an agent by registry id (one indexed lookup, mainnet only —
 * off-mainnet this performs no query at all). For routes whose agent
 * selects prune the flag.
 */
export async function assertAgentIdNotLegacy(
  registryId: number,
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  if (getNetworkConfig(env).name !== "mainnet") return;
  if (!Number.isInteger(registryId)) return;
  const row = await (prisma as any).agentRegistry
    .findUnique({ where: { id: registryId }, select: { isLegacy: true } })
    .catch(() => null);
  assertAgentRowNotLegacy(row, env);
}

/**
 * Async id predicate (same rule, boolean). For routes that return their
 * own 403 response shape.
 */
export async function isLegacyBlockedId(
  registryId: number,
  env: Record<string, string | undefined> = process.env
): Promise<boolean> {
  if (getNetworkConfig(env).name !== "mainnet") return false;
  if (!Number.isInteger(registryId)) return false;
  const row = await (prisma as any).agentRegistry
    .findUnique({ where: { id: registryId }, select: { isLegacy: true } })
    .catch(() => null);
  return isLegacyBlocked(row, env);
}
