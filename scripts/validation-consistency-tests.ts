// scripts/validation-consistency-tests.ts
//
// Focused consistency coverage for two confirmed validation defects:
//
//   1. DB synchronization after /api/agent/validation respond.
//      When a validator answers an on-chain validationResponse through the
//      generic ERC-8004 route and that requestHash maps to a JOB-backed
//      Erc8183JobValidation row, the row must be kept in sync with the
//      authoritative on-chain response (PASSED/FAILED + responseTxHash + tag).
//      The DB write is BEST-EFFORT and AFTER on-chain success ONLY: a DB error
//      must never turn the successful on-chain response into an HTTP failure.
//
//   2. Central self-validation enforcement in createJobValidationPolicy.
//      validator === job client and validator === job provider must be
//      rejected inside the shared function (case-insensitive) even if a
//      hypothetical caller failed to pre-check those conditions, while a valid
//      third-party validator still succeeds.
//
// Run: npx tsx --experimental-test-module-mocks scripts/validation-consistency-tests.ts
// Fully hermetic: mocked prisma + mocked auth/notify/circle modules — no DB, no
// chain, no network. (Live on-chain coverage lives in scripts/validation-gated-e2e.mjs.)

import { describe, it, mock, run } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// ── Test fixtures ────────────────────────────────────────────────────────────
const CLIENT_SCA = "0x00000000000000000000000000000000000000aa"; // stored lowercase
const PROVIDER_SCA = "0x00000000000000000000000000000000000000bb"; // stored lowercase
const VALIDATOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // third party, mixed case
const JOB_ID = 424242n;
const REQUEST_HASH = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abcd";
const TX_HASH = "0x00000000000000000000000000000000000000000000000000000000000000ab";

function policyRow(overrides: Record<string, any> = {}) {
  return {
    id: "cm-policy-1",
    jobId: JOB_ID,
    validatorSCA: VALIDATOR.toLowerCase(),
    requestHash: REQUEST_HASH.toLowerCase(),
    requestTxHash: "0xreq",
    responseTxHash: null,
    status: "REQUESTED",
    tag: null,
    required: true,
    ...overrides,
  };
}

// ── Mutable scenario + call log consumed by the mocked prisma ────────────────
let scenario: {
  validationByHash: any | null;
  validationByJobId: any | null;
  jobRow: any | null;
  updateShouldThrow: boolean;
  /** Authoritative on-chain validator (fed to the mocked status reader). */
  onChainValidator?: string | null;
} = { validationByHash: null, validationByJobId: null, jobRow: null, updateShouldThrow: false };

const calls = { validationUpdate: [] as any[], validationCreate: [] as any[] };

function resetScenario(overrides: Partial<typeof scenario> = {}) {
  scenario = { validationByHash: null, validationByJobId: null, jobRow: null, updateShouldThrow: false, onChainValidator: null, ...overrides };
  calls.validationUpdate.length = 0;
  calls.validationCreate.length = 0;
}

mock.module("@/lib/prisma", {
  namedExports: {
    prisma: {
      erc8183JobValidation: {
        findUnique: async ({ where }: any) => {
          if (where?.requestHash != null) return scenario.validationByHash;
          if (where?.jobId != null) return scenario.validationByJobId;
          return null;
        },
        update: async ({ where, data }: any) => {
          calls.validationUpdate.push({ where, data });
          if (scenario.updateShouldThrow) throw new Error("db-down (mock)");
          const base = scenario.validationByHash ?? scenario.validationByJobId ?? { jobId: where?.jobId ?? 0n };
          return { ...base, ...data };
        },
        create: async ({ data }: any) => {
          calls.validationCreate.push(data);
          return { id: "cm-policy-new", jobId: data.jobId, createdAt: new Date(), updatedAt: new Date(), ...data };
        },
      },
      erc8183Job: {
        findUnique: async () => scenario.jobRow,
      },
    },
  },
});

