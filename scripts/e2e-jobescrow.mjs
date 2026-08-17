// ---------------------------------------------------------------------------
// Real testnet E2E for ArcFlareJobEscrow on Arc Testnet.
//
// Run:  npx hardhat run scripts/e2e-jobescrow.mjs --network arc-testnet
//
// Lifecycle exercised: fund -> assign -> submit -> reject -> resubmit -> release
//   - fundJobFor   (relayer, payer = poster)     -> Funded
//   - assignWorker (poster)                      -> Assigned
//   - submitWork   (worker)                      -> Submitted
//   - rejectSubmission (poster, feedbackHash)    -> Rejected
//   - submitWork   (worker, resubmission)        -> Submitted
//   - releaseToWorkerFor (relayer)               -> Released
//
// The poster and worker EOAs sign their own calls directly (the contract only
// has relayer variants for fund/release). Poster = a configured EOA with
// native gas when one is available, else the relayer itself. Worker = a fresh
// wallet, funded with a small amount of native USDC gas by the relayer.
// ---------------------------------------------------------------------------

import { network } from "hardhat";
import { ethers, keccak256, toUtf8Bytes } from "ethers";

const USDC_ADDRESS = process.env.ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const ESCROW_ADDRESS = process.env.JOB_ESCROW_CONTRACT_ADDRESS;
// Native gas on Arc IS USDC. getBalance() returns wei-style 18-decimal units.
// 1e16 wei = 0.01 native-USDC — enough for several submitWork/reject txs.
const WORKER_GAS_AMOUNT = "10000000000000000"; // 1e16 wei

if (!ESCROW_ADDRESS) {
  throw new Error("JOB_ESCROW_CONTRACT_ADDRESS is not set in .env");
}

const ESCROW_ABI = [
  "function fundJobFor(address payer, address token, uint256 budget, bytes32 criteriaHash, uint8 maxRevisions) external returns (uint256 jobId)",
  "function releaseToWorkerFor(uint256 jobId) external",
  "function assignWorker(uint256 jobId, address worker) external",
  "function submitWork(uint256 jobId) external",
  "function rejectSubmission(uint256 jobId, bytes32 feedbackHash) external",
  "function getJob(uint256 jobId) external view returns (tuple(address poster,address worker,address token,uint256 budget,bytes32 criteriaHash,uint8 status,uint64 fundedAt,uint64 assignedAt,uint8 maxRevisions,uint8 revisionCount))",
  "function relayer() external view returns (address)",
  "function nextJobId() external view returns (uint256)",
  "event JobFunded(uint256 indexed jobId, address indexed poster, address token, uint256 budget, bytes32 criteriaHash, uint8 maxRevisions)",
  "event JobRejected(uint256 indexed jobId, uint8 revisionCount, bytes32 feedbackHash)",
  "event JobReleased(uint256 indexed jobId, address indexed worker, uint256 amount)",
];

const ERC20_ABI = [
  "function balanceOf(address owner) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];

const { ethers: hhEthers } = await network.getOrCreate();
const [deployer] = await hhEthers.getSigners();
const provider = deployer.provider;

// Arc's RPC occasionally drops idle/socket connections under a burst of
// rapid requests. Retry reads (never retry a tx *send*) with backoff so a
// transient socket close doesn't kill the whole run.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      const msg = String(e?.cause?.message ?? e?.message ?? e);
      console.warn(`  (retry ${i + 1}/${tries - 1} after RPC error: ${msg.slice(0, 80)})`);
      await sleep(500 * (i + 1));
    }
  }
}

const relayerAddress = await deployer.getAddress();
const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, deployer);
const token = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

const net = await withRetry(() => provider.getNetwork());
console.log("Network          :", net.name, `(chainId ${net.chainId})`);
console.log("Escrow           :", ESCROW_ADDRESS);
console.log("Token            :", USDC_ADDRESS);
console.log("");

// ---- Contract-state probes ----
const onchainRelayer = await withRetry(() => escrow.relayer());
const nextJobId = await withRetry(() => escrow.nextJobId());
const decimals = await withRetry(() => token.decimals());
console.log("escrow.relayer() :", onchainRelayer, onchainRelayer.toLowerCase() === relayerAddress.toLowerCase() ? "(matches RELAYER_PRIVATE_KEY ✓)" : "(MISMATCH ✗)");
console.log("escrow.nextJobId():", nextJobId.toString());
console.log("");

