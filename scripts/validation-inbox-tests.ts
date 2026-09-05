// scripts/validation-inbox-tests.ts
//
// Validator Inbox (discovery UX) — focused proofs, no dev server / DB / chain.
//
// Proves:
//   1. controlled validator sees only its requests (live GET inbox with mocked
//      prisma + getCallerControlledAddresses + on-chain reader).
//   2. another validator's requests are excluded (same live run).
//   3. pending vs resolved classification (pure helper units).
//   4. malformed records do not crash the list (pure + live).
//   5. response action points to the EXISTING response flow (static: Review →
//      Respond opens the respond tab pre-filled; no second response API).
//   6. no client-only/provider-only controls leak into the validator inbox UI.
//   7. existing validation responder authorization remains intact (static +
//      re-run of scripts/validation-responder-auth-tests.ts separately).
//
// Run: npx tsx --experimental-test-module-mocks scripts/validation-inbox-tests.ts
// Fully hermetic: mocked prisma + auth + on-chain status reader (via
// jobValidationPolicy.__setOnChainStatusReaderForTests). No DB, no chain.

import { describe, it, mock, run } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// ── Fixtures ──────────────────────────────────────────────────────────────────
const MINE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const OTHER = "0x1111111111111111111111111111111111111111";
const PENDING_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RESOLVED_HASH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const UNREADABLE_HASH = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function jobRow(overrides: Record<string, any> = {}) {
  return {
    requestHash: PENDING_HASH,
    validatorSCA: MINE.toLowerCase(),
    status: "REQUESTED",
    tag: "job-1-validation",
    required: true,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-02T00:00:00Z"),
    requestTxHash: "0xreq",
    responseTxHash: null,
    job: {
      jobId: 424242n,
      description: "Build landing page",
      clientSCA: "0x00000000000000000000000000000000000000c1",
      providerSCA: "0x00000000000000000000000000000000000000d9",
      status: "Submitted",
    },
    ...overrides,
  };
}

// ── Mutable scenario ──────────────────────────────────────────────────────────
let scenario: { rows: any[]; controlled: string[] } = { rows: [], controlled: [] };

mock.module("@/lib/prisma", {
  namedExports: {
    prisma: {
      erc8183JobValidation: {
        findMany: async (args: any) => {
          // Record the WHERE for scoping assertions, then mirror it.
          (globalThis as any).__lastInboxWhere = args?.where ?? null;
          const allowed = new Set(scenario.controlled.map((a) => a.toLowerCase()));
          return scenario.rows.filter(
            (r) => typeof r?.validatorSCA === "string" && allowed.has(r.validatorSCA.toLowerCase())
          );
        },
      },
    },
  },
});

mock.module("@/lib/middleware/withMerchantAuth", {
  namedExports: { withApiKeyOrAnySession: (h: any) => async (req: any) => h(req) },
});

mock.module("@/lib/wallet/verifyCallerControlsAddress", {
  namedExports: {
    verifyCallerControlsAddress: async () => null,
    getCallerControlledAddresses: async () => new Set(scenario.controlled.map((a) => a.toLowerCase())),
  },
});

async function inboxFetch(): Promise<{ status: number; body: any }> {
  const { setInboxOnChainReaderForTests } = await import("@/lib/validation/inboxOnChainReader");
  setInboxOnChainReaderForTests(async (hash: string) => {
    if (hash.toLowerCase() === UNREADABLE_HASH.toLowerCase()) throw new Error("rpc-down (mock)");
    if (hash.toLowerCase() === RESOLVED_HASH.toLowerCase()) {
      return { validatorAddress: MINE.toLowerCase(), agentId: 1n, response: 100, passed: true, pending: false, tag: "done", lastUpdate: 5n };
    }
    return { validatorAddress: MINE.toLowerCase(), agentId: 1n, response: 0, passed: false, pending: true, tag: "", lastUpdate: 2n };
  });
  const route = await import("@/app/api/agent/validation/inbox/route");
  const res = await (route as any).GET(new Request("http://localhost/api/agent/validation/inbox"));
  return { status: res.status, body: await res.json() };
}

