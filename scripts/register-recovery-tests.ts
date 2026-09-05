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
import { extractIdentityMintFromLogs, matchDeployIntentToMint, ERC721_TRANSFER_TOPIC } from "../src/lib/agents/agentRegisterRecovery";

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
// NOTE: since the deploy-intent fix, ownership is proven by the server-side
// AgentDeployIntent binding (merchant → Circle walletSetId → ownerSca) PLUS a
// Circle wallet-set membership check — NOT by getCallerControlledAddresses(),
// which cannot recognize a freshly-provisioned orphan SCA. These proofs assert
// the deploy-intent model and that no client-supplied ownership claim is ever
// trusted.
function layer2() {
  console.log("\n[2] POST /api/agent/deploy/recover static security proofs (deploy-intent model)");
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

  // 5. Ownership comes from the SERVER-side deploy intent, never the client.
  ok("loads the merchant's server-side deploy intents", src.includes("agentDeployIntent.findMany"));
  ok("intents are merchant-scoped (where: { merchantId: merchant.id })",
    src.includes("where: { merchantId: merchant.id }"));
  ok("refuses with no merchant deploy intent at all", src.includes("intents.length === 0") && src.includes("status: 403"));
  ok("matches the minted holder to an intent ownerSca via the pure matcher",
    src.includes("matchDeployIntentToMint(intents, mint.to, txHash)"));
  ok("refuses a mint not bound to any of this merchant's intents",
    src.includes("not bound to any deployment this merchant has server-side") && src.includes("status: 403"));

  // 6. Client-supplied ownership fields are NEVER read.
  for (const denied of ["body?.walletSetId", "body.walletSetId", "body?.ownerAddress", "body.ownerAddress",
    "body?.tokenId", "body.tokenId", "body?.merchantId", "body.merchantId", "body?.validatorSca", "body.validatorSca"]) {
    ok(`does NOT trust client-supplied ${denied}`, !src.includes(denied));
  }

  // 7. Circle wallet-set membership verified against the SERVER-STORED walletSetId.
  ok("calls Circle read-only listWallets", src.includes("circleClient.listWallets"));
  ok("listWallets uses the SERVER-STORED intent.walletSetId", src.includes("listWallets({ walletSetId: intent.walletSetId })"));
  ok("rejects a holder not in the recorded wallet set",
    src.includes("not a wallet in this deployment's recorded Circle wallet set") && src.includes("status: 403"));
  ok("never accepts a client-supplied walletSetId for the membership check",
    !src.includes("body?.walletSetId") && !src.includes("walletSetId: tx"));

  // 8. Malformed / non-registration tx refused.
  ok("malformed txHash → 400", src.includes("must be a 0x-prefixed 64-hex") && src.includes("status: 400"));
  ok("non-registration tx (no mint) → 422 refuse, no guess", src.includes("status: 422"));

  // 9/10. Cross-merchant conflict → 409; no ownership via getCallerControlledAddresses.
  ok("existing token/identity of a different merchant → 409",
    src.includes("already belongs to a different merchant") && src.includes("status: 409"));
  ok("does NOT depend on getCallerControlledAddresses (module left untouched)",
    !src.includes("getCallerControlledAddresses(request") && !src.includes("getCallerControlledAddresses} from"));

  // 11/12. Idempotent — existing row returned, P2002 re-read handled.
  ok("checks existing by tokenId/scaAddress before create (idempotent)",
    src.includes("agentRegistry.findUnique") && src.includes("replayed: true"));
  ok("handles P2002 unique-race idempotently", src.includes("P2002") && src.includes("replayed: true"));

  // 13. No wallet provisioning happens during recovery.
  ok("no Circle wallet creation in recover route",
    !src.includes("createWalletSet") && !src.includes("createWallets"));
  // 14. No second registration / no new on-chain tx submitted.
  ok("no register() / createContractExecutionTransaction in recover route",
    !src.includes("abiFunctionSignature") && !src.includes("createContractExecutionTransaction"));

  // 15. No fabricated tokenId / no fallback identity.
  ok("no fabricated/fallback tokenId", !src.includes("Math.random") && !src.includes("ERC8004-FALLBACK") && !src.includes("FALLBACK-"));

  // 16. Persists walletSetId + validatorSca (from the server-stored intent) with the real tokenId.
  ok("persists via agentRegistry.create with ACTIVE_AGENT_PROVISIONED + merchantId",
    src.includes("agentRegistry.create") && src.includes("ACTIVE_AGENT_PROVISIONED") && src.includes("merchantId: merchant.id"));
  ok("persists walletSetId from the intent", src.includes("walletSetId: intent.walletSetId"));
  ok("persists validatorSca from the intent", src.includes("validatorSca: intent.validatorSca"));
  ok("marks the deploy intent COMPLETED on recovery", src.includes('status: "COMPLETED"'));
}

// ── Layer 3: pure deploy-intent matcher unit tests ────────────────────────────
function layer3() {
  console.log("\n[3] matchDeployIntentToMint (pure)");
  const holder = "0xaaaa000000000000000000000000000000000000";
  const other = "0xbbbb000000000000000000000000000000000000";
  const h = (s: string) => s.toLowerCase();
  const mk = (over: Partial<{ id: string; ownerSca: string; registerTxHash: string }> = {}) => ({
    id: "intent-x",
    ownerSca: holder,
    ...over,
  });

  ok("matches holder to an intent ownerSca (case-insensitive)",
    !!matchDeployIntentToMint([mk()], h(holder.toUpperCase()), "0x" + "a".repeat(64)));
  ok("prefers the intent that recorded this exact txHash",
    matchDeployIntentToMint([mk({ id: "old", ownerSca: holder, registerTxHash: "0x" + "a".repeat(64) }),
      mk({ id: "matching", ownerSca: holder, registerTxHash: "0x" + "b".repeat(64) })],
      holder, "0x" + "b".repeat(64))?.id === "matching");
  ok("falls back to the earliest holder intent when no txHash recorded",
    matchDeployIntentToMint([mk({ id: "first" }), mk({ id: "second" })], holder, "0x" + "c".repeat(64))?.id === "first");
  ok("null/empty intents → null", matchDeployIntentToMint(null, holder, "0x" + "a".repeat(64)) === null
    && matchDeployIntentToMint([], holder, "0x" + "a".repeat(64)) === null);
  ok("holder minted to an SCA in NO intent → null (never attach another merchant's)",
    matchDeployIntentToMint([mk({ ownerSca: other })], holder, "0x" + "a".repeat(64)) === null);
  ok("no fabricated identity: an empty holder never matches", matchDeployIntentToMint([mk()], "", "0x" + "a".repeat(64)) === null);
}

layer1();
layer2();
layer3();
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exitCode = fail > 0 ? 1 : 0;