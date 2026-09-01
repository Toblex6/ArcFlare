/**
 * scripts/external-wallet-e2e.mjs
 *
 * End-to-end proof that external-wallet actions execute REAL transactions and
 * that domain state only changes after authoritative on-chain verification.
 *
 * The "external wallet" is a viem walletClient driven by the test with a real
 * funded private key (ESCROW_ADMIN_PRIVATE_KEY / EOA_PRIVATE_KEY from .env).
 * That is exactly what a browser EOA does when it broadcasts: it signs and
 * submits a transaction to the network. The server sees an ordinary EOA
 * transaction and must verify it before recording success.
 *
 * Requires:
 *   - a dev server at TEST_BASE_URL (default http://localhost:3000) running
 *     with .env.local so MERCHANT_JWT_SECRET matches the minted cookies
 *   - .env loaded by this script for the testnet private keys
 *   - funded test wallets (ESCROW_ADMIN_PRIVATE_KEY = 0x46dfEDe… ~8 USDC)
 *
 * Covers:
 *   1. escrow-link funding happy path (real approve + createEscrow broadcast)
 *   2. escrow-link attack: a valid tx for ANOTHER escrow request must NOT
 *      activate this request
 *   3. external-wallet escrow release (real confirmDelivery broadcasts)
 *   4. external-wallet escrow dispute (real dispute broadcast + event)
 *   5. external-wallet payroll (real USDC.transfer per recipient)
 *   6. tampering: a broadcast that differs from the queued intent is rejected
 *   7. replay: the same txHash can never execute the action twice
 *   8. fake hash: a fabricated txHash never produces domain success
 *   9. legacy signature requests are refused (never fabricated)
 *  10. static: no synthetic-hash generator remains anywhere
 *
 * Run:  node scripts/external-wallet-e2e.mjs
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createWalletClient, createPublicClient, http, parseUnits, keccak256, toBytes, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

// ── env: .env.local first (matches the dev server's secrets), then .env ────
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";

const RPC = process.env.ARC_TESTNET_RPC_FALLBACKS?.split(",")[0]?.trim() || "https://rpc.drpc.testnet.arc.io";

const CHAIN = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ARC", symbol: "ARC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  testnet: true,
};

const USDC = "0x3600000000000000000000000000000000000000";
const ESCROW_CONTRACT = process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || "0xEb810aeD24D2314dB7471E44bf6DE89f017631E0";

// Funded test wallets
const DEPOSITOR_KEY = process.env.ESCROW_ADMIN_PRIVATE_KEY; // 0x46dfEDe… (escrow admin, ~8 USDC)
const BENEFICIARY_KEY = process.env.EOA_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY; // 0x0d9Dc173…
const PAYROLL_PAYER_KEY = DEPOSITOR_KEY;

const DEPOSITOR = getAddress(privateKeyToAccount(DEPOSITOR_KEY).address);
const BENEFICIARY = getAddress(privateKeyToAccount(BENEFICIARY_KEY).address);
const PAYROLL_PAYER = getAddress(privateKeyToAccount(PAYROLL_PAYER_KEY).address);

const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const escrowAbi = [
  {
    name: "createEscrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "beneficiary", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "condition", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "confirmDelivery",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "escrowId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "dispute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "escrowId", type: "bytes32" },
      { name: "reason", type: "string" },
    ],
    outputs: [],
  },
];
const usdcAbi = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
];

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e.message || String(e) });
    console.error(`  ✗ ${name} — ${e.message || e}`);
  }
}
const ok = (cond, label) => {
  if (!cond) throw new Error(label);
};

const TEST_PASSWORD = "extwallet-e2e-pass-2026";

async function loginMerchantCookie(email) {
  // Login via the real route so the cookie is minted with the SERVER's JWT
  // secret (which may differ from what this script's dotenv sees).
  const res = await fetch(`${BASE}/api/merchant/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  if (!res.ok) throw new Error(`merchant login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/merchant_token=([^;]+)/);
  if (!match) throw new Error("no merchant_token in login response");
  return `merchant_token=${match[1]}`;
}

async function createTestMerchant(walletAddress) {
  const email = `e2e-extwal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const merchant = await prisma.merchant.create({
    data: {
      email,
      businessName: `ExtWallet E2E ${walletAddress.slice(0, 6)}`,
      passwordHash: await bcrypt.hash(TEST_PASSWORD, 10),
      walletProvider: "METAMASK",
      walletAddress,
      verified: true,
      active: true,
      apiKey: `arc_live_extwal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return merchant;
}

async function createEscrowLink(merchant, cookie, { beneficiarySCA, amount, condition }) {
  const res = await fetch(`${BASE}/api/merchant/escrow-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ beneficiarySCA, amount, deadlineHours: 24, condition }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`escrow-link create failed: ${res.status} ${data.error || "?"}`);
  return data;
}

async function broadcastCreateEscrow(privKey, { onchainId, beneficiary, amountUsdc, deadlineTimestamp, condition }) {
  const account = privateKeyToAccount(privKey);
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
  const amountWei = parseUnits(amountUsdc.toFixed(6), 6);
  const approveHash = await wallet.writeContract({
    address: USDC,
    abi: usdcAbi,
    functionName: "approve",
    args: [ESCROW_CONTRACT, amountWei],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  const createHash = await wallet.writeContract({
    address: ESCROW_CONTRACT,
    abi: escrowAbi,
    functionName: "createEscrow",
    args: [onchainId, beneficiary, amountWei, deadlineTimestamp, condition],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (receipt.status !== "success") throw new Error("createEscrow reverted");
  return createHash;
}

async function broadcastConfirmDelivery(privKey, onchainId) {
  const account = privateKeyToAccount(privKey);
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
  const hash = await wallet.writeContract({
    address: ESCROW_CONTRACT,
    abi: escrowAbi,
    functionName: "confirmDelivery",
    args: [onchainId],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("confirmDelivery reverted");
  return hash;
}

async function broadcastDispute(privKey, onchainId, reason) {
  const account = privateKeyToAccount(privKey);
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
  const hash = await wallet.writeContract({
    address: ESCROW_CONTRACT,
    abi: escrowAbi,
    functionName: "dispute",
    args: [onchainId, reason],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("dispute reverted");
  return hash;
}

async function broadcastUsdcTransfer(privKey, to, amountUsdc) {
  const account = privateKeyToAccount(privKey);
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
  const amountWei = parseUnits(amountUsdc.toFixed(6), 6);
  const hash = await wallet.writeContract({
    address: USDC,
    abi: usdcAbi,
    functionName: "transfer",
    args: [to, amountWei],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("USDC transfer reverted");
  return hash;
}

async function submitTxHash(merchant, requestId, txHash) {
  const res = await fetch(`${BASE}/api/merchant/wallet/sign-requests/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": merchant.apiKey },
    body: JSON.stringify({ txHash }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function getEscrowOnChain(onchainId) {
  return publicClient.readContract({
    address: ESCROW_CONTRACT,
    abi: [
      { name: "getEscrow", type: "function", stateMutability: "view", inputs: [{ name: "escrowId", type: "bytes32" }], outputs: [{ type: "tuple", components: [
        { name: "depositor", type: "address" }, { name: "beneficiary", type: "address" }, { name: "amount", type: "uint256" },
        { name: "deadline", type: "uint256" }, { name: "ref", type: "string" }, { name: "depositorConfirmed", type: "bool" }, { name: "beneficiaryConfirmed", type: "bool" },
      ] }] },
    ],
    functionName: "getEscrow",
    args: [onchainId],
  });
}

// ── static proofs ────────────────────────────────────────────────────────────
function staticProofs() {
  console.log("═══ Static proofs — no synthetic-hash success path ═══");
  const allFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git" || entry.name === "stubs") continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(entry.name)) allFiles.push(p);
    }
  };
  walk(join(here, "..", "src"));
  const haystacks = {
    "function named externalTxHash (old fabricator)": /function\s+externalTxHash\s*\(/i,
    "sha256-based synthetic hash (non-chain data → 0x..64)": /createHash\s*\(\s*["']sha256["']\s*\)[\s\S]{0,200}?\.slice\s*\(\s*0\s*,\s*64\s*\)/i,
    "signature-only resume engine import": /from\s+["']@\/lib\/wallet\/signatureResume["']|resumeSignatureRequest\s*\(/,
    "fake explorer URL built from a request id": /arcscan\.app\/tx\/\$\{?[^}]*(requestId|req\.id|Date\.now|Math\.random)/i,
  };
  for (const [label, re] of Object.entries(haystacks)) {
    const hits = allFiles.filter((f) => re.test(readFileSync(f, "utf8")));
    ok(hits.length === 0, `${label} must be absent (found in ${hits.join(", ") || "none"})`);
    console.log(`  ✓ ${label} absent`);
  }
  ok(!existsSync(join(here, "..", "src", "lib", "wallet", "signatureResume.ts")), "signatureResume.ts is deleted");
  console.log("  ✓ signatureResume.ts (fake-hash engine) deleted");

  const resume = readFileSync(join(here, "..", "src", "lib", "wallet", "transactionVerification.ts"), "utf8");
  ok(resume.includes("getReceiptReliable") && resume.includes('receipt.status !== "success"'), "verification requires an authoritative receipt");
  console.log("  ✓ verification requires an authoritative receipt");

  const stop = readFileSync(join(here, "..", "src", "app", "api", "payments", "stream", "stop", "route.ts"), "utf8");
  const withdraw = readFileSync(join(here, "..", "src", "app", "api", "payments", "stream", "withdraw", "route.ts"), "utf8");
  ok(stop.includes("STREAM_ABI_CONFIG_CONFLICT") && withdraw.includes("STREAM_ABI_CONFIG_CONFLICT"), "stream stop/withdraw fail closed on the ABI conflict");
  console.log("  ✓ stream stop/withdraw fail closed (ABI conflict)");

  const fund = readFileSync(join(here, "..", "src", "app", "api", "escrow", "link", "[reference]", "fund", "route.ts"), "utf8");
  ok(fund.includes("EscrowCreated") && fund.includes("created.escrowId") && fund.includes("keccak256(toBytes(reference))"), "fund route proves the exact escrow via the EscrowCreated event");
  console.log("  ✓ fund route decodes EscrowCreated and binds escrowId to keccak256(reference)");
}

// ── main ─────────────────────────────────────────────────────────────────────
const start = Date.now();
console.log("═══════ External-wallet E2E ═══════");
console.log(`BASE=${BASE} RPC=${RPC}`);
console.log(`DEPOSITOR(payer)=${DEPOSITOR} BENEFICIARY=${BENEFICIARY}`);

let merchantA, merchantB, cookieA, cookieB;
let testStreamRef = null;

try {
  staticProofs();

  // server reachability
  await fetch(`${BASE}/api/escrow/link/nope`, { signal: AbortSignal.timeout(5000) });
  console.log(`\n═══ Live route tests (server at ${BASE}) ═══`);

  // ── setup merchants ──────────────────────────────────────────────────────
  merchantA = await createTestMerchant(DEPOSITOR);
  merchantB = await createTestMerchant(BENEFICIARY);
  cookieA = await loginMerchantCookie(merchantA.email);
  cookieB = await loginMerchantCookie(merchantB.email);

  const depUsdc = Number(await publicClient.readContract({ address: USDC, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] }], functionName: "balanceOf", args: [DEPOSITOR] })) / 1e6;
  if (depUsdc < 2) throw new Error(`Depositor ${DEPOSITOR} has only ${depUsdc.toFixed(3)} USDC — need >= 2 for the suite`);
  console.log(`\nDepositor USDC balance: ${depUsdc.toFixed(4)}`);

  // ── 1. escrow-link happy path (real external-wallet funding) ─────────────
  console.log("\n── 1. escrow-link funding (real external-wallet broadcast) ──");
  let R1;
  await test("create escrow request R1 (0.5 USDC → beneficiary)", async () => {
    R1 = await createEscrowLink(merchantA, cookieA, { beneficiarySCA: BENEFICIARY, amount: 0.5, condition: "Deliver the report" });
    ok(R1.escrow.status === "PENDING_FUNDING", "R1 starts PENDING_FUNDING");
    ok(R1.escrow.contractEscrowId === keccak256(toBytes(R1.reference)), "contractEscrowId == keccak256(reference)");
  });

  let R1_TX;
  await test("external wallet broadcasts approve + createEscrow (real tx)", async () => {
    const deadline = BigInt(Math.floor(new Date(R1.deadline).getTime() / 1000));
    R1_TX = await broadcastCreateEscrow(DEPOSITOR_KEY, {
      onchainId: R1.escrow.contractEscrowId,
      beneficiary: BENEFICIARY,
      amountUsdc: 0.5,
      deadlineTimestamp: deadline,
      condition: "Deliver the report",
    });
    ok(/^0x[a-f0-9]{64}$/.test(R1_TX), "got a real txHash");
    console.log(`    createEscrow tx: ${R1_TX}`);
  });

  await test("fund route records R1 ACTIVE after verifying the real tx", async () => {
    const res = await fetch(`${BASE}/api/escrow/link/${R1.reference}/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depositorSCA: DEPOSITOR, txHash: R1_TX }),
    });
    const data = await res.json();
    ok(res.ok && data.success, `fund accepted (${res.status})`);
    ok(data.escrow.status === "ACTIVE", "R1 → ACTIVE");
    const db = await prisma.escrow.findUnique({ where: { reference: R1.reference } });
    ok(db.status === "ACTIVE" && db.depositorSCA.toLowerCase() === DEPOSITOR.toLowerCase(), "DB row ACTIVE with depositor");
    const onchain = await getEscrowOnChain(R1.escrow.contractEscrowId);
    ok(onchain.depositor.toLowerCase() === DEPOSITOR.toLowerCase() && onchain.beneficiary.toLowerCase() === BENEFICIARY.toLowerCase(), "on-chain state matches");
  });

  // ── 2. escrow-link attack: R2's tx must NOT activate an unrelated request ─
  console.log("\n── 2. escrow-link attack (valid tx for another request must not fund) ──");
  let R2;
  await test("create escrow request R2", async () => {
    R2 = await createEscrowLink(merchantA, cookieA, { beneficiarySCA: BENEFICIARY, amount: 0.4, condition: "Different escrow" });
  });
  let R2_TX;
  await test("fund R2 with a real (different) escrow transaction", async () => {
    const deadline = BigInt(Math.floor(new Date(R2.deadline).getTime() / 1000));
    R2_TX = await broadcastCreateEscrow(DEPOSITOR_KEY, {
      onchainId: R2.escrow.contractEscrowId,
      beneficiary: BENEFICIARY,
      amountUsdc: 0.4,
      deadlineTimestamp: deadline,
      condition: "Different escrow",
    });
    const res = await fetch(`${BASE}/api/escrow/link/${R2.reference}/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depositorSCA: DEPOSITOR, txHash: R2_TX }),
    });
    const data = await res.json();
    ok(res.ok && data.success, `R2 funded (${res.status})`);
  });

  await test("submitting R2's txHash to an UNRELATED pending request MUST be rejected (escrowId mismatch)", async () => {
    const R_att = await createEscrowLink(merchantA, cookieA, { beneficiarySCA: BENEFICIARY, amount: 0.3, condition: "Victim request" });
    ok(R_att.escrow.contractEscrowId !== R2.escrow.contractEscrowId, "different onchainIds (different references)");
    const res = await fetch(`${BASE}/api/escrow/link/${R_att.reference}/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depositorSCA: DEPOSITOR, txHash: R2_TX }),
    });
    const data = await res.json();
    ok(res.status === 400, `rejected with 400 (got ${res.status})`);
    ok(data.success === false, "not accepted");
    const db = await prisma.escrow.findUnique({ where: { reference: R_att.reference } });
    ok(db.status === "PENDING_FUNDING" && !db.txHash, "victim request untouched (still PENDING_FUNDING, no tx recorded)");
  });

  // ── 3. external-wallet escrow release (real confirmDelivery) ──────────────
  console.log("\n── 3. external-wallet escrow release (real confirmDelivery) ──");
  let releaseReqA;
  let releaseReqB;
  await test("Merchant A (depositor) queues a release transaction request", async () => {
    const res = await fetch(`${BASE}/api/escrow/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": merchantA.apiKey },
      body: JSON.stringify({ reference: R1.reference, callerSCA: DEPOSITOR }),
    });
    const data = await res.json();
    ok(res.ok && data.pendingSignature, `release returned a pending transaction request (${res.status})`);
    releaseReqA = data.requestId;
    ok(data.transaction && data.transaction.abiFunctionSignature === "confirmDelivery(bytes32)", "intent is confirmDelivery(bytes32)");
    ok(data.transaction.from.toLowerCase() === DEPOSITOR.toLowerCase(), "intent bound to the depositor wallet");
  });

  await test("wallet broadcasts confirmDelivery → real txHash verified → depositor confirmed", async () => {
    const confirmTx = await broadcastConfirmDelivery(DEPOSITOR_KEY, R1.escrow.contractEscrowId);
    const { status, data } = await submitTxHash(merchantA, releaseReqA, confirmTx);
    ok(status === 200 && data.success, `verification accepted (${status} ${data.error || ""})`);
    const db = await prisma.escrow.findUnique({ where: { reference: R1.reference } });
    ok(db.depositorConfirmed === true && db.beneficiaryConfirmed === false, "depositor confirmed, still ACTIVE");
    ok(db.status === "ACTIVE", "not released until both parties confirm");
    console.log(`    confirm tx: ${confirmTx}`);
  });

  await test("Merchant B (beneficiary) queues + broadcasts confirmDelivery → RELEASED", async () => {
    const res = await fetch(`${BASE}/api/escrow/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": merchantB.apiKey },
      body: JSON.stringify({ reference: R1.reference, callerSCA: BENEFICIARY }),
    });
    const data = await res.json();
    ok(res.ok && data.pendingSignature, "beneficiary release request queued");
    releaseReqB = data.requestId;
    const confirmTx = await broadcastConfirmDelivery(BENEFICIARY_KEY, R1.escrow.contractEscrowId);
    const submit = await submitTxHash(merchantB, data.requestId, confirmTx);
    ok(submit.status === 200 && submit.data.success, `beneficiary verification accepted (${submit.status} ${submit.data.error || ""})`);
    const db = await prisma.escrow.findUnique({ where: { reference: R1.reference } });
    ok(db.status === "RELEASED" && db.releaseTxHash === confirmTx, "escrow RELEASED with the real release txHash");
    console.log(`    release tx: ${confirmTx}`);
  });

  // ── 7. replay of the release request ──────────────────────────────────────
  console.log("\n── 7. replay: same request + same txHash cannot re-execute ──");
  await test("resubmitting the same release request/txHash replays, never double-releases", async () => {
    // The RELEASE happened on the beneficiary's request — replay THAT one.
    const reqRow = await prisma.walletSignatureRequest.findUnique({ where: { id: releaseReqB } });
    ok(reqRow && reqRow.status === "COMPLETED", "beneficiary release request completed");
    const { status, data } = await submitTxHash(merchantB, releaseReqB, reqRow.signedTx);
    ok(status === 200 && data.success && data.resumed === true, "idempotent replay");
    ok(data.txHash === reqRow.signedTx, "replayed the SAME real txHash");
    const db = await prisma.escrow.findUnique({ where: { reference: R1.reference } });
    ok(db.status === "RELEASED" && db.releaseTxHash === reqRow.signedTx, "state unchanged by replay");
  });

  // ── 4. external-wallet escrow dispute (real dispute broadcast) ────────────
  console.log("\n── 4. external-wallet escrow dispute (real dispute broadcast) ──");
  let R3;
  await test("create + fund escrow request R3 for the dispute", async () => {
    R3 = await createEscrowLink(merchantA, cookieA, { beneficiarySCA: BENEFICIARY, amount: 0.4, condition: "Dispute me" });
    const deadline = BigInt(Math.floor(new Date(R3.deadline).getTime() / 1000));
    const tx = await broadcastCreateEscrow(DEPOSITOR_KEY, {
      onchainId: R3.escrow.contractEscrowId,
      beneficiary: BENEFICIARY,
      amountUsdc: 0.4,
      deadlineTimestamp: deadline,
      condition: "Dispute me",
    });
    const res = await fetch(`${BASE}/api/escrow/link/${R3.reference}/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depositorSCA: DEPOSITOR, txHash: tx }),
    });
    ok((await res.json()).success, "R3 funded");
  });

  let disputeReq;
  await test("Merchant A queues a dispute transaction request", async () => {
    const res = await fetch(`${BASE}/api/escrow/dispute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": merchantA.apiKey },
      body: JSON.stringify({ reference: R3.reference, callerSCA: DEPOSITOR, reason: "Work not delivered" }),
    });
    const data = await res.json();
    ok(res.ok && data.pendingSignature, "dispute request queued");
    disputeReq = data.requestId;
    ok(data.transaction.abiFunctionSignature === "dispute(bytes32,string)", "intent is dispute(bytes32,string)");
  });

  await test("wallet broadcasts dispute → real txHash verified → DISPUTED", async () => {
    const disputeTx = await broadcastDispute(DEPOSITOR_KEY, R3.escrow.contractEscrowId, "Work not delivered");
    const { status, data } = await submitTxHash(merchantA, disputeReq, disputeTx);
    ok(status === 200 && data.success, `dispute verification accepted (${status} ${data.error || ""})`);
    const db = await prisma.escrow.findUnique({ where: { reference: R3.reference } });
    ok(db.status === "DISPUTED" && db.disputeTxHash === disputeTx, "escrow DISPUTED with the real dispute txHash");
    ok(db.disputeReason === "Work not delivered", "reason recorded");
    console.log(`    dispute tx: ${disputeTx}`);
  });

  // ── 8. fake hash ───────────────────────────────────────────────────────────
  console.log("\n── 8. fake hash never produces domain success ──");
  await test("a fabricated txHash is rejected and escrow stays ACTIVE", async () => {
    // Create a fresh escrow-link request + fund it for this test.
    const Rf = await createEscrowLink(merchantA, cookieA, { beneficiarySCA: BENEFICIARY, amount: 0.1, condition: "Fake hash test" });
    const deadline = BigInt(Math.floor(new Date(Rf.deadline).getTime() / 1000));
    const tx = await broadcastCreateEscrow(DEPOSITOR_KEY, {
      onchainId: Rf.escrow.contractEscrowId, beneficiary: BENEFICIARY, amountUsdc: 0.1, deadlineTimestamp: deadline, condition: "Fake hash test",
    });
    const fundRes = await fetch(`${BASE}/api/escrow/link/${Rf.reference}/fund`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ depositorSCA: DEPOSITOR, txHash: tx }) });
    ok((await fundRes.json()).success, "funded");

    const relRes = await fetch(`${BASE}/api/escrow/release`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": merchantA.apiKey }, body: JSON.stringify({ reference: Rf.reference, callerSCA: DEPOSITOR }) });
    const relData = await relRes.json();
    ok(relData.pendingSignature, "release request queued");

    const fakeHash = "0x" + "ab".repeat(32);
    const { status, data } = await submitTxHash(merchantA, relData.requestId, fakeHash);
    ok(status !== 200, `fabricated hash rejected (${status})`);
    ok(!data.success, "not accepted");

    const db = await prisma.escrow.findUnique({ where: { reference: Rf.reference } });
    ok(db.status === "ACTIVE" && db.depositorConfirmed === false, "escrow untouched by fake hash");
    const req = await prisma.walletSignatureRequest.findUnique({ where: { id: relData.requestId } });
    ok(req.status === "FAILED", "request marked FAILED (no fabricated COMPLETED)");
  });

  // ── 6. tampering: broadcast differs from queued intent ────────────────────
  console.log("\n── 6. tampering: a broadcast that differs from the intent is rejected ──");
  await test("payroll: broadcasting a DIFFERENT amount/destination is rejected", async () => {
    const payRes = await fetch(`${BASE}/api/payroll/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": merchantA.apiKey },
      body: JSON.stringify({ recipients: [{ recipientSCA: BENEFICIARY, amount: "0.1", label: "tamper-1" }] }),
    });
    const payData = await payRes.json();
    ok(payData.success && payData.status === "AWAITING_SIGNATURES", "external payroll batch queued");
    const entry = payData.results[0];
    ok(entry.status === "PENDING_SIGNATURE" && entry.requestId, "recipient awaiting signature");

    // The wallet broadcasts a DIFFERENT amount (0.05 instead of 0.1) — the
    // signed intent was 0.1; the broadcast must match it.
    const wrongTx = await broadcastUsdcTransfer(DEPOSITOR_KEY, BENEFICIARY, 0.05);
    const { status, data } = await submitTxHash(merchantA, entry.requestId, wrongTx);
    ok(status === 422, `wrong-amount transfer rejected (${status})`);
    ok(!data.success, "not accepted");
    const batch = await prisma.payrollBatch.findUnique({ where: { batchRef: payData.batchRef } });
    const row = batch.results[0];
    ok(row.status === "PENDING_SIGNATURE", "recipient NOT marked SUCCESS by the wrong transfer");
  });

  // ── 5. external-wallet payroll (real transfers) ───────────────────────────
  console.log("\n── 5. external-wallet payroll (real USDC.transfer per recipient) ──");
  let payBatch;
  await test("run a 2-recipient payroll batch (AWAITING_SIGNATURES)", async () => {
    const res = await fetch(`${BASE}/api/payroll/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": merchantA.apiKey },
      body: JSON.stringify({ recipients: [{ recipientSCA: BENEFICIARY, amount: "0.1", label: "EMP-1" }, { recipientSCA: DEPOSITOR, amount: "0.2", label: "EMP-2" }] }),
    });
    const data = await res.json();
    ok(data.success && data.status === "AWAITING_SIGNATURES", `batch queued (${data.status})`);
    ok(data.results.every((r) => r.status === "PENDING_SIGNATURE"), "all recipients PENDING_SIGNATURE");
    ok(data.results.every((r) => !r.txHash), "no txHash fabricated before broadcast");
    payBatch = data;
  });

  await test("broadcast recipient 1 transfer → verified SUCCESS", async () => {
    const entry = payBatch.results[0];
    const tx = await broadcastUsdcTransfer(DEPOSITOR_KEY, entry.recipientSCA, Number(entry.amount));
    const { status, data } = await submitTxHash(merchantA, entry.requestId, tx);
    ok(status === 200 && data.success, `recipient 1 verified (${status})`);
    const batch = await prisma.payrollBatch.findUnique({ where: { batchRef: payBatch.batchRef } });
    const row = batch.results[0];
    ok(row.status === "SUCCESS" && row.txHash === tx, "recipient 1 SUCCESS with real txHash");
    ok(row.explorerUrl === `https://testnet.arcscan.app/tx/${tx}`, "explorer URL from real txHash");
    ok(batch.status === "AWAITING_SIGNATURES", "batch still awaiting signature 2");
  });

  await test("broadcast recipient 2 transfer → verified SUCCESS → batch COMPLETED", async () => {
    const entry = payBatch.results[1];
    const tx = await broadcastUsdcTransfer(DEPOSITOR_KEY, entry.recipientSCA, Number(entry.amount));
    const { status, data } = await submitTxHash(merchantA, entry.requestId, tx);
    ok(status === 200 && data.success, `recipient 2 verified (${status})`);
    const batch = await prisma.payrollBatch.findUnique({ where: { batchRef: payBatch.batchRef } });
    ok(batch.status === "COMPLETED", "batch COMPLETED");
    ok(batch.successCount === 2, "successCount 2");
    ok(batch.results.every((r) => r.status === "SUCCESS" && /^0x[a-f0-9]{64}$/.test(r.txHash)), "every result has a real txHash");
  });

  await test("payroll replay: same recipient request + same txHash replays, no double-pay", async () => {
    const entry = payBatch.results[0];
    const rowBefore = await prisma.payrollBatch.findUnique({ where: { batchRef: payBatch.batchRef } });
    const { status, data } = await submitTxHash(merchantA, entry.requestId, rowBefore.results[0].txHash);
    ok(status === 200 && data.success && data.resumed === true, "replayed");
    const rowAfter = await prisma.payrollBatch.findUnique({ where: { batchRef: payBatch.batchRef } });
    ok(rowAfter.successCount === 2, "successCount unchanged (no double execution)");
  });

  // ── 9. legacy signature request refused ────────────────────────────────────
  console.log("\n── 9. legacy signature-only requests are refused ──");
  await test("a legacy personal-sign request row can never fabricate success", async () => {
    const legacy = await prisma.walletSignatureRequest.create({
      data: {
        merchantId: merchantA.id,
        action: "escrow.release",
        actionRefId: "legacy-test",
        payload: { reference: R1.reference, contractEscrowId: R1.escrow.contractEscrowId, callerSCA: DEPOSITOR },
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const fakeHash = "0x" + "cd".repeat(32);
    const { status } = await submitTxHash(merchantA, legacy.id, fakeHash);
    ok(status === 410, `legacy request refused (${status})`);
    const db = await prisma.escrow.findUnique({ where: { reference: R1.reference } });
    ok(db.status === "RELEASED", "escrow state untouched by legacy request submission");
  });

  // ── 10. stream stop/withdraw fail closed ───────────────────────────────────
  console.log("\n── 10. stream stop/withdraw fail closed (ABI conflict) ──");
  await test("POST /api/payments/stream/stop rejects with the config conflict", async () => {
    const stream = await prisma.stream.create({
      data: {
        reference: `stream_test_${Date.now()}`,
        senderSCA: DEPOSITOR,
        receiverSCA: BENEFICIARY,
        ratePerSecond: 0.001,
        totalDeposited: 1,
        totalStreamed: 0,
        status: "ACTIVE",
        contractAddress: process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || "",
        txHash: "0x" + "11".repeat(32),
      },
    });
    testStreamRef = stream.reference;
    const res = await fetch(`${BASE}/api/payments/stream/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.INTERNAL_SETTLEMENT_API_KEY || merchantA.apiKey },
      body: JSON.stringify({ reference: stream.reference, callerSCA: DEPOSITOR }),
    });
    const data = await res.json();
    ok(res.status === 501, `stop rejected 501 (got ${res.status})`);
    ok(data.code === "STREAM_ABI_CONFIG_CONFLICT", "config-conflict code");
    const row = await prisma.stream.findUnique({ where: { reference: stream.reference } });
    ok(row.status === "ACTIVE", "stream row unchanged (no fabricated STOPPED)");
  });

  await test("POST /api/payments/stream/withdraw rejects with the config conflict", async () => {
    const res = await fetch(`${BASE}/api/payments/stream/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.INTERNAL_SETTLEMENT_API_KEY || merchantA.apiKey },
      body: JSON.stringify({ reference: testStreamRef, receiverSCA: BENEFICIARY }),
    });
    const data = await res.json();
    ok(res.status === 501, `withdraw rejected 501 (got ${res.status})`);
    ok(data.code === "STREAM_ABI_CONFIG_CONFLICT", "config-conflict code");
  });
} catch (e) {
  fail++;
  failures.push({ name: "setup", error: e.message || String(e) });
  console.error(`✗ SETUP FAILED: ${e.message}`);
} finally {
  if (merchantA) await prisma.merchant.delete({ where: { id: merchantA.id } }).catch(() => {});
  if (merchantB) await prisma.merchant.delete({ where: { id: merchantB.id } }).catch(() => {});
  if (testStreamRef) await prisma.stream.delete({ where: { reference: testStreamRef } }).catch(() => {});
  await prisma.$disconnect().catch(() => {});
}

console.log("\n═══════ Results ═══════");
console.log(`${pass} passed, ${fail} failed (${((Date.now() - start) / 1000).toFixed(1)}s)`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
}
process.exit(fail ? 1 : 0);