// Auth/notify/circle are exercised only via the wrapped route; mock them so no
// real merchant auth, wallet-control, telegram, or Circle network code runs.
mock.module("@/lib/middleware/withMerchantAuth", {
  namedExports: { withApiKeyOrAnySession: (h: any) => async (req: any) => h(req) },
});
mock.module("@/lib/wallet/verifyCallerControlsAddress", {
  namedExports: { verifyCallerControlsAddress: async () => ({ id: "mock-actor" }) },
});
mock.module("@/lib/notifyValidator", {
  namedExports: { notifyValidator: async () => ({ notified: false, reason: "mocked-out" }) },
});
mock.module("@circle-fin/developer-controlled-wallets", {
  namedExports: {
    initiateDeveloperControlledWalletsClient: () => ({
      createContractExecutionTransaction: async () => ({ data: { id: "mock-tx" } }),
      getTransaction: async () => ({
        data: { transaction: { state: "COMPLETE", txHash: TX_HASH } },
      }),
    }),
  },
});

async function respond(body: Record<string, unknown>) {
  // The respond path now resolves the authoritative designated validator from
  // on-chain (getValidationStatus). Feed the hermetic test a fake reader that
  // mirrors the scenario, so no testnet RPC is contacted.
  const jvp = await import("@/lib/jobs/jobValidationPolicy");
  const onChainValidator =
    scenario.onChainValidator ??
    scenario.validationByHash?.validatorSCA ??
    VALIDATOR.toLowerCase();
  jvp.__setOnChainStatusReaderForTests((async () => ({
    validatorAddress: onChainValidator,
    agentId: BigInt(onChainValidator === "0x0000000000000000000000000000000000000000" ? 0 : 68210),
    response: 0,
    passed: false,
    pending: true,
    tag: "",
    lastUpdate: 123n,
  })) as any);
  const route = await import("@/app/api/agent/validation/route");
  const res = await (route as any).POST(
    new Request("http://localhost/api/agent/validation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "respond", validatorSCA: VALIDATOR, ...body }),
    })
  );
  return { status: res.status, body: await res.json() };
}

describe("(a) /api/agent/validation respond syncs a job-backed Erc8183JobValidation", () => {
  it("PASS -> DB row updated to PASSED with responseTxHash + tag (HTTP 200)", async () => {
    resetScenario({ validationByHash: policyRow() });
    const { status, body } = await respond({ requestHash: REQUEST_HASH, passed: true, tag: "e2e-verified" });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.passed, true);
    // The sync runs AFTER the on-chain tx succeeded and updates the SAME record.
    assert.equal(calls.validationUpdate.length, 1, "exactly one DB update expected");
    const update = calls.validationUpdate[0];
    assert.equal(update.where.jobId, JOB_ID, "update keyed by the policy's jobId");
    assert.equal(update.data.status, "PASSED");
    assert.equal(update.data.responseTxHash, TX_HASH);
    assert.equal(update.data.tag, "e2e-verified");
  });

  it("FAIL -> DB row updated to FAILED with responseTxHash + tag (HTTP 200)", async () => {
    resetScenario({ validationByHash: policyRow() });
    const { status, body } = await respond({ requestHash: REQUEST_HASH, passed: false, tag: "e2e-failed" });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.passed, false);
    assert.equal(calls.validationUpdate.length, 1);
    assert.equal(calls.validationUpdate[0].data.status, "FAILED");
    assert.equal(calls.validationUpdate[0].data.responseTxHash, TX_HASH);
    assert.equal(calls.validationUpdate[0].data.tag, "e2e-failed");
  });

  it("non-job requestHash (no matching row) -> no-op, still HTTP 200", async () => {
    resetScenario({ validationByHash: null });
    const { status, body } = await respond({ requestHash: REQUEST_HASH, passed: true, tag: "agent-only" });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(calls.validationUpdate.length, 0, "no job row -> no DB write");
  });
});

describe("(d) DB sync failure after a successful on-chain response is non-fatal", () => {
  it("update throwing db-down -> respond still returns HTTP 200 success; error logged server-side", async () => {
    resetScenario({ validationByHash: policyRow(), updateShouldThrow: true });
    const errSpy = mock.method(console, "error", () => {});
    try {
      const { status, body } = await respond({ requestHash: REQUEST_HASH, passed: true, tag: "still-ok" });
      assert.equal(status, 200, "DB hiccup must never fail the successful on-chain response");
      assert.equal(body.success, true);
      assert.equal(body.passed, true);
      assert.ok(
        errSpy.mock.calls.some((c) => String(c.arguments?.[0]).includes("job-validation DB sync failed (non-fatal)")),
        "real DB error logged server-side"
      );
      assert.ok(
        errSpy.mock.calls.some((c) => JSON.stringify(c.arguments).includes("db-down (mock)")),
        "real DB error message included in the log"
      );
    } finally {
      errSpy.mock.restore();
    }
  });
});