// ---- Candidate poster EOAs from configured keys ----
const candidates = [
  { label: "BUYER_PRIVATE_KEY", wallet: process.env.BUYER_PRIVATE_KEY ? new ethers.Wallet(process.env.BUYER_PRIVATE_KEY, provider) : null },
  { label: "EOA_PRIVATE_KEY",   wallet: process.env.EOA_PRIVATE_KEY   ? new ethers.Wallet(process.env.EOA_PRIVATE_KEY, provider)   : null },
];

for (const c of candidates) {
  if (c.wallet) {
    const native = await withRetry(() => provider.getBalance(c.wallet.address));
    console.log(`${c.label} ${c.wallet.address}  native=${ethers.formatUnits(native, 18)}`);
  }
}

// Relayer balances
const relayerNative = await withRetry(() => provider.getBalance(relayerAddress));
const relayerUsdc = await withRetry(() => token.balanceOf(relayerAddress));
console.log(`relayer         ${relayerAddress}  native=${ethers.formatUnits(relayerNative, decimals)}  usdc=${ethers.formatUnits(relayerUsdc, decimals)}`);
if (relayerUsdc === 0n) {
  throw new Error("Relayer has zero USDC — fund it before running this E2E");
}
console.log("");

// ---- Identity selection ----
// Poster: a configured EOA with native gas if available, else the relayer.
let posterWallet = null;
for (const c of candidates) {
  if (c.wallet && (await withRetry(() => provider.getBalance(c.wallet.address))) > 0n) {
    posterWallet = c.wallet;
    break;
  }
}
const poster = posterWallet ? posterWallet : deployer;
const posterAddress = await poster.getAddress();
console.log("Poster:", posterAddress, posterWallet ? "(configured EOA)" : "(relayer — no funded EOA available)");

// Worker: fresh wallet, funded with native gas by the relayer.
const workerWallet = ethers.Wallet.createRandom().connect(provider);
const workerAddress = workerWallet.address;
console.log("Worker:", workerAddress, "(fresh wallet, funding gas...)");

const workerFundStep = await runStep(
  `  fund worker gas (+${ethers.formatUnits(BigInt(WORKER_GAS_AMOUNT), 18)} native-USDC)`,
  () => deployer.sendTransaction({ to: workerAddress, value: WORKER_GAS_AMOUNT }),
  () => provider.getBalance(workerAddress).then((b) => b >= BigInt(WORKER_GAS_AMOUNT))
);
console.log("  worker gas funding tx:", workerFundStep.hash ?? "(already funded)");
console.log("");

// ---- 1. fundJobFor (relayer) ----
const budget = "1000000"; // 1 USDC
const criteriaHash = keccak256(toUtf8Bytes("E2E criteria: agent delivers a parseable report"));
const maxRevisions = 1;

const nextBefore = (await withRetry(() => escrow.nextJobId())).toString();

console.log("[1] fundJobFor(payer=poster, budget=1 USDC, maxRevisions=1) by relayer");
const approveStep = await runStep(
  "    approve escrow",
  () => token.connect(deployer).approve(ESCROW_ADDRESS, budget),
  () => token.allowance(relayerAddress, ESCROW_ADDRESS).then((a) => a >= BigInt(budget))
);
console.log("    approve escrow:", approveStep.hash ?? "(already approved)");

const fundStep = await runStep(
  "    fundJobFor -> Funded",
  () => escrow.fundJobFor(posterAddress, USDC_ADDRESS, budget, criteriaHash, maxRevisions),
  async () => {
    const next = (await escrow.nextJobId()).toString();
    if (next <= nextBefore) return false;
    const j = await escrow.getJob(nextBefore);
    return j.status === 1n && j.poster.toLowerCase() === posterAddress.toLowerCase();
  }
);

let jobId;
let fundReceipt;
if (fundStep.fresh) {
  fundReceipt = fundStep.receipt;
  const fundLog = fundReceipt.logs
    .map((l) => {
      try { return escrow.interface.parseLog(l); } catch { return null; }
    })
    .find((p) => p && p.name === "JobFunded");
  jobId = fundLog ? BigInt(fundLog.args.jobId).toString() : nextBefore;
  console.log("    fund tx:", fundReceipt.hash, "jobId=", jobId);
} else {
  jobId = nextBefore;
  console.log("    (fund already applied) jobId=", jobId);
}

let job = await withRetry(() => escrow.getJob(jobId));
console.log("    state  :", statusName(job.status), "poster=", job.poster, "worker=", job.worker, "revisionCount=", job.revisionCount);

// ---- 2. assignWorker (poster) ----
console.log(`[2] assignWorker(jobId=${jobId}, worker) by poster`);
const assignStep = await runStep(
  "    assignWorker -> Assigned",
  () => escrow.connect(poster).assignWorker(jobId, workerAddress),
  async () => {
    const j = await escrow.getJob(jobId);
    return j.status === 2n && j.worker.toLowerCase() === workerAddress.toLowerCase();
  }
);
console.log("    assign tx:", assignStep.hash ?? "(already applied)");
job = await withRetry(() => escrow.getJob(jobId));
console.log("    state  :", statusName(job.status), "worker=", job.worker);