// ── (1+2) live scoping ────────────────────────────────────────────────────────
describe("inbox scoping — controlled validator sees only its requests", () => {
  it("returns only rows assigned to a controlled address", async () => {
    scenario = {
      controlled: [MINE],
      rows: [
        jobRow(),
        jobRow({ requestHash: RESOLVED_HASH, status: "REQUESTED" }),
        jobRow({ requestHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", validatorSCA: OTHER.toLowerCase() }),
      ],
    };
    const { status, body } = await inboxFetch();
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.count, 2);
    for (const item of body.items) {
      assert.equal(item.validatorSCA.toLowerCase(), MINE.toLowerCase());
    }
    assert.ok(!body.items.some((i: any) => i.validatorSCA.toLowerCase() === OTHER.toLowerCase()));
  });

  it("DB query itself is scoped by validatorSCA in controlled set (no unscoped dump)", async () => {
    scenario = { controlled: [MINE], rows: [jobRow()] };
    await inboxFetch();
    const where = (globalThis as any).__lastInboxWhere;
    assert.ok(where?.validatorSCA?.in, "findMany must filter on validatorSCA");
    assert.ok(
      where.validatorSCA.in.map((a: string) => a.toLowerCase()).includes(MINE.toLowerCase()),
      "controlled address must be in the WHERE clause"
    );
  });

  it("empty control set is 401, never an unscoped list", async () => {
    scenario = { controlled: [], rows: [jobRow()] };
    const { status, body } = await inboxFetch();
    assert.equal(status, 401);
    assert.equal(body.success, false);
  });

  it(" BigInt jobId serializes (no 500 on bigint)", async () => {
    scenario = { controlled: [MINE], rows: [jobRow()] };
    const { status, body } = await inboxFetch();
    assert.equal(status, 200);
    assert.equal(body.items[0].job.jobId, "424242");
  });
});

// ── (3+4) classification + malformed safety ───────────────────────────────────
describe("pending vs resolved classification + malformed safety", () => {
  it("pure helper: pending / responded / unavailable + malformed-safe", async () => {
    const inbox = await import("@/lib/validation/validatorInbox");
    // Pending: valid hash + on-chain pending.
    const pending = inbox.classifyInboxItem({ requestHash: PENDING_HASH, status: "REQUESTED", onChain: { pending: true } });
    assert.equal(pending.classification, "pending");
    assert.equal(pending.actionable, true);
    // Responded: DB terminal wins even with no on-chain signal.
    const dbResolved = inbox.classifyInboxItem({ requestHash: PENDING_HASH, status: "PASSED" });
    assert.equal(dbResolved.classification, "responded");
    assert.equal(dbResolved.actionable, false);
    // Responded: on-chain resolved.
    const chainResolved = inbox.classifyInboxItem({ requestHash: RESOLVED_HASH, status: "REQUESTED", onChain: { pending: false, passed: true } });
    assert.equal(chainResolved.classification, "responded");
    assert.equal(chainResolved.actionable, false);
    // Unavailable: no hash yet (policy pending, never requested).
    const noHash = inbox.classifyInboxItem({ requestHash: null, status: "PENDING" });
    assert.equal(noHash.classification, "unavailable");
    assert.equal(noHash.actionable, false);
    // Unavailable: on-chain unreadable, DB not terminal (fail-closed display).
    const unreadable = inbox.classifyInboxItem({ requestHash: UNREADABLE_HASH, status: "REQUESTED", onChainUnavailable: true });
    assert.equal(unreadable.classification, "unavailable");
    assert.equal(unreadable.actionable, false);
    // Malformed inputs never throw.
    for (const bad of [null, undefined, 42, "x", {}, { requestHash: "not-a-hash" }]) {
      const c = inbox.classifyInboxItem(bad);
      assert.equal(c.actionable, false);
      assert.equal(c.classification, "unavailable");
    }
  });

  it("pure helper: scoping filter drops other validators + garbage, case-insensitive", async () => {
    const inbox = await import("@/lib/validation/validatorInbox");
    const rows = [
      { validatorSCA: MINE.toUpperCase(), requestHash: PENDING_HASH },
      { validatorSCA: OTHER, requestHash: PENDING_HASH },
      null,
      {},
      { validatorSCA: 42 },
    ];
    const out = inbox.filterInboxForValidator(rows, new Set([MINE.toLowerCase()]));
    assert.equal(out.length, 1);
    assert.equal(out[0].validatorSCA, MINE.toUpperCase());
    assert.deepEqual(inbox.filterInboxForValidator(rows, new Set()), []);
    assert.deepEqual(inbox.filterInboxForValidator(null, new Set([MINE])), []);
  });

  it("pure helper: normalize keeps valid rows when one record is malformed", async () => {
    const inbox = await import("@/lib/validation/validatorInbox");
    const out = inbox.normalizeInboxResponse({
      success: true,
      items: [
        { requestHash: PENDING_HASH, status: "REQUESTED", onChain: { pending: true } },
        null,
        "garbage",
        { requestHash: "0xzzz", status: "REQUESTED" },
      ],
    });
    // null/garbage skipped; malformed-hash row still listed as unavailable.
    assert.equal(out.length, 2);
    assert.equal(out[0].classification, "pending");
    assert.equal(out[1].classification, "unavailable");
    assert.deepEqual(inbox.normalizeInboxResponse(null), []);
    assert.deepEqual(inbox.normalizeInboxResponse({}), []);
  });

  it("live: on-chain read failure degrades per-row, never 500s the list", async () => {
    scenario = {
      controlled: [MINE],
      rows: [
        jobRow(),
        jobRow({ requestHash: UNREADABLE_HASH, status: "REQUESTED" }),
      ],
    };
    const { status, body } = await inboxFetch();
    assert.equal(status, 200);
    assert.equal(body.count, 2);
    const bad = body.items.find((i: any) => i.requestHash.toLowerCase() === UNREADABLE_HASH.toLowerCase());
    assert.equal(bad.onChainUnavailable, true);
    const good = body.items.find((i: any) => i.requestHash.toLowerCase() === PENDING_HASH.toLowerCase());
    assert.equal(good.onChain?.pending, true);
  });

  it("live: row without requestHash yet is listed unavailable, not actionable", async () => {
    const inbox = await import("@/lib/validation/validatorInbox");
    scenario = { controlled: [MINE], rows: [jobRow({ requestHash: null, status: "PENDING" })] };
    const { status, body } = await inboxFetch();
    assert.equal(status, 200);
    const classified = inbox.normalizeInboxResponse(body);
    assert.equal(classified.length, 1);
    assert.equal(classified[0].classification, "unavailable");
    assert.equal(classified[0].actionable, false);
  });
});

// ── (5+6+7) static wiring proofs ──────────────────────────────────────────────
describe("static wiring proofs (source-level)", () => {
  const page = read("src/app/agents/page.tsx");
  const inboxRoute = read("src/app/api/agent/validation/inbox/route.ts");
  const agentRoute = read("src/app/api/agent/validation/route.ts");

  it("inbox exposes requests assigned to controlled wallets (no client-supplied address)", () => {
    assert.match(inboxRoute, /getCallerControlledAddresses/);
    assert.match(inboxRoute, /validatorSCA/);
    assert.ok(!/searchParams\.get\(["']validator/i.test(inboxRoute), "must not accept a validator query param");
    assert.ok(!/body\.validatorSCA|validatorSCA.*body/i.test(inboxRoute), "must not accept a validator body field");
  });

  it("inbox is read-only: no tx creation, no second response API", () => {
    assert.ok(!inboxRoute.includes("createContractExecutionTransaction"), "inbox must never create transactions");
    assert.ok(!inboxRoute.includes("validationResponse"), "inbox must not duplicate contract execution");
    assert.ok(!/export const POST/.test(inboxRoute), "inbox must be GET-only");
  });

  it("response action points to the EXISTING response flow (Review → Respond)", () => {
    assert.ok(page.includes("Review → Respond"), "primary action must be obvious");
    assert.ok(page.includes("reviewInboxItem"), "review handler must exist");
    // The handler pre-fills the existing respond form and switches to it.
    const fnStart = page.indexOf("const reviewInboxItem");
    const fnBody = page.slice(fnStart, fnStart + 1200);
    assert.ok(fnBody.includes("setValRequestHash"), "must pre-fill the existing requestHash field");
    assert.ok(fnBody.includes("setValValidatorSCA"), "must pre-fill the existing validator field");
    assert.ok(fnBody.includes("setValTab('respond')"), "must open the existing respond tab");
    // The respond tab still POSTs to the hardened existing route.
    assert.ok(page.includes("POST /api/agent/validation"), "must cite the existing response route");
    assert.ok(page.includes("action: 'respond'") || page.includes("action:'respond'") || page.includes("'respond'"), "must use action respond");
  });

  it("already-resolved requests show status, never an action", () => {
    const inboxStart = page.indexOf("{valTab === 'inbox'");
    const requestStart = page.indexOf("{valTab === 'request'");
    const inboxBlock = page.slice(inboxStart, requestStart);
    assert.ok(inboxBlock.includes("row.actionable"), "must branch on actionable");
    assert.ok(inboxBlock.includes("Already resolved"), "resolved rows show status copy");
    // Only ONE action button exists in the inbox block, and it is the respond deep-link.
    const actionButtons = (inboxBlock.match(/<button/g) || []).length;
    assert.ok(actionButtons <= 2, `at most refresh + Review→Respond buttons, found ${actionButtons}`);
    assert.ok(!inboxBlock.includes("Request Validation Onchain"), "no request-flow control inside inbox");
    assert.ok(!inboxBlock.includes("Record Reputation"), "no reputation control inside inbox");
  });

  it("no client-only/provider-only controls leak into the validator inbox block", () => {
    const inboxStart = page.indexOf("{valTab === 'inbox'");
    const requestStart = page.indexOf("{valTab === 'request'");
    const inboxBlock = page.slice(inboxStart, requestStart);
    assert.ok(inboxBlock.length > 0, "inbox block must exist before the request block");
    assert.ok(!inboxBlock.includes("Approve USDC"), "no client Approve control");
    assert.ok(!inboxBlock.includes("Fund Escrow"), "no client Fund control");
    assert.ok(!inboxBlock.includes("Complete & Pay"), "no client Complete control");
    assert.ok(!inboxBlock.includes("Submit Deliverable"), "no provider Submit control");
    assert.ok(!inboxBlock.includes("fetch('/api/agent/validation',"), "inbox block issues no response POST of its own");
  });

  it("existing validation responder authorization remains intact", () => {
    assert.match(agentRoute, /resolveResponseValidator/);
    assert.match(agentRoute, /verifyCallerControlsAddress\(request, validatorSCA\)/);
    assert.match(agentRoute, /You are not the designated validator/);
    assert.match(agentRoute, /walletAddress: designated\.validatorAddress/);
  });

  it("inbox complements notifications, does not replace them", () => {
    assert.ok(
      page.includes("even if the notification was missed") || inboxRoute.includes("complements"),
      "UI/route must frame the inbox as the durable complement to notifications"
    );
    assert.match(inboxRoute, /notifyValidator/);
  });
});

await run();