describe("syncJobValidationResponseByRequestHash helper semantics", () => {
  it("maps requestHash -> jobId -> recordValidationResponse (PASSED/FAILED status)", async () => {
    resetScenario({ validationByHash: policyRow({ status: "REQUESTED" }) });
    const mod = await import("@/lib/jobs/jobValidationPolicy");
    const ok = await mod.syncJobValidationResponseByRequestHash(REQUEST_HASH, TX_HASH, true, "lib-pass");
    assert.deepEqual(ok, { synced: true, status: "PASSED" });
    assert.equal(calls.validationUpdate[0].data.status, "PASSED");

    resetScenario({ validationByHash: policyRow({ status: "REQUESTED" }) });
    const no = await mod.syncJobValidationResponseByRequestHash(REQUEST_HASH, TX_HASH, false, "lib-fail");
    assert.deepEqual(no, { synced: true, status: "FAILED" });
    assert.equal(calls.validationUpdate[0].data.status, "FAILED");
  });

  it("requestHash with mixed case resolves to the stored lowercase lookup", async () => {
    resetScenario({ validationByHash: policyRow() });
    const mod = await import("@/lib/jobs/jobValidationPolicy");
    const mixedCase = `0x${REQUEST_HASH.slice(2).toUpperCase()}`;
    const row = await mod.getJobValidationPolicyByRequestHash(mixedCase);
    assert.ok(row, "by-requestHash lookup must be case-insensitive");
    assert.equal(row?.jobId, JOB_ID);
  });

  it("non-job requestHash -> { synced:false }, no DB write", async () => {
    resetScenario({ validationByHash: null });
    const mod = await import("@/lib/jobs/jobValidationPolicy");
    const res = await mod.syncJobValidationResponseByRequestHash(REQUEST_HASH, TX_HASH, true, "n/a");
    assert.deepEqual(res, { synced: false, status: null });
    assert.equal(calls.validationUpdate.length, 0);
  });
});

describe("(b) createJobValidationPolicy enforces the self-validation invariant centrally", () => {
  it("rejects validator === job client even when the caller never pre-checked", async () => {
    resetScenario({ validationByHash: null, validationByJobId: null, jobRow: { clientSCA: CLIENT_SCA, providerSCA: PROVIDER_SCA } });
    const mod = await import("@/lib/jobs/jobValidationPolicy");
    // validator is the client address with DIFFERENT case -> proves normalized comparison.
    const clientMixedCase = `0x${CLIENT_SCA.slice(2).toUpperCase()}`;
    await assert.rejects(
      mod.createJobValidationPolicy(JOB_ID, clientMixedCase),
      /validator cannot be the job client \(self-validation\)/
    );
    assert.equal(calls.validationCreate.length, 0, "no policy row created for self-validation");
  });

  it("rejects validator === job provider even when the caller never pre-checked", async () => {
    resetScenario({ validationByHash: null, validationByJobId: null, jobRow: { clientSCA: CLIENT_SCA, providerSCA: PROVIDER_SCA } });
    const mod = await import("@/lib/jobs/jobValidationPolicy");
    const providerMixedCase = `0x${PROVIDER_SCA.slice(2).toUpperCase()}`;
    await assert.rejects(
      mod.createJobValidationPolicy(JOB_ID, providerMixedCase),
      /validator cannot be the job provider \(self-validation\)/
    );
    assert.equal(calls.validationCreate.length, 0);
  });

  it("fail-closed when the job row cannot be read (cannot prove third party)", async () => {
    resetScenario({ validationByHash: null, validationByJobId: null, jobRow: null });
    const mod = await import("@/lib/jobs/jobValidationPolicy");
    await assert.rejects(
      mod.createJobValidationPolicy(JOB_ID, VALIDATOR),
      /cannot create validation policy: job not found/
    );
    assert.equal(calls.validationCreate.length, 0);
  });

  it("existing policy short-circuits before the invariant (idempotent) — untouched behavior", async () => {
    resetScenario({ validationByJobId: policyRow({ status: "PASSED" }), jobRow: { clientSCA: CLIENT_SCA, providerSCA: PROVIDER_SCA } });
    const mod = await import("@/lib/jobs/jobValidationPolicy");
    const existing = await mod.createJobValidationPolicy(JOB_ID, `0x${CLIENT_SCA.slice(2).toUpperCase()}`);
    assert.equal(existing.id, "cm-policy-1");
    assert.equal(calls.validationCreate.length, 0);
  });
});

