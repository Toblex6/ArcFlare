// scripts/register-recovery-tests.ts
//
// Focused tests for POST /api/agent/deploy/recover (Subtask C — ERC-8004
// tx-hash recovery). Two layers, following the repo's established conventions:
//   (1) real unit tests of the pure on-chain identity extractor
//       (src/lib/agents/agentRegisterRecovery.ts) — no DB/network/server,
//   (2) static source proofs on the recover route proving the security
//       requirements are actually present (same style as
//       tests/deploy-identity.test.mjs, because the endpoint pulls heavy deps
//       — next/server, Prisma, viem, middleware).
//
// Run: npx tsx scripts/register-recovery-tests.ts

import fs from "node:fs";
import path from "node:path";
import { extractIdentityMintFromLogs, ERC721_TRANSFER_TOPIC } from "../src/lib/agents/agentRegisterRecovery";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} — ${detail}`); fail++; }
}

// ── synthetic-log helpers ─────────────────────────────────────────────────────
const REG = "0x" + "8".repeat(40);
const ZERO_TOPIC = "0x" + "0".repeat(64);
function padTopic(hex: string): string {
  return "0x" + hex.replace(/^0x/, "").padStart(64, "0");
}
function addrTopic(addr: string): string {
  return padTopic(addr.toLowerCase());
}
function mintLog(to: string, tokenId: bigint, opts: Partial<{ addr: string; from: string }> = {}) {
  return {
    address: opts.addr ?? REG,
    topics: [ERC721_TRANSFER_TOPIC, opts.from ?? ZERO_TOPIC, addrTopic(to), padTopic(BigInt(tokenId).toString(16))],
    data: "0x",
  };
}

// ── Layer 1: pure extractor unit tests ────────────────────────────────────────
function layer1() {
  console.log("\n[1] extractIdentityMintFromLogs (pure)");
  const holder = "0x1111111111111111111111111111111111111111";

  const found = extractIdentityMintFromLogs([mintLog(holder, 42n)], REG);
  ok("recognizes a registry mint (from=zero) → holder + tokenId",
    !!found && found.to === holder && found.tokenId === "42",
    JSON.stringify(found));

  const transferLog = mintLog(holder, 42n, { from: addrTopic("0x2222222222222222222222222222222222222222") });
  ok("ignores a later Transfer (from != zero) — only mints recover identities",
    extractIdentityMintFromLogs([transferLog], REG) === null);

  ok("ignores logs from a different contract",
    extractIdentityMintFromLogs([mintLog(holder, 42n, { addr: "0x9999999999999999999999999999999999999999" })], REG) === null);

  ok("null/undefined logs → null", extractIdentityMintFromLogs(null, REG) === null);
  ok("empty logs → null", extractIdentityMintFromLogs([], REG) === null);
  ok("non-Transfer event id → null",
    extractIdentityMintFromLogs([mintLog(holder, 1n)].map((l) => ({ ...l, topics: ["0x0000000000000000000000000000000000000000000000000000000000000000", l.topics![1], l.topics![2], l.topics![3]] })), REG) === null);
  ok("wrong topic count (3 topics) → null",
    extractIdentityMintFromLogs([{ address: REG, topics: [ERC721_TRANSFER_TOPIC, ZERO_TOPIC, addrTopic(holder)] }], REG) === null);
  ok("zero tokenId → null (must be a positive integer)",
    extractIdentityMintFromLogs([mintLog(holder, 0n)], REG) === null);
  ok("malformed recipient topic → null",
    extractIdentityMintFromLogs([{ address: REG, topics: [ERC721_TRANSFER_TOPIC, ZERO_TOPIC, "0x123", padTopic("5")] }], REG) === null);
}
// ── Layer 2: static security proofs on the recover route ──────────────────────
function layer2() {
  console.log("\n[2] POST /api/agent/deploy/recover static security proofs");
  const routePath = path.join(process.cwd(), "src/app/api/agent/deploy/recover/route.ts");
  const src = fs.readFileSync(routePath, "utf8");

  // 1. Merchant authentication required.
  ok("route is wrapped in withMerchantAuth", src.includes("withMerchantAuth(recoverAgentHandler"));

  // 2. txHash is the required recovery identifier, validated.
  ok("txHash is required (body.txHash)", src.includes("body?.txHash"));
  ok("txHash validated as 0x 64-hex", src.includes("TX_HASH_RE.test(txHash)"));

  // 3/4. Identity derived from authoritative on-chain receipt logs, not the body.
  ok("fetches on-chain receipt (getTransactionReceipt)", src.includes("getTransactionReceipt"));
  ok("derives identity from receipt logs via the pure extractor", src.includes("extractIdentityMintFromLogs(receipt.logs"));
  ok("does NOT accept a body-supplied tokenId", !src.includes("body?.tokenId") && !src.includes("body.tokenId"));

  // 6/3. Ownership is verified via getCallerControlledAddresses — never ownerAddress alone.
  ok("ownership via getCallerControlledAddresses", src.includes("getCallerControlledAddresses(request"));
  ok("refuses identity held by an address the merchant does not control", src.includes("controlled.has(toLower)") && src.includes("status: 403"));

  // 8. Malformed / non-registration tx refused.
  ok("malformed txHash → 400", src.includes("must be a 0x-prefixed 64-hex") && src.includes("status: 400"));
  ok("non-registration tx (no mint) → 422 refuse, no guess", src.includes("status: 422"));

  // 9/8. Cross-merchant conflict → 409.
  ok("existing token/identity of a different merchant → 409",
    src.includes("already belongs to a different merchant") && src.includes("status: 409"));

  // 10/11. Idempotent — existing row returned, P2002 re-read handled.
  ok("checks existing by tokenId before create (idempotent)",
    src.includes("tokenId: mint.tokenId") && src.includes("replayed: true"));
  ok("handles P2002 unique-race idempotently", src.includes("P2002") && src.includes("replayed: true"));

  // 12. No wallet provisioning happens during recovery.
  ok("no Circle wallet creation in recover route",
    !src.includes("createWalletSet") && !src.includes("createWallets"));
  // 13. No second registration / no new on-chain tx submitted.
  ok("no register() / createContractExecutionTransaction in recover route",
    !src.includes("abiFunctionSignature") && !src.includes("createContractExecutionTransaction"));

  // 14. No fabricated tokenId / no fallback identity.
  ok("no fabricated/fallback tokenId", !src.includes("Math.random") && !src.includes("ERC8004-FALLBACK") && !src.includes("FALLBACK-"));

  // 15. Reuses the deploy successful-persistence path (ACTIVE + merchantId).
  ok("persists via agentRegistry.create with ACTIVE_AGENT_PROVISIONED + merchantId",
    src.includes("agentRegistry.create") && src.includes("ACTIVE_AGENT_PROVISIONED") && src.includes("merchantId: merchant.id"));
}

layer1();
layer2();
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exitCode = fail > 0 ? 1 : 0;