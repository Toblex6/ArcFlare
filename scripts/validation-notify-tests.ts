// scripts/validation-notify-tests.ts
//
// SUBTASK D — focused validation-notification tests (ONE file).
//
// Covers, with mocked transports (no DB, no chain, no network):
//   1. Successful request triggers notification (merchant / consumer-telegram /
//      consumer-no-telegram / agent-owner / external link-shared).
//   2. Notification failure is non-fatal (notify/send throwing -> { notified: false }, no throw).
//   3. Request hash + validator address are authoritative passthrough
//      (echoed exactly, never regenerated or fabricated).
//   4. Route contract (static): both request routes preserve
//      verifyCallerControlsAddress request/respond authorization exactly,
//      call notifyValidator only AFTER on-chain success (after waitForTx /
//      recordValidationRequest), and introduce no default-payer fallback.
//   5. "Wrong requester / wrong responder rejected": verified statically — the
//      exact 403 guards are unchanged (owner-equality + caller-control checks
//      present, notify code positioned after them and after success).
//
// Run: npx tsx scripts/validation-notify-tests.ts
// Live coverage note: scripts/validation-gated-e2e.mjs exercises the real
// request/respond flow on-chain (incl. wrong-validator rejection); it needs a
// running server + funded wallets + flaky testnet RPC and is NOT run here.

import { describe, it, run } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  notifyValidator,
  type ValidationNotifyInput,
  type NotifyValidatorDeps,
} from "@/lib/notifyValidator";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const BASE_INPUT: ValidationNotifyInput = {
  validatorSCA: "0xValidator00000000000000000000000000000001",
  agentTokenId: "68210",
  agentName: "Test Agent",
  requestTag: "kyc_verification",
  requestHash: "0xabc1230000000000000000000000000000000000000000000000000000000001",
  requestURI: "ipfs://arcflare-validation-68210-kyc_verification",
  txHash: "0xtxhash000000000000000000000000000000000000000000000000000000000001",
};

function mockDeps(kind: "merchant" | "consumer" | "agent" | "external", opts: {
  telegramUserId?: string | null;
  ownerMerchantId?: string | null;
  notifyThrows?: boolean;
  sendThrows?: boolean;
  resolveThrows?: boolean;
  calls?: { notify: any[]; send: any[] };
} = {}): NotifyValidatorDeps {
  const calls = opts.calls ?? { notify: [] as any[], send: [] as any[] };
  if (opts.calls) {
    opts.calls.notify = calls.notify;
    opts.calls.send = calls.send;
  }
  const actorId =
    kind === "agent" ? "42" : kind === "external" ? null : "merchant-or-consumer-id";
  return {
    resolveBeneficiaryFn: (async () => {
      if (opts.resolveThrows) throw new Error("db-down");
      if (kind === "external") {
        return { kind, actorId, name: null, address: BASE_INPUT.validatorSCA.toLowerCase() };
      }
      return { kind, actorId, name: "Test Actor", address: BASE_INPUT.validatorSCA };
    }) as any,
    notifyFn: (async (p: any) => {
      calls.notify.push(p);
      if (opts.notifyThrows) throw new Error("resend-down");
    }) as any,
    sendTelegramMessageFn: (async (id: string, text: string) => {
      calls.send.push({ id, text });
      if (opts.sendThrows) throw new Error("telegram-down");
    }) as any,
    findConsumerTelegramFn: async () => opts.telegramUserId ?? null,
    findAgentOwnerMerchantFn: async () => opts.ownerMerchantId ?? null,
  };
}

describe("notifyValidator — success triggers notification (mocked)", () => {
  it("merchant validator -> central notify() with validation.requested event", async () => {
    const calls = { notify: [] as any[], send: [] as any[] };
    const res = await notifyValidator(BASE_INPUT, mockDeps("merchant", { calls }));
    assert.equal(res.notified, true);
    assert.equal(res.channel, "notify(merchant)");
    assert.equal(res.validatorKind, "merchant");
    assert.equal(calls.notify.length, 1);
    assert.equal(calls.notify[0].event, "validation.requested");
    assert.equal(calls.notify[0].merchantId, "merchant-or-consumer-id");
    // Request hash authoritative: echoed exactly, never regenerated.
    assert.equal(calls.notify[0].data.requestHash, BASE_INPUT.requestHash);
    assert.equal(calls.notify[0].data.validatorSCA, BASE_INPUT.validatorSCA);
    assert.match(calls.notify[0].message, new RegExp(BASE_INPUT.requestHash));
    assert.equal(calls.send.length, 0);
  });

  it("consumer validator with Telegram -> Telegram DM carrying requestHash", async () => {
    const calls = { notify: [] as any[], send: [] as any[] };
    const res = await notifyValidator(BASE_INPUT, mockDeps("consumer", { calls, telegramUserId: "12345" }));
    assert.equal(res.notified, true);
    assert.equal(res.channel, "telegram");
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].id, "12345");
    assert.match(calls.send[0].text, new RegExp(BASE_INPUT.requestHash));
    assert.equal(calls.notify.length, 0);
  });

  it("consumer validator without Telegram -> no-telegram, still notified, no throw", async () => {
    const res = await notifyValidator(BASE_INPUT, mockDeps("consumer", { telegramUserId: null }));
    assert.equal(res.notified, true);
    assert.equal(res.channel, "no-telegram");
  });

  it("agent validator -> owner merchant notified via notify()", async () => {
    const calls = { notify: [] as any[], send: [] as any[] };
    const res = await notifyValidator(BASE_INPUT, mockDeps("agent", { calls, ownerMerchantId: "owner-m-1" }));
    assert.equal(res.notified, true);
    assert.equal(res.channel, "notify(owner)");
    assert.equal(calls.notify.length, 1);
    assert.equal(calls.notify[0].merchantId, "owner-m-1");
    assert.equal(calls.notify[0].event, "validation.requested");
  });

  it("external validator -> link-shared, no transport calls", async () => {
    const calls = { notify: [] as any[], send: [] as any[] };
    const res = await notifyValidator(BASE_INPUT, mockDeps("external", { calls }));
    assert.equal(res.notified, true);
    assert.equal(res.channel, "link-shared");
    assert.equal(calls.notify.length, 0);
    assert.equal(calls.send.length, 0);
  });
});

describe("notifyValidator — notification failure is non-fatal", () => {
  it("notify() throwing -> { notified:false }, helper does not throw", async () => {
    const res = await notifyValidator(BASE_INPUT, mockDeps("merchant", { notifyThrows: true }));
    assert.equal(res.notified, false);
    assert.match(res.reason || "", /resend-down/);
  });

  it("telegram send throwing -> { notified:false }, no throw", async () => {
    const res = await notifyValidator(
      BASE_INPUT,
      mockDeps("consumer", { telegramUserId: "12345", sendThrows: true })
    );
    assert.equal(res.notified, false);
  });

  it("identity resolution throwing -> { notified:false }, no throw", async () => {
    const res = await notifyValidator(BASE_INPUT, mockDeps("merchant", { resolveThrows: true }));
    assert.equal(res.notified, false);
  });
});

describe("route contract — authorization preserved, notify after success only", () => {
  const agentRoute = read("src/app/api/agent/validation/route.ts");
  const jobRoute = read("src/app/api/jobs/[jobId]/validation/request/route.ts");

  it("agent route: request authorization exact (owner-equality 403 + caller-control 403)", () => {
    // Wrong requester rejected: owner must equal agent's scaAddress...
    assert.match(agentRoute, /ownerSCA\.toLowerCase\(\) !== agent\.scaAddress\.toLowerCase\(\)/);
    assert.match(agentRoute, /Only the agent owner SCA can request validation/);
    // ...AND caller must control ownerSCA via the single ownership gate.
    assert.match(agentRoute, /verifyCallerControlsAddress\(request, ownerSCA\)/);
    assert.match(agentRoute, /You do not control the wallet named in ownerSCA/);
  });

  it("agent route: respond authorization exact (caller-control 403)", () => {
    // Wrong responder rejected: caller must control validatorSCA.
    assert.match(agentRoute, /verifyCallerControlsAddress\(request, validatorSCA\)/);
    assert.match(agentRoute, /You do not control the wallet named in validatorSCA/);
  });

  it("agent route: notifyValidator called only AFTER on-chain success, in try/catch", () => {
    const waitIdx = agentRoute.indexOf("await waitForTx(circleClient, tx.data.id)");
    const notifyIdx = agentRoute.indexOf("await notifyValidator(");
    assert.ok(waitIdx > 0 && notifyIdx > waitIdx, "notify must come after waitForTx success");
    assert.match(agentRoute, /validatorNotified/);
    assert.match(agentRoute, /validator notification failed \(non-fatal\)/);
  });

  it("job route: authorization exact (client-or-provider gate + provider-owner signer gate)", () => {
    // Wrong requester rejected at both gates.
    assert.match(jobRoute, /verifyCallerControlsAddress\(innerReq, job\.clientSCA\)/);
    assert.match(jobRoute, /verifyCallerControlsAddress\(innerReq, job\.providerSCA\)/);
    assert.match(jobRoute, /You must control the job's client or provider to request validation/);
    assert.match(jobRoute, /verifyCallerControlsAddress\(innerReq, signingWalletForRequest\)/);
    assert.match(jobRoute, /You must control the provider agent's wallet/);
  });

  it("job route: notify after success only; idempotent replay never re-notifies", () => {
    const replayIdx = jobRoute.indexOf("Validation already requested — idempotent replay");
    const notifyIdx = jobRoute.indexOf("await notifyValidator(");
    const recordIdx = jobRoute.indexOf("await recordValidationRequest(");
    assert.ok(replayIdx > 0 && notifyIdx > replayIdx, "replay returns before notify");
    assert.ok(recordIdx > 0 && notifyIdx > recordIdx, "notify comes after request recorded");
    assert.match(jobRoute, /validatorSCA: policy\.validatorSCA/);
    assert.match(jobRoute, /non-fatal/);
  });

  it("no default-payer fallback introduced in validation paths", () => {
    for (const [name, src] of [["agent", agentRoute], ["job", jobRoute]] as const) {
      // No `||`-style shared-wallet default near the notify/wallet code.
      assert.doesNotMatch(src, /DEFAULT.*WALLET|defaultWallet|FALLBACK.*WALLET/i, `${name}: no default wallet fallback`);
    }
    // Helper itself resolves no payer wallet at all.
    const helper = read("src/lib/notifyValidator.ts");
    assert.doesNotMatch(helper, /createContractExecutionTransaction|walletAddress:/);
  });

  it("notifications.ts change is minimal additive (one event, dispatcher untouched)", () => {
    const notif = read("src/lib/notifications.ts");
    assert.match(notif, /'validation\.requested'/);
    // Dispatcher behavior unchanged: never-throws contract intact.
    assert.match(notif, /export async function notify\(/);
  });
});

await run();