describe("(c) valid third-party validator still succeeds", () => {
  it("creates the policy row (PENDING, required, normalized validator)", async () => {
    resetScenario({ validationByHash: null, validationByJobId: null, jobRow: { clientSCA: CLIENT_SCA, providerSCA: PROVIDER_SCA } });
    const mod = await import("@/lib/jobs/jobValidationPolicy");
    const created = await mod.createJobValidationPolicy(JOB_ID, VALIDATOR, "third-party");
    assert.equal(created.status, "PENDING");
    assert.equal(created.required, true);
    assert.equal(created.validatorSCA, VALIDATOR.toLowerCase(), "validator normalized to lowercase");
    assert.equal(calls.validationCreate.length, 1);
    assert.equal(calls.validationCreate[0].jobId, JOB_ID);
    assert.equal(calls.validationCreate[0].status, "PENDING");
    assert.equal(calls.validationCreate[0].required, true);
    assert.equal(calls.validationCreate[0].tag, "third-party");
  });
});

describe("static wiring proofs (source-level)", () => {
  const agentRoute = read("src/app/api/agent/validation/route.ts");
  const policyLib = read("src/lib/jobs/jobValidationPolicy.ts");
  const hireRoute = read("src/app/api/agents/[id]/hire/route.ts");

  it("agent respond route: DB sync import + call AFTER on-chain success, wrapped non-fatally", () => {
    assert.match(agentRoute, /syncJobValidationResponseByRequestHash/);
    const waitIdx = agentRoute.indexOf("const txHash = await waitForTx(circleClient, tx.data.id);");
    const syncIdx = agentRoute.indexOf("syncJobValidationResponseByRequestHash(requestHash, txHash, passed, tag)");
    const respondReturnIdx = agentRoute.indexOf("success: true,\n        action: 'respond'");
    assert.ok(waitIdx > 0 && syncIdx > waitIdx, "DB sync must come only after the on-chain tx succeeded");
    assert.ok(respondReturnIdx > syncIdx, "DB sync runs before the successful respond response");
    assert.match(agentRoute, /job-validation DB sync failed \(non-fatal\)/);
  });

  it("jobValidationPolicy: createJobValidationPolicy enforces client AND provider centrally", () => {
    const createFn = policyLib.slice(policyLib.indexOf("export async function createJobValidationPolicy"));
    assert.match(createFn, /erc8183Job\.findUnique/);
    assert.match(createFn, /clientSCA\.toLowerCase\(\)/);
    assert.match(createFn, /providerSCA\.toLowerCase\(\)/);
    assert.match(createFn, /validator cannot be the job client \(self-validation\)/);
    assert.match(createFn, /validator cannot be the job provider \(self-validation\)/);
    // Docstring no longer over-claims / contradicts the implementation.
    assert.doesNotMatch(createFn, /prevents self-validation where possible/);
  });

  it("jobValidationPolicy: by-requestHash lookup + sync helper exist", () => {
    assert.match(policyLib, /getJobValidationPolicyByRequestHash/);
    assert.match(policyLib, /findUnique\(\{\s*where: \{ requestHash/);
    assert.match(policyLib, /syncJobValidationResponseByRequestHash/);
    assert.match(policyLib, /recordValidationResponse\(policy\.jobId/);
  });

  it("hire route: misleading retry-through-validation-endpoint comment removed (doc-only)", () => {
    assert.doesNotMatch(hireRoute, /retry creating the validation requirement via the validation endpoint/);
    assert.match(hireRoute, /no separate "create validation policy" API endpoint to retry through/);
  });
});

await run();
