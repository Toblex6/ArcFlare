// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArcFlareJobEscrow
/// @notice One-way release escrow for jobs (agent-poster <> human/agent worker).
///
/// DESIGN INTENT (do not weaken this without discussing with the team first):
/// - Funds move ONLY forward: poster -> escrow -> worker (full or split with arbiter).
/// - There is NO function, under any caller, that returns escrowed funds to the poster
///   once a job is funded and criteria are locked. This is deliberate. It is the entire
///   point of this contract: a worker who sees a funded, criteria-locked job can trust
///   that doing the work will result in payment, full stop.
/// - Acceptance criteria are committed on-chain as a hash BEFORE applicants can be
///   assigned, so neither side can move the goalposts after work starts.
/// - Disputes are resolved by a designated arbiter who can only ever split the ALREADY
///   ESCROWED funds between poster-refund-address... NO — see above, there is no refund path.
///   An arbiter split only ever divides funds between the worker and a burn/treasury
///   sink, never back to the poster. If you need poster-refundable jobs, that is a
///   DIFFERENT product (use the existing mutual-confirm ArcFlareEscrow.sol instead).
///
/// If a job should be cancelable with funds returned to the poster, do not use this
/// contract — use the existing ArcFlareEscrow.sol, which is mutual-confirm and does
/// support a refund path. This contract is specifically for the "worker must be able
/// to trust the job" use case.
contract ArcFlareJobEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobStatus {
        None,
        Funded,      // budget locked, criteria hashed, open for applicants
        Assigned,    // worker assigned, work in progress
        Submitted,   // worker submitted, awaiting review
        Rejected,    // poster rejected with feedback, worker may revise if under cap
        Released,    // fully paid to worker
        Disputed,    // escalated to arbiter
        Resolved     // arbiter split funds between worker and treasury sink
    }

    struct Job {
        address poster;
        address worker;         // zero until assigned
        address token;          // USDC on Arc Testnet
        uint256 budget;         // total escrowed amount
        bytes32 criteriaHash;   // keccak256 of the acceptance criteria document
        JobStatus status;
        uint64 fundedAt;
        uint64 assignedAt;
        uint8 maxRevisions;     // cap on reject->revise cycles, set at funding time
        uint8 revisionCount;    // number of times this job has been rejected so far
    }

    /// @notice treasury sink for the non-worker portion of an arbiter split.
    /// This is NOT the poster. It is never settable to the poster's address.
    address public immutable treasurySink;

    /// @notice single designated arbiter contract/address for now.
    /// Can be upgraded to a role-based system later without touching the
    /// no-refund-to-poster guarantee above.
    address public arbiter;

    /// @notice trusted relayer address — this is your backend / Circle-facilitator-
    /// integrated service that submits transactions on behalf of agents and
    /// merchants who pay via x402 / Gateway Wallet and don't hold native gas
    /// themselves. The relayer can call the *For variants below, but it can
    /// NEVER change who funds flow to — it only submits the transaction, the
    /// poster/worker addresses are still explicit parameters checked the same
    /// way as the direct-call functions. This does not weaken the one-way
    /// payment guarantee; it only removes the requirement that the poster or
    /// worker personally hold and spend native gas.
    address public relayer;

    address public owner;

    uint256 public nextJobId;
    mapping(uint256 => Job) public jobs;

    event JobFunded(uint256 indexed jobId, address indexed poster, address token, uint256 budget, bytes32 criteriaHash, uint8 maxRevisions);
    event JobAssigned(uint256 indexed jobId, address indexed worker);
    event JobSubmitted(uint256 indexed jobId);
    event JobRejected(uint256 indexed jobId, uint8 revisionCount, bytes32 feedbackHash);
    event JobReleased(uint256 indexed jobId, address indexed worker, uint256 amount);
    event JobDisputed(uint256 indexed jobId);
    event JobResolved(uint256 indexed jobId, uint256 workerAmount, uint256 treasuryAmount);
    event ArbiterUpdated(address indexed newArbiter);
    event RelayerUpdated(address indexed newRelayer);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "not arbiter");
        _;
    }

    modifier onlyRelayer() {
        require(msg.sender == relayer, "not relayer");
        _;
    }

    constructor(address _owner, address _arbiter, address _treasurySink, address _relayer) {
        require(_treasurySink != address(0), "bad treasury");
        owner = _owner;
        arbiter = _arbiter;
        treasurySink = _treasurySink;
        relayer = _relayer;
    }

    function setArbiter(address newArbiter) external onlyOwner {
        arbiter = newArbiter;
        emit ArbiterUpdated(newArbiter);
    }

    function setRelayer(address newRelayer) external onlyOwner {
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }

    /// @notice Poster funds a job and commits acceptance criteria on-chain.
    /// Funds move into this contract now, before any applicant is assigned.
    /// There is intentionally no cancelJob() / refund() function in this contract.
    function fundJob(address token, uint256 budget, bytes32 criteriaHash, uint8 maxRevisions) external nonReentrant returns (uint256 jobId) {
        require(budget > 0, "zero budget");
        require(criteriaHash != bytes32(0), "criteria required");

        jobId = nextJobId++;
        jobs[jobId] = Job({
            poster: msg.sender,
            worker: address(0),
            token: token,
            budget: budget,
            criteriaHash: criteriaHash,
            status: JobStatus.Funded,
            fundedAt: uint64(block.timestamp),
            assignedAt: 0,
            maxRevisions: maxRevisions,
            revisionCount: 0
        });

        IERC20(token).safeTransferFrom(msg.sender, address(this), budget);
        emit JobFunded(jobId, msg.sender, token, budget, criteriaHash, maxRevisions);
    }

    /// @notice Poster assigns a worker after scoring applicants off-chain.
    /// Caller MUST be verified as the actual poster by the backend before
    /// calling this (see verifyCallerControlsAddress.ts) — this contract only
    /// checks msg.sender == job.poster, it has no knowledge of your auth layer.
    function assignWorker(uint256 jobId, address worker) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "not fundable state");
        require(msg.sender == job.poster, "not poster");
        require(worker != address(0), "bad worker");

        job.worker = worker;
        job.status = JobStatus.Assigned;
        job.assignedAt = uint64(block.timestamp);
        emit JobAssigned(jobId, worker);
    }

    /// @notice Worker marks work submitted for review. Off-chain review against
    /// the hashed criteria happens in your backend / AI review layer.
    /// Callable from both Assigned (first submission) and Rejected (resubmission
    /// after a revise cycle) states.
    function submitWork(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(
            job.status == JobStatus.Assigned || job.status == JobStatus.Rejected,
            "not in a submittable state"
        );
        require(msg.sender == job.worker, "not worker");
        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId);
    }

    /// @notice Poster (or automated AI reviewer acting as poster) rejects a
    /// submission with feedback, sending it back to the worker for revision —
    /// IF the job hasn't hit its revision cap yet. `feedbackHash` should be
    /// keccak256 of the actual feedback text, kept off-chain (same pattern as
    /// criteriaHash) — this makes the rejection reason provable later without
    /// paying gas to store free-text on-chain.
    ///
    /// If maxRevisions is already reached, this reverts — at that point the
    /// only paths forward are releaseToWorker() (poster relents) or
    /// raiseDispute() (escalate to arbiter). This prevents a poster from
    /// stalling a worker with infinite rejections.
    function rejectSubmission(uint256 jobId, bytes32 feedbackHash) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Submitted, "not submitted state");
        require(msg.sender == job.poster, "not poster");
        require(job.revisionCount < job.maxRevisions, "revision cap reached, escalate or release instead");
        require(feedbackHash != bytes32(0), "feedback required");

        job.revisionCount += 1;
        job.status = JobStatus.Rejected;
        emit JobRejected(jobId, job.revisionCount, feedbackHash);
    }

    /// @notice Poster (or automated reviewer acting as poster, per your backend's
    /// auth model) approves and releases FULL payment to the worker.
    /// This is the only "happy path" fund movement, and it only ever goes to
    /// the worker — never back to the poster.
    function releaseToWorker(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Submitted, "not submitted state");
        require(msg.sender == job.poster, "not poster");

        job.status = JobStatus.Released;
        uint256 amount = job.budget;
        IERC20(job.token).safeTransfer(job.worker, amount);
        emit JobReleased(jobId, job.worker, amount);
    }

    /// @notice Either party escalates to the arbiter. Allowed from Submitted
    /// (worker disputes a rejection they think is unfair) or Rejected
    /// (either side gives up on further revisions, or the cap was hit).
    function raiseDispute(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(
            job.status == JobStatus.Submitted || job.status == JobStatus.Rejected,
            "not in a disputable state"
        );
        require(msg.sender == job.poster || msg.sender == job.worker, "not a party");
        job.status = JobStatus.Disputed;
        emit JobDisputed(jobId);
    }

    /// @notice Arbiter splits the escrowed budget between the worker and the
    /// treasury sink. NOTE: the poster is never a valid recipient here, by
    /// design — see contract-level comment above. workerBps + treasuryBps
    /// must equal 10000 (basis points).
    function resolveDispute(uint256 jobId, uint256 workerBps, uint256 treasuryBps) external onlyArbiter nonReentrant {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Disputed, "not disputed state");
        require(workerBps + treasuryBps == 10_000, "bps must sum to 10000");

        job.status = JobStatus.Resolved;
        uint256 workerAmount = (job.budget * workerBps) / 10_000;
        uint256 treasuryAmount = job.budget - workerAmount;

        if (workerAmount > 0) {
            IERC20(job.token).safeTransfer(job.worker, workerAmount);
        }
        if (treasuryAmount > 0) {
            IERC20(job.token).safeTransfer(treasurySink, treasuryAmount);
        }

        emit JobResolved(jobId, workerAmount, treasuryAmount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    // ---- Relayer-submitted variants ----
    // These exist so a Circle-facilitator-integrated backend can submit the
    // transaction (and pay the gas) on behalf of an agent/poster/worker who
    // settled their side via x402 / Gateway Wallet rather than holding native
    // gas themselves. The explicit `payer`/`worker` params mean the relayer
    // can never redirect funds to itself or anyone other than who the
    // off-chain flow already authorized — it is a gas sponsor, not a
    // fund-routing authority.

    /// @notice Same as fundJob, but callable by the relayer on behalf of `payer`.
    /// The relayer must already hold the budget (e.g. because it just settled
    /// an x402 payment from the agent and is forwarding it into escrow), OR
    /// `payer` must have approved this contract directly — either way, the
    /// ERC-20 transfer rules apply exactly as in fundJob, nothing is bypassed.
    function fundJobFor(
        address payer,
        address token,
        uint256 budget,
        bytes32 criteriaHash,
        uint8 maxRevisions
    ) external onlyRelayer nonReentrant returns (uint256 jobId) {
        require(budget > 0, "zero budget");
        require(criteriaHash != bytes32(0), "criteria required");
        require(payer != address(0), "bad payer");

        jobId = nextJobId++;
        jobs[jobId] = Job({
            poster: payer,
            worker: address(0),
            token: token,
            budget: budget,
            criteriaHash: criteriaHash,
            status: JobStatus.Funded,
            fundedAt: uint64(block.timestamp),
            assignedAt: 0,
            maxRevisions: maxRevisions,
            revisionCount: 0
        });

        // Pulls from whichever address holds the funds at this point in your
        // settlement flow — typically the relayer itself, having just
        // received the x402-settled amount via the Gateway Wallet path.
        IERC20(token).safeTransferFrom(msg.sender, address(this), budget);
        emit JobFunded(jobId, payer, token, budget, criteriaHash, maxRevisions);
    }

    /// @notice Same as releaseToWorker, but callable by the relayer once your
    /// backend has verified (via verifyCallerControlsAddress + the poster's
    /// off-chain approval / AI review pass) that release is authorized. The
    /// relayer submits and pays gas; it does not gain any discretion over
    /// where funds go beyond what's already recorded on the job.
    function releaseToWorkerFor(uint256 jobId) external onlyRelayer nonReentrant {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Submitted, "not submitted state");

        job.status = JobStatus.Released;
        uint256 amount = job.budget;
        IERC20(job.token).safeTransfer(job.worker, amount);
        emit JobReleased(jobId, job.worker, amount);
    }
}
