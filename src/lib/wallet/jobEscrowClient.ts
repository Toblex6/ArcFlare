/**
 * jobEscrowClient.ts
 *
 * Small wiring file: gives you a signer for your relayer wallet (the backend-
 * held address set as `relayer` on ArcFlareJobEscrow) and a typed contract
 * instance pointed at your deployed ArcFlareJobEscrow on Arc Testnet.
 *
 * SECURITY NOTE: the relayer private key is a real spending key for a wallet
 * that can submit fundJobFor/releaseToWorkerFor. Store it the same way you
 * store other sensitive keys in this codebase (per-merchant x402 EOA keys
 * are AES-256-GCM encrypted at rest per your existing pattern) — do NOT
 * commit it as a plaintext env var if you can avoid it. At minimum, this
 * should live in the same secrets path as your other wallet keys, not a
 * plain .env checked into git.
 */

import { Contract, JsonRpcProvider, Wallet, type Signer } from "ethers"; // swap for viem equivalents if that's your standard here

// ---- Config — fill these in for your actual deployment ----

const ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.network";
export const JOB_ESCROW_CONTRACT_ADDRESS = process.env.JOB_ESCROW_CONTRACT_ADDRESS ?? ""; // set after deploying ArcFlareJobEscrow.sol
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY ?? ""; // the relayer wallet's key — see security note above

if (!JOB_ESCROW_CONTRACT_ADDRESS) {
  console.warn("[jobEscrowClient] JOB_ESCROW_CONTRACT_ADDRESS is not set — deploy ArcFlareJobEscrow.sol first");
}

export const JOB_ESCROW_ABI = [
  "function fundJobFor(address payer, address token, uint256 budget, bytes32 criteriaHash, uint8 maxRevisions) external returns (uint256 jobId)",
  "function releaseToWorkerFor(uint256 jobId) external",
  "function assignWorker(uint256 jobId, address worker) external",
  "function submitWork(uint256 jobId) external",
  "function rejectSubmission(uint256 jobId, bytes32 feedbackHash) external",
  "function raiseDispute(uint256 jobId) external",
  "function resolveDispute(uint256 jobId, uint256 workerBps, uint256 treasuryBps) external",
  "function getJob(uint256 jobId) external view returns (tuple(address poster,address worker,address token,uint256 budget,bytes32 criteriaHash,uint8 status,uint64 fundedAt,uint64 assignedAt,uint8 maxRevisions,uint8 revisionCount))",
  "event JobFunded(uint256 indexed jobId, address indexed poster, address token, uint256 budget, bytes32 criteriaHash, uint8 maxRevisions)",
  "event JobRejected(uint256 indexed jobId, uint8 revisionCount, bytes32 feedbackHash)",
  "event JobReleased(uint256 indexed jobId, address indexed worker, uint256 amount)",
];

let cachedProvider: JsonRpcProvider | null = null;
let cachedRelayerSigner: Wallet | null = null;

function getProvider(): JsonRpcProvider {
  if (!cachedProvider) {
    cachedProvider = new JsonRpcProvider(ARC_TESTNET_RPC_URL);
  }
  return cachedProvider;
}

/**
 * Returns a signer for the relayer wallet — the address you'll set via
 * `setRelayer()` on the deployed ArcFlareJobEscrow contract (owner-only call,
 * do that once at deploy time).
 */
export function getRelayerSigner(): Signer {
  if (!cachedRelayerSigner) {
    if (!RELAYER_PRIVATE_KEY) {
      throw new Error("RELAYER_PRIVATE_KEY is not configured");
    }
    cachedRelayerSigner = new Wallet(RELAYER_PRIVATE_KEY, getProvider());
  }
  return cachedRelayerSigner;
}

/**
 * Returns a contract instance for ArcFlareJobEscrow, connected with the
 * given signer (pass getRelayerSigner() for relayer-submitted calls).
 */
export function getJobEscrowContract(signer: Signer): Contract {
  if (!JOB_ESCROW_CONTRACT_ADDRESS) {
    throw new Error("JOB_ESCROW_CONTRACT_ADDRESS is not configured — deploy the contract first");
  }
  return new Contract(JOB_ESCROW_CONTRACT_ADDRESS, JOB_ESCROW_ABI, signer);
}

/**
 * ---- Deploy-time checklist (do this once, not per-request) ----
 *
 * 1. Deploy ArcFlareJobEscrow.sol to Arc Testnet with constructor args:
 *      (owner, arbiter, treasurySink, relayer)
 *    — relayer should be the address whose private key you put in
 *    RELAYER_PRIVATE_KEY above.
 *
 * 2. Set JOB_ESCROW_CONTRACT_ADDRESS to the deployed address.
 *
 * 3. Fund the relayer wallet with enough Arc Testnet native gas token to
 *    submit fundJobFor/releaseToWorkerFor transactions — the relayer pays
 *    gas on behalf of agents/posters, so IT needs gas even though they don't.
 *
 * 4. If the relayer also needs to hold USDC temporarily between x402
 *    settlement and forwarding into escrow (see fundJobViaX402 in
 *    x402JobPayment.ts), confirm your Gateway Wallet settlement path
 *    actually lands funds at this relayer address — if it settles
 *    somewhere else, fundJobFor's safeTransferFrom(msg.sender, ...) will
 *    fail since msg.sender (the relayer) won't hold the balance.
 */
