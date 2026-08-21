// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArcFlareStream
/// @notice Criterion-based nanopayment stream for jobs (poster -> worker).
///
/// DESIGN INTENT (mirrors ArcFlareJobEscrow — do not weaken):
/// - Funds move ONLY forward: poster -> stream -> worker.
/// - There is NO function, under any caller, that returns streamed funds to
///   the poster once a stream is opened. No refund path, no cancel path.
///   This is deliberate: a worker who sees a funded, criteria-locked job can
///   trust that every confirmed criterion will pay out.
/// - The job's total budget is split deterministically across the criterion
///   tranches at open time (floor division; any remainder is added to the
///   LAST tranche). Each tranche is released at most once — the contract
///   enforces this, so an over-release is impossible by construction:
///   sum(trancheAmounts) == totalBudget, so totalReleased <= totalBudget
///   always, and closeStream() can only ever release the exact remainder.
/// - Only the poster may release tranches or close the stream. The app layer
///   additionally lets a job's authorized reviewer (evaluator) trigger a
///   release, but the on-chain signer is always the poster's wallet
///   (server-authoritative) — this contract never accepts an arbitrary
///   releaser address.
/// - On partial completion, the unreleased remainder is NOT forfeited: when
///   the poster closes the stream, whatever remains is paid to the worker in
///   one final transfer. There is no other destination for stream funds.
/// - The worker is a plain address — the contract transfers to it directly,
///   so the worker never needs gas or a Circle wallet.
///
/// TESTNET TOKEN NOTE: Arc Testnet's USDC applies a per-transfer fee to the
/// RECIPIENT (measured ~0.0014-0.0022 USDC for contract->EOA transfers).
/// This contract's bookkeeping (totalBudget/totalReleased/trancheAmounts)
/// tracks exact amounts; the worker's actual wallet gain is
/// amount - fee. That is a token-behavior artifact of the testnet USDC
/// wrapper, not a bug in this contract — verify deltas from balances, never
/// assume amount == balance delta.
contract ArcFlareStream is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice upper bound on criteria count per stream (keeps openStream
    /// gas bounded; the app layer caps at 50 too).
    uint256 public constant MAX_TRANCHES = 50;

    struct Stream {
        address poster;       // the address that funded the stream; sole releaser/closer
        address worker;       // sole recipient of every tranche
        address token;        // USDC (or any 18/6-dec ERC-20) — transferred in its smallest units
        uint256 totalBudget;  // locked at open
        uint256 trancheCount; // number of criteria tranches
        uint256 tranchesReleased;
        uint256 totalReleased; // exact bookkeeping: sum of released amounts
        bool closed;
        uint64 openedAt;
    }

    uint256 public nextStreamId;
    mapping(uint256 => Stream) public streams;
    /// @notice releasedTranches[streamId][requirementIndex] — set once per
    /// index; a second release reverts ("already released").
    mapping(uint256 => mapping(uint256 => bool)) public releasedTranches;
    /// @notice trancheAmounts[streamId][requirementIndex] — fixed at open;
    /// the last index carries the modulo remainder.
    mapping(uint256 => mapping(uint256 => uint256)) public trancheAmounts;

    event StreamOpened(
        uint256 indexed streamId,
        address indexed poster,
        address indexed worker,
        address token,
        uint256 totalBudget,
        uint256 trancheCount
    );
    event TrancheReleased(uint256 indexed streamId, uint256 indexed requirementIndex, uint256 amount);
    event StreamClosed(uint256 indexed streamId, uint256 totalReleased, uint256 remainderToWorker);

    /// @notice Poster opens a stream: locks `totalBudget` of `token` (pulled
    /// from msg.sender via transferFrom — the poster must approve first) and
    /// splits it evenly across `trancheCount` criterion tranches.
    /// @return streamId the on-chain stream id (also emitted in StreamOpened).
    function openStream(
        address worker,
        address token,
        uint256 totalBudget,
        uint256 trancheCount
    ) external nonReentrant returns (uint256 streamId) {
        require(worker != address(0), "bad worker");
        require(token != address(0), "bad token");
        require(totalBudget > 0, "zero budget");
        require(trancheCount > 0 && trancheCount <= MAX_TRANCHES, "bad tranche count");

        streamId = nextStreamId++;
        streams[streamId] = Stream({
            poster: msg.sender,
            worker: worker,
            token: token,
            totalBudget: totalBudget,
            trancheCount: trancheCount,
            tranchesReleased: 0,
            totalReleased: 0,
            closed: false,
            openedAt: uint64(block.timestamp)
        });

        uint256 base = totalBudget / trancheCount;
        uint256 remainder = totalBudget % trancheCount;
        for (uint256 i = 0; i < trancheCount; i++) {
            trancheAmounts[streamId][i] = base + (i == trancheCount - 1 ? remainder : 0);
        }

        IERC20(token).safeTransferFrom(msg.sender, address(this), totalBudget);
        emit StreamOpened(streamId, msg.sender, worker, token, totalBudget, trancheCount);
    }

    /// @notice Poster releases the tranche for one confirmed criterion.
    /// Reverts if the stream is closed, the index is out of range, or the
    /// tranche was already released — the on-chain double-release guard.
    function releaseTranche(uint256 streamId, uint256 requirementIndex) external nonReentrant {
        Stream storage s = streams[streamId];
        require(msg.sender == s.poster, "not poster");
        require(!s.closed, "stream closed");
        require(requirementIndex < s.trancheCount, "bad index");
        require(!releasedTranches[streamId][requirementIndex], "already released");

        releasedTranches[streamId][requirementIndex] = true;
        s.tranchesReleased += 1;
        uint256 amount = trancheAmounts[streamId][requirementIndex];
        s.totalReleased += amount;

        IERC20(s.token).safeTransfer(s.worker, amount);
        emit TrancheReleased(streamId, requirementIndex, amount);
    }

    /// @notice Poster finalizes the stream. Any remainder (budget minus
    /// released tranches — including when criteria were never confirmed) is
    /// paid to the worker in one final transfer. No funds ever return to
    /// the poster. A closed stream can no longer release tranches.
    function closeStream(uint256 streamId) external nonReentrant {
        Stream storage s = streams[streamId];
        require(msg.sender == s.poster, "not poster");
        require(!s.closed, "already closed");

        s.closed = true;
        uint256 remainder = s.totalBudget - s.totalReleased;
        if (remainder > 0) {
            s.totalReleased = s.totalBudget;
            IERC20(s.token).safeTransfer(s.worker, remainder);
        }
        emit StreamClosed(streamId, s.totalReleased, remainder);
    }

    /// @notice Full on-chain stream state (poster, worker, token, budget,
    /// tranche bookkeeping). Anyone may read.
    function getStream(uint256 streamId) external view returns (Stream memory) {
        return streams[streamId];
    }
}