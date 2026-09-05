// scripts/validation-responder-auth-tests.ts
//
// SECURITY — designated-validator authorization for the generic ERC-8004
// validation RESPOND path.
//
// Confirmed defect fixed here: POST /api/agent/validation { action:"respond" }
// previously verified only that the caller controls the CLIENT-SUPPLIED
// validatorSCA, never that the supplied wallet is the validator DESIGNATED by
// the original on-chain validationRequest. A caller controlling some OTHER
// valid validator wallet could therefore have a response transaction created
// for a request designated to somebody else.
//
// Fix under test: the responder must first be proven == the authoritative
// designated validator for requestHash, where the source of truth is the
// on-chain ValidationRegistry's getValidationStatus (exposed as
// getOnChainValidationStatus / resolveResponseValidator). The persisted
// Erc8183JobValidation.validatorSCA is only cross-checked to fail closed on
// silent DB-vs-on-chain disagreement. Mismatch/disagreement is rejected with
// 403 BEFORE any createContractExecutionTransaction.
//
// Run: npx tsx --experimental-test-module-mocks scripts/validation-responder-auth-tests.ts
// Fully hermetic: mocked prisma + auth + notify + circle + on-chain status
// reader (via jobValidationPolicy.__setOnChainStatusReaderForTests). No DB, no
// chain, no network. (Live on-chain coverage lives in scripts/validation-gated-e2e.mjs.)

import { describe, it, mock, run } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// ── Fixtures ──────────────────────────────────────────────────────────────────
const ZERO = "0x0000000000000000000000000000000000000000";
const ONCHAIN_VALIDATOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // designated by request (mixed case)
const ALTERNATE_VALIDATOR = "0x1111111111111111111111111111111111111111"; // another valid validator the caller controls
const PERSISTED_VALIDATOR = "0x2222222222222222222222222222222222222222"; // THIRD address, persist-disagreement case
const JOB_ID = 424242n;
const REQUEST_HASH = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abcd";
const TX_HASH = "0x00000000000000000000000000000000000000000000000000000000000000ab";

function policyRow(overrides: Record<string, any> = {}) {
  return {
    id: "cm-policy-1",
    jobId: JOB_ID,
    validatorSCA: ONCHAIN_VALIDATOR.toLowerCase(),
    requestHash: REQUEST_HASH.toLowerCase(),
    requestTxHash: "0xreq",
    responseTxHash: null,
    status: "REQUESTED",
    tag: null,
    required: true,
    ...overrides,
  };
}

// ── Mutable scenario consumed by the mocked modules ───────────────────────────
let scenario: {
  policy: any | null; // Erc8183JobValidation row keyed by requestHash (or null for plain)
  onChainValidator: string; // value the mocked on-chain status reader returns
  controlsCaller: boolean; // verifyCallerControlsAddress truthy?
  onChainThrows: boolean; // make the status reader throw (fail-closed path)
} = {
  policy: null,
  onChainValidator: ONCHAIN_VALIDATOR,
  controlsCaller: true,
  onChainThrows: false,
};

const txCalls: Array<{ walletAddress: string; abiSignature: string; abiParameters: any[] }> = [];
const dbUpdates: any[] = [];

function resetScenario(overrides: Partial<typeof scenario> = {}) {
  scenario = {
    policy: null,
    onChainValidator: ONCHAIN_VALIDATOR,
    controlsCaller: true,
    onChainThrows: false,
    ...overrides,
  };
  txCalls.length = 0;
  dbUpdates.length = 0;
}

// ── Module mocks ──────────────────────────────────────────────────────────────
mock.module("@/lib/prisma", {
  namedExports: {
    prisma: {
      erc8183JobValidation: {
        findUnique: async ({ where }: any) => {
          if (where?.requestHash != null) return scenario.policy;
          return null;
        },
        update: async ({ data }: any) => {
          dbUpdates.push(data);
          return { ...(scenario.policy ?? {}), ...data };
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
    verifyCallerControlsAddress: async () =>
      scenario.controlsCaller ? { id: "mock-actor" } : null,
  },
});

mock.module("@/lib/notifyValidator", {
  namedExports: { notifyValidator: async () => ({ notified: false, reason: "mocked-out" }) },
});

mock.module("@circle-fin/developer-controlled-wallets", {
  namedExports: {
    initiateDeveloperControlledWalletsClient: () => ({
      createContractExecutionTransaction: async (p: any) => {
        txCalls.push({
          walletAddress: p.walletAddress,
          abiSignature: p.abiFunctionSignature,
          abiParameters: p.abiParameters,
        });
        return { data: { id: "mock-tx" } };
      },
      getTransaction: async () => ({ data: { transaction: { state: "COMPLETE", txHash: TX_HASH } } }),
    }),
  },
});

async function ensureStatusReader() {
  const jvp = await import("@/lib/jobs/jobValidationPolicy");
  jvp.__setOnChainStatusReaderForTests((async () => {
    if (scenario.onChainThrows) throw new Error("rpc-down (mock)");
    return {
      validatorAddress: scenario.onChainValidator,
      agentId: BigInt(scenario.onChainValidator === ZERO ? 0 : 68210),
      response: 0,
      passed: false,
      pending: true,
      tag: "",
      lastUpdate: 123n,
    };
  }) as any);
  return jvp;
}

async function respond(body: Record<string, unknown>) {
  await ensureStatusReader();
  const route = await import("@/app/api/agent/validation/route");
  const res = await (route as any).POST(
    new Request("http://localhost/api/agent/validation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "respond", validatorSCA: ONCHAIN_VALIDATOR, ...body }),
    })
  );
  return { status: res.status, body: await res.json() };
}

// ── (a) designated validator CAN respond ─────────────────────────────────────
describe("(a) designated validator can respond", () => {
  it("plain (non-job) request: 200 success, tx created signing from the designated validator", async () => {
    resetScenario({ policy: null, onChainValidator: ONCHAIN_VALIDATOR, controlsCaller: true });
    const { status, body } = await respond({ requestHash: REQUEST_HASH, passed: true, tag: "kyc-ok" });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.passed, true);
    assert.equal(txCalls.length, 1, "exactly one response tx expected");
    assert.equal(
      txCalls[0].walletAddress.toLowerCase(),
      ONCHAIN_VALIDATOR.toLowerCase(),
      "tx must be signed by the authoritative designated validator"
    );
  });

  it("existing valid JOB validation still works (on-chain == persisted == caller)", async () => {
    resetScenario({
      policy: policyRow(),
      onChainValidator: ONCHAIN_VALIDATOR.toLowerCase(),
      controlsCaller: true,
    });
    const { status, body } = await respond({ requestHash: REQUEST_HASH, passed: true, tag: "job-ok" });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(txCalls.length, 1);
    assert.equal(dbUpdates.length, 1, "job-backed response still syncs the DB policy");
  });

  it("case-insensitive address handling: body UPPER vs on-chain/persisted mixed/lower, still matches", async () => {
    resetScenario({ policy: policyRow(), onChainValidator: ONCHAIN_VALIDATOR, controlsCaller: true });
    const { status, body } = await respond({
      validatorSCA: ONCHAIN_VALIDATOR.toUpperCase(),
      requestHash: REQUEST_HASH,
      passed: true,
      tag: "case-ok",
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(txCalls.length, 1);
  });
});

// ── (b) wrong/fabricated validator identities are rejected BEFORE any tx ─────
describe("(b) non-designated responders are rejected before any transaction", () => {
  it("different controlled validator wallet cannot answer (client-supplied alternate cannot bypass)", async () => {
    resetScenario({ policy: null, onChainValidator: ONCHAIN_VALIDATOR, controlsCaller: true });
    const { status, body } = await respond({
      validatorSCA: ALTERNATE_VALIDATOR, // caller controls this, but it is NOT the designated validator
      requestHash: REQUEST_HASH,
      passed: true,
      tag: "nope",
    });
    assert.equal(status, 403);
    assert.match(body.error, /not the designated validator/);
    assert.equal(txCalls.length, 0, "must be rejected BEFORE creating any on-chain tx");
  });

  it("arbitrary external wallet (no control) cannot respond even with the correct address", async () => {
    resetScenario({ policy: null, onChainValidator: ONCHAIN_VALIDATOR, controlsCaller: false });
    const { status, body } = await respond({ requestHash: REQUEST_HASH, passed: true, tag: "ext" });
    assert.equal(status, 403);
    assert.match(body.error, /You do not control the wallet/);
    assert.equal(txCalls.length, 0);
  });

  it("validator mismatch fails BEFORE any on-chain transaction (no createContractExecutionTransaction)", async () => {
    resetScenario({ policy: null, onChainValidator: ONCHAIN_VALIDATOR, controlsCaller: true });
    const { status } = await respond({
      validatorSCA: ALTERNATE_VALIDATOR,
      requestHash: REQUEST_HASH,
      passed: false,
      tag: "no-tx",
    });
    assert.equal(status, 403);
    assert.equal(txCalls.length, 0, "zero tx creation calls on mismatch");
  });

  it("no on-chain validation request exists for the hash -> reject, no tx", async () => {
    resetScenario({ policy: policyRow(), onChainValidator: ZERO, controlsCaller: true });
    const { status, body } = await respond({ requestHash: REQUEST_HASH, passed: true, tag: "none" });
    assert.equal(status, 403);
    assert.match(body.error, /on-chain|not (yet )?visible|authorize/i);
    assert.equal(txCalls.length, 0);
  });

  it("on-chain read failure -> fail closed, no tx", async () => {
    resetScenario({ policy: null, onChainValidator: ONCHAIN_VALIDATOR, controlsCaller: true, onChainThrows: true });
    const { status, body } = await respond({ requestHash: REQUEST_HASH, passed: true, tag: "flaky" });
    assert.equal(status, 403);
    assert.match(body.error, /on-chain validation status unavailable/);
    assert.equal(txCalls.length, 0);
  });
});

// ── (c) job-linked: DB and on-chain cannot silently disagree ─────────────────
describe("(c) DB vs on-chain validator disagreement fails closed", () => {
  it("persisted validator differs from the authoritative on-chain validator -> 403, no tx", async () => {
    resetScenario({
      policy: policyRow({ validatorSCA: PERSISTED_VALIDATOR.toLowerCase() }), // DB disagrees with on-chain
      onChainValidator: ONCHAIN_VALIDATOR,
      controlsCaller: true,
    });
    const { status, body } = await respond({
      validatorSCA: ONCHAIN_VALIDATOR, // caller controls the on-chain one, but DB disagrees
      requestHash: REQUEST_HASH,
      passed: true,
      tag: "disagree",
    });
    assert.equal(status, 403);
    assert.match(body.error, /disagrees with the job's persisted validator/);
    assert.equal(txCalls.length, 0, "no response transaction when DB and on-chain disagree");
  });
});

// ── (d) alternate validator on a job-linked request cannot bypass ────────────
describe("(d) client-supplied alternate validator cannot bypass the designated check", () => {
  it("job-linked, caller controls ALTERNATE, supplies ALTERNATE -> rejected", async () => {
    resetScenario({ policy: policyRow(), onChainValidator: ONCHAIN_VALIDATOR, controlsCaller: true });
    const { status, body } = await respond({
      validatorSCA: ALTERNATE_VALIDATOR,
      requestHash: REQUEST_HASH,
      passed: true,
      tag: "alt",
    });
    assert.equal(status, 403);
    assert.match(body.error, /not the designated validator/);
    assert.equal(txCalls.length, 0);
  });
});

// ── static wiring proofs (source-level) ──────────────────────────────────────
describe("static wiring proofs (source-level)", () => {
  const agentRoute = read("src/app/api/agent/validation/route.ts");
  const policyLib = read("src/lib/jobs/jobValidationPolicy.ts");

  it("respond path resolves the authoritative designated validator BEFORE creating the tx", () => {
    assert.match(agentRoute, /resolveResponseValidator/);
    const resolveIdx = agentRoute.indexOf("await resolveResponseValidator(requestHash)");
    const mismatchIdx = agentRoute.indexOf("You are not the designated validator");
    // The respond path's createContractExecutionTransaction is the one AFTER the
    // mismatch 403 (the earlier occurrence belongs to the request action).
    const createTxIdx = agentRoute.indexOf("createContractExecutionTransaction", mismatchIdx);
    assert.ok(resolveIdx > 0 && mismatchIdx > resolveIdx, "designation check must come first");
    assert.ok(createTxIdx > mismatchIdx, "tx creation must come only after the mismatch 403");
    assert.match(agentRoute, /walletAddress: designated\.validatorAddress/);
  });

  it("ownership gate is not weakened (verifyCallerControlsAddress on validatorSCA still present)", () => {
    assert.match(agentRoute, /verifyCallerControlsAddress\(request, validatorSCA\)/);
    assert.match(agentRoute, /You do not control the wallet named in validatorSCA/);
  });

  it("job-backed DB sync is still AFTER on-chain success and non-fatal", () => {
    const waitIdx = agentRoute.indexOf("const txHash = await waitForTx(circleClient, tx.data.id);");
    const syncIdx = agentRoute.indexOf("syncJobValidationResponseByRequestHash(requestHash, txHash, passed, tag)");
    assert.ok(waitIdx > 0 && syncIdx > waitIdx, "DB sync only after tx succeeded");
    assert.match(agentRoute, /job-validation DB sync failed \(non-fatal\)/);
  });

  it("helper resolves on-chain as the single authoritative source and fails closed on disagreement", () => {
    assert.match(policyLib, /export async function resolveResponseValidator/);
    assert.match(policyLib, /getOnChainValidationStatus/);
    assert.match(policyLib, /onChainValidator !== policy\.validatorSCA\.toLowerCase\(\)/);
    assert.match(policyLib, /disagrees with the job's persisted validator/);
    assert.match(policyLib, /on-chain validation status unavailable/);
  });
});

await run();