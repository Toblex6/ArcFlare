/**
 * payroll-external-verification-tests.ts
 *
 * Proves src/lib/wallet/transactionVerification.ts is token-aware for
 * external-wallet payroll (tx.payroll.transfer):
 *
 *   1. USDC external transfer verifies (recipient + amount + USDC contract).
 *   2. EURC external transfer verifies (recipient + amount + EURC contract).
 *   3. USDC-as-EURC rejected (EURC intent, USDC Transfer log) — fail closed.
 *   4. EURC-as-USDC rejected (USDC intent, EURC Transfer log) — fail closed.
 *   5. Wrong recipient rejected (per-token).
 *   6. Wrong amount rejected (per-token).
 *   7. Unsupported token rejected (unknown symbol / arbitrary ERC-20 fail closed).
 *   8. Decimals driven by the canonical resolver (never hardcoded).
 *   9. Replay/idempotency + status-transition semantics preserved in
 *      transactionResume.ts (static — untouched by this change).
 *
 * Fully hermetic: chain reads (receipt / transaction) are mocked via
 * node:test module mocks. No DB, no RPC, no broadcasts.
 *
 * Run: npx tsx --experimental-test-module-mocks scripts/payroll-external-verification-tests.ts
 */

import { describe, it, mock, run } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// ── Mutable chain scenario consumed by the mocked chainClient ────────────────
const scenario: {
  receipt: any | null;
  txInput: string | null;
} = { receipt: null, txInput: null };

mock.module("@/lib/wallet/chainClient", {
  namedExports: {
    getReceiptReliable: async (_txHash: string) => scenario.receipt,
    getTransactionReliable: async (_txHash: string) =>
      scenario.txInput == null ? null : { input: scenario.txInput },
    extractSelector: (input: string | undefined | null) => {
      if (!input || input === "0x" || input.length < 10) return null;
      return `0x${input.slice(2, 10).toLowerCase()}`;
    },
    readContractReliable: async () => null,
  },
});

const { verifyExternalTransaction, VerificationError } = await import(
  "@/lib/wallet/transactionVerification"
);
const { SUPPORTED_TOKENS } = await import("@/lib/tokens/supportedTokens");
const { resolveCurrency } = await import("@/lib/tokens/resolveCurrency");
const { encodeAbiParameters, encodeEventTopics, parseUnits } = await import("viem");
const { usdcTransferAbi } = await import("@/lib/wallet/flarehqContracts");

const USDC = SUPPORTED_TOKENS.USDC.address;
const EURC = SUPPORTED_TOKENS.EURC.address;
const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "0xcccccccccccccccccccccccccccccccccccccccc";
const TX_HASH =
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const TRANSFER_INPUT = "0xa9059cbb000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function transferLog(token: string, from: string, to: string, value: bigint) {
  const topics = encodeEventTopics({
    abi: usdcTransferAbi as any,
    eventName: "Transfer",
    args: { from: from as any, to: to as any },
  });
  const data = encodeAbiParameters([{ type: "uint256" }], [value]);
  return { address: token, data, topics };
}

function payrollRequest(opts: {
  currency?: string | null;
  tokenAddress?: string | null;
  intentTo?: string;
  recipient?: string;
  payer?: string;
  amount?: string;
}) {
  const currency = opts.currency === undefined ? "USDC" : opts.currency;
  const tokenAddress = opts.tokenAddress === undefined ? USDC : opts.tokenAddress;
  const recipient = opts.recipient ?? RECIPIENT;
  const payer = opts.payer ?? PAYER;
  const amount = opts.amount ?? "10";
  return {
    action: "tx.payroll.transfer",
    payload: {
      kind: "transaction",
      batchRef: "payroll_test_batch",
      recipientSCA: recipient,
      amount,
      currency,
      tokenAddress,
      payerSCA: payer,
      transaction: {
        description: `Payroll payment of ${amount} ${currency} to ${recipient}`,
        chainId: 5042002,
        to: opts.intentTo ?? tokenAddress,
        from: payer,
        abiFunctionSignature: "transfer(address,uint256)",
        args: [recipient, "0"],
        value: "0",
      },
    },
  };
}

/** Point the mocked chain at a successful transfer tx. */
function mockSuccessTx(opts: {
  receiptTo: string;
  receiptFrom?: string;
  logToken: string;
  logFrom?: string;
  logTo?: string;
  logValue?: bigint;
  extraLogs?: any[];
}) {
  scenario.txInput = TRANSFER_INPUT;
  scenario.receipt = {
    status: "success",
    from: opts.receiptFrom ?? PAYER,
    to: opts.receiptTo,
    logs: [
      transferLog(
        opts.logToken,
        opts.logFrom ?? PAYER,
        opts.logTo ?? RECIPIENT,
        opts.logValue ?? parseUnits("10", 6)
      ),
      ...(opts.extraLogs ?? []),
    ],
  };
}

async function rejectsWith(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e: any) {
    assert.ok(
      e instanceof VerificationError,
      `expected VerificationError, got ${e?.constructor?.name}: ${e?.message}`
    );
    return String(e?.message ?? "");
  }
  assert.fail("expected verifyExternalTransaction to throw, but it resolved");
}

describe("payroll external verification is token-aware", () => {
  it("USDC external transfer verifies (recipient + amount + USDC contract)", async () => {
    mockSuccessTx({ receiptTo: USDC, logToken: USDC });
    const out = await verifyExternalTransaction(
      payrollRequest({ currency: "USDC", tokenAddress: USDC }),
      TX_HASH
    );
    assert.equal(out.txHash, TX_HASH);
    assert.equal(out.action, "tx.payroll.transfer");
  });

  it("EURC external transfer verifies (recipient + amount + EURC contract)", async () => {
    mockSuccessTx({ receiptTo: EURC, logToken: EURC });
    const out = await verifyExternalTransaction(
      payrollRequest({ currency: "EURC", tokenAddress: EURC }),
      TX_HASH
    );
    assert.equal(out.txHash, TX_HASH);
    assert.equal(out.action, "tx.payroll.transfer");
  });

  it("USDC-as-EURC rejected: EURC intent is not satisfied by a USDC Transfer", async () => {
    // Intent + receipt target the EURC contract (generic to/from gate passes),
    // but the only Transfer log was emitted by the USDC contract.
    mockSuccessTx({ receiptTo: EURC, logToken: USDC });
    const msg = await rejectsWith(
      verifyExternalTransaction(
        payrollRequest({ currency: "EURC", tokenAddress: EURC }),
        TX_HASH
      )
    );
    assert.match(msg, /EURC/);
  });

  it("EURC-as-USDC rejected: USDC intent is not satisfied by a EURC Transfer", async () => {
    mockSuccessTx({ receiptTo: USDC, logToken: EURC });
    const msg = await rejectsWith(
      verifyExternalTransaction(
        payrollRequest({ currency: "USDC", tokenAddress: USDC }),
        TX_HASH
      )
    );
    assert.match(msg, /USDC/);
  });

  it("wrong recipient rejected (per-token)", async () => {
    mockSuccessTx({ receiptTo: EURC, logToken: EURC, logTo: OTHER });
    await rejectsWith(
      verifyExternalTransaction(
        payrollRequest({ currency: "EURC", tokenAddress: EURC }),
        TX_HASH
      )
    );
  });

  it("wrong amount rejected (per-token)", async () => {
    mockSuccessTx({
      receiptTo: USDC,
      logToken: USDC,
      logValue: parseUnits("9.99", 6),
    });
    await rejectsWith(
      verifyExternalTransaction(
        payrollRequest({
          currency: "USDC",
          tokenAddress: USDC,
          amount: "10",
        }),
        TX_HASH
      )
    );
  });

  it("unsupported token fails closed (unknown symbol / arbitrary ERC-20)", async () => {
    // intent/receipt target match so the failure comes from the token
    // resolver itself (fail closed on unsupported identity, not on routing).
    mockSuccessTx({ receiptTo: USDC, logToken: USDC });
    const badSymbol = await rejectsWith(
      verifyExternalTransaction(
        payrollRequest({ currency: "USDT", tokenAddress: null, intentTo: USDC } as any),
        TX_HASH
      )
    );
    assert.match(badSymbol, /unsupported payroll token/i);
    const arbitrary = "0x1111111111111111111111111111111111111111";
    mockSuccessTx({ receiptTo: arbitrary, logToken: arbitrary });
    const badAddress = await rejectsWith(
      verifyExternalTransaction(
        payrollRequest({ currency: null, tokenAddress: arbitrary } as any),
        TX_HASH
      )
    );
    assert.match(badAddress, /unsupported payroll token/i);
  });

  it("mismatched intent target fails closed (transaction matching per token)", async () => {
    // Queued intent points at USDC while the server context expects EURC.
    mockSuccessTx({ receiptTo: USDC, logToken: USDC });
    const msg = await rejectsWith(
      verifyExternalTransaction(
        payrollRequest({
          currency: "EURC",
          tokenAddress: EURC,
          intentTo: USDC,
        }),
        TX_HASH
      )
    );
    assert.match(msg, /EURC/);
  });

  it("decimals come from the canonical resolver (exact 6-decimal scaling)", async () => {
    assert.equal(resolveCurrency({ currency: "USDC" }).decimals, 6);
    assert.equal(resolveCurrency({ currency: "EURC" }).decimals, 6);
    assert.equal(resolveCurrency({}).decimals, 6);
    // A fractional EURC payment verifies at exact 6-decimal scaling…
    mockSuccessTx({
      receiptTo: EURC,
      logToken: EURC,
      logValue: parseUnits("1.50", 6),
    });
    const out = await verifyExternalTransaction(
      payrollRequest({ currency: "EURC", tokenAddress: EURC, amount: "1.50" }),
      TX_HASH
    );
    assert.equal(out.action, "tx.payroll.transfer");
    // …and an off-by-one-wei log does not satisfy it.
    scenario.receipt = {
      ...scenario.receipt,
      logs: [transferLog(EURC, PAYER, RECIPIENT, parseUnits("1.50", 6) - 1n)],
    };
    await rejectsWith(
      verifyExternalTransaction(
        payrollRequest({ currency: "EURC", tokenAddress: EURC, amount: "1.50" }),
        TX_HASH
      )
    );
  });

  it("legacy queued rows (no currency/tokenAddress) still verify as USDC", async () => {
    mockSuccessTx({ receiptTo: USDC, logToken: USDC });
    const req = payrollRequest({ currency: "USDC", tokenAddress: USDC });
    delete (req.payload as any).currency;
    delete (req.payload as any).tokenAddress;
    const out = await verifyExternalTransaction(req, TX_HASH);
    assert.equal(out.action, "tx.payroll.transfer");
    // …and a legacy row is NOT satisfied by an EURC Transfer.
    mockSuccessTx({ receiptTo: USDC, logToken: EURC });
    await rejectsWith(verifyExternalTransaction(req, TX_HASH));
  });
});

describe("verifier + resume semantics preserved (static)", () => {
  const verifier = read("src/lib/wallet/transactionVerification.ts");
  const resume = read("src/lib/wallet/transactionResume.ts");

  it("expected token resolves through the canonical resolver only", () => {
    assert.match(verifier, /resolveCurrency\(\{\s*currency: payload\.currency/);
    assert.ok(
      !/payload\.tokenAddress\s*\|\|\s*["']0x/i.test(verifier),
      "no client-address fallback outside the resolver"
    );
  });

  it("Transfer event validation is scoped to the expected token contract", () => {
    assert.match(verifier, /decodeTransferLogs\(receipt\.logs \|\| \[\], token\.address\)/);
  });

  it("amount math uses the resolved token decimals (never a hardcoded constant)", () => {
    assert.match(verifier, /parseUnits\(amount, token\.decimals\)/);
    const payrollBlock = verifier.slice(verifier.indexOf("verifyPayrollTransfer"));
    assert.ok(
      !payrollBlock.includes("ARCFLARE_USDC_DECIMALS") &&
        !payrollBlock.includes("ARCFLARE_USDC_CONTRACT"),
      "payroll path must not reference hardcoded USDC constants"
    );
  });

  it("recipient verification preserved", () => {
    assert.match(verifier, /eq\(t\.to, recipient\)/);
    assert.match(verifier, /eq\(t\.from, payer\)/);
  });

  it("receipt / from / to / selector gates preserved", () => {
    assert.match(verifier, /receipt\.status !== "success"/);
    assert.match(verifier, /Transaction was not sent to the intended contract/);
    assert.match(verifier, /Transaction was not sent from the intended wallet/);
    assert.match(verifier, /Transaction calls a different function than intended/);
  });

  it("replay/idempotency + status transitions preserved in the resume executor", () => {
    assert.match(resume, /request\.status === "COMPLETED"/);
    assert.match(resume, /replayed: true/);
    assert.match(resume, /Recipient is already SUCCESS for a different transaction/);
    assert.match(resume, /status: "FAILED", signedTx: txHash/);
    assert.match(resume, /status: "COMPLETED", signedTx: txHash/);
  });
});

await run();