// ---- 3. submitWork (worker) ----
console.log(`[3] submitWork(jobId=${jobId}) by worker`);
const submit1Step = await runStep(
  "    submitWork -> Submitted",
  () => escrow.connect(workerWallet).submitWork(jobId),
  async () => (await escrow.getJob(jobId)).status === 3n
);
console.log("    submit tx:", submit1Step.hash ?? "(already applied)");
job = await withRetry(() => escrow.getJob(jobId));
console.log("    state  :", statusName(job.status));

// ---- 4. rejectSubmission (poster, feedback) ----
console.log(`[4] rejectSubmission(jobId=${jobId}, feedbackHash) by poster`);
const feedbackHash = keccak256(toUtf8Bytes("E2E feedback: report parsing failed, please revise"));
const rejectStep = await runStep(
  "    rejectSubmission -> Rejected",
  () => escrow.connect(poster).rejectSubmission(jobId, feedbackHash),
  async () => {
    const j = await escrow.getJob(jobId);
    return j.status === 4n && j.revisionCount === 1n;
  }
);
console.log("    reject tx:", rejectStep.hash ?? "(already applied)");
job = await withRetry(() => escrow.getJob(jobId));
console.log("    state  :", statusName(job.status), "revisionCount=", job.revisionCount);

// ---- 5. submitWork (worker, resubmission) ----
console.log(`[5] submitWork(jobId=${jobId}) by worker (resubmission)`);
const submit2Step = await runStep(
  "    submitWork -> Submitted (rev 1)",
  () => escrow.connect(workerWallet).submitWork(jobId),
  async () => {
    const j = await escrow.getJob(jobId);
    return j.status === 3n && j.revisionCount >= 1n;
  }
);
console.log("    resubmit tx:", submit2Step.hash ?? "(already applied)");
job = await withRetry(() => escrow.getJob(jobId));
console.log("    state  :", statusName(job.status));

// ---- 6. releaseToWorkerFor (relayer) ----
console.log(`[6] releaseToWorkerFor(jobId=${jobId}) by relayer`);
const workerBalanceBefore = await withRetry(() => token.balanceOf(workerAddress));
const releaseStep = await runStep(
  "    releaseToWorkerFor -> Released",
  () => escrow.releaseToWorkerFor(jobId),
  async () => (await escrow.getJob(jobId)).status === 5n
);
console.log("    release tx:", releaseStep.hash ?? "(already applied)");
job = await withRetry(() => escrow.getJob(jobId));
const workerBalanceAfter = await withRetry(() => token.balanceOf(workerAddress));
console.log("    state  :", statusName(job.status));
console.log("    worker usdc:", ethers.formatUnits(workerBalanceBefore, decimals), "->", ethers.formatUnits(workerBalanceAfter, decimals));

// ---- Result ----
const released = job.status === 5n; // JobStatus.Released
const paid = workerBalanceAfter - workerBalanceBefore === BigInt(budget);
console.log("");
console.log(released && paid
  ? "E2E PASS — full lifecycle executed, worker received the budget."
  : `E2E FAIL — status=${job.status} workerDelta=${workerBalanceAfter - workerBalanceBefore}`);
console.log("Job id:", jobId);
console.log("Tx hashes:", {
  fund: fundStep.hash ?? "(pre-existing)",
  assign: assignStep.hash ?? "(pre-existing)",
  submit1: submit1Step.hash ?? "(pre-existing)",
  reject: rejectStep.hash ?? "(pre-existing)",
  submit2: submit2Step.hash ?? "(pre-existing)",
  release: releaseStep.hash ?? "(pre-existing)",
});

function runStep(label, doSend, alreadyApplied) {
  return (async () => {
    console.log(label);
    try {
      const tx = await doSend();
      const receipt = await withRetry(() => tx.wait(1));
      return { hash: receipt.hash, receipt, fresh: true };
    } catch (e) {
      const applied = await withRetry(alreadyApplied);
      if (applied) {
        console.log("    (send errored, but on-chain state already reflects this step — continuing)");
        return { hash: null, receipt: null, fresh: false };
      }
      throw e;
    }
  })();
}

function statusName(s) {
  const names = ["None", "Funded", "Assigned", "Submitted", "Rejected", "Released", "Disputed", "Resolved"];
  return `${names[Number(s)] ?? "?"}(${s})`;
}