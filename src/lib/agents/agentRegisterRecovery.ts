// src/lib/agents/agentRegisterRecovery.ts
//
// Pure helpers for POST /api/agent/deploy/recover — the smallest safe recovery
// for the ERC-8004 "register succeeded but the server lost the response / could
// not recover the tokenId" window.
//
// The deploy route (src/app/api/agent/deploy/route.ts) is deliberately
// fail-closed there: it returns PENDING_IDENTITY_CONFIRMATION and persists NO
// AgentRegistry row (no fake tokenId, no ACTIVE row). This module gives the
// operation a way to recover the REAL identity from authoritative on-chain
// receipt logs — never from a request body.

// keccak256("Transfer(address,address,uint256)") — the canonical ERC-721/20
// Transfer event id emitted by the identity registry's _safeMint.
export const ERC721_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface RawReceiptLog {
  address: string;
  topics?: string[];
  data?: string;
}

export interface IdentityMint {
  /** the address that received the minted identity (now holds the ERC-721) */
  to: string;
  /** the real ERC-8004 tokenId, derived from chain data as a decimal string */
  tokenId: string;
}

/**
 * Scans a transaction's receipt logs for the registry's ERC-721 MINT
 * (Transfer with from = zero address → holder) and returns the identity ONLY
 * when it is unambiguous:
 *   - the emitting contract is exactly the identity registry,
 *   - the event is a MINT (from = zero address), not a later transfer,
 *   - the recipient is a well-formed 0x address,
 *   - the tokenId is a positive integer.
 * Anything else → null, and callers must refuse (never guess a tokenId).
 */
export function extractIdentityMintFromLogs(
  logs: RawReceiptLog[] | null | undefined,
  registryAddress: string
): IdentityMint | null {
  if (!Array.isArray(logs)) return null;
  const registry = registryAddress.toLowerCase();
  const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
  for (const log of logs) {
    if (!log || String(log.address).toLowerCase() !== registry) continue;
    const topics = (log.topics ?? []).map((t) => String(t).toLowerCase());
    // ERC-721 Transfer has 3 indexed args → [sig, from, to, tokenId].
    if (topics.length !== 4) continue;
    if (topics[0] !== ERC721_TRANSFER_TOPIC) continue;
    if (topics[1] !== ZERO) continue; // only a mint, never a later transfer
    const to = ("0x" + topics[2].slice(-40)).toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(to)) continue;
    let tokenId: string;
    try {
      const b = BigInt(topics[3]);
      if (b <= 0n) continue;
      tokenId = b.toString();
    } catch {
      continue;
    }
    return { to, tokenId };
  }
  return null;
}