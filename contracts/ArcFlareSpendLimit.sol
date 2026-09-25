// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ArcFlareSpendLimit
/// @notice On-chain hard spending caps per agent wallet. This is the trust
/// primitive behind "no surprise drains, ever" — it only means something if
/// the cap is enforced somewhere a backend bug or compromised API key can't
/// bypass it. That's why this lives on-chain rather than purely in a backend
/// check.
///
/// DESIGN INTENT:
/// - Caps are set by the agent's OWNER (the merchant/consumer who provisioned
///   the agent's wallet), never by the agent itself. An agent cannot raise
///   its own ceiling.
/// - This contract only tracks and enforces a rolling-window spend total per
///   agent. It does NOT move funds itself — it's a check that other contracts
///   (or your relayer, before submitting a payment tx) call BEFORE letting a
///   spend go through.
/// - Per-task and per-counterparty granularity is intentionally NOT handled
///   here — that's finer-grained bookkeeping better suited to your backend
///   (see spendLimitEnforcer.ts), since it doesn't need the same trustless
///   guarantee and benefits from being easy to iterate on. This contract is
///   only the hard ceiling that must never be bypassable.
contract ArcFlareSpendLimit {
    /// @notice contract admin — can rotate the recorder and accept ownership.
    /// Deploy-time set; afterwards moves only via proposeOwner/acceptOwner.
    address public owner;

    /// @notice pending owner for the 2-step ownership transfer
    /// (proposeOwner/acceptOwner). Mirrors the escrow/payroll pattern so a
    /// single mistyped tx can never hand the recorder ACL to an attacker.
    address public pendingOwner;

    /// @notice allowlisted recorder — the backend relayer that calls
    /// checkAndRecordSpend before agent payments. H3: checkAndRecordSpend
    /// was permissionless, so ANY address could inflate an agent's
    /// spentInWindow and brick its cap (cap-bricking DoS with zero funds
    /// at stake). Only the recorder (or the owner as a break-glass
    /// fallback) may record spends now.
    address public recorder;
    struct Limit {
        uint256 capPerWindow;   // max an agent can spend within one window
        uint256 windowSeconds;  // e.g. 86400 for a rolling daily cap
        uint256 windowStart;    // start timestamp of the current window
        uint256 spentInWindow;  // running total spent within the current window
        address owner;          // who is allowed to raise/lower this cap
        bool active;
    }

    /// agent wallet address => its spending limit config
    mapping(address => Limit) public limits;

    event LimitSet(address indexed agent, address indexed owner, uint256 capPerWindow, uint256 windowSeconds);
    event LimitDeactivated(address indexed agent);
    event SpendRecorded(address indexed agent, uint256 amount, uint256 spentInWindow, uint256 windowStart);
    event WindowReset(address indexed agent, uint256 newWindowStart);
    event OwnershipProposed(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipAccepted(address indexed newOwner);
    event RecorderUpdated(address indexed newRecorder);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyLimitOwner(address agent) {
        require(limits[agent].owner == msg.sender, "not limit owner");
        _;
    }

    constructor(address _owner, address _recorder) {
        require(_owner != address(0), "bad owner");
        require(_recorder != address(0), "bad recorder");
        owner = _owner;
        recorder = _recorder;
    }

    /// @notice Step 1 of the 2-step ownership transfer. Only the current
    /// owner can propose; completes only when the proposed address accepts.
    function proposeOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "bad new owner");
        require(newOwner != owner, "already owner");
        pendingOwner = newOwner;
        emit OwnershipProposed(owner, newOwner);
    }

    /// @notice Step 2: the proposed address accepts control.
    function acceptOwner() external {
        require(msg.sender == pendingOwner, "not pending owner");
        require(pendingOwner != address(0), "no pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipAccepted(owner);
    }

    /// @notice Rotate the allowlisted spend recorder (e.g. relayer key
    /// rotation). Owner-only, zero-address rejected.
    function setRecorder(address newRecorder) external onlyOwner {
        require(newRecorder != address(0), "bad recorder");
        recorder = newRecorder;
        emit RecorderUpdated(newRecorder);
    }

    /// @notice Owner (merchant/consumer that provisioned the agent) sets or
    /// updates the agent's spending cap. Only callable by whoever is
    /// currently recorded as owner for this agent — or, for a brand new
    /// agent with no limit yet, callable once by anyone to bootstrap it
    /// (the FIRST caller becomes the permanent owner unless they explicitly
    /// transfer it — see transferLimitOwnership).
    function setLimit(address agent, uint256 capPerWindow, uint256 windowSeconds) external {
        Limit storage limit = limits[agent];
        require(windowSeconds > 0, "window must be > 0");

        if (limit.owner == address(0)) {
            // bootstrap — first caller becomes owner
            limit.owner = msg.sender;
            limit.windowStart = block.timestamp;
        } else {
            require(limit.owner == msg.sender, "not limit owner");
        }

        limit.capPerWindow = capPerWindow;
        limit.windowSeconds = windowSeconds;
        limit.active = true;

        emit LimitSet(agent, limit.owner, capPerWindow, windowSeconds);
    }

    function transferLimitOwnership(address agent, address newOwner) external onlyLimitOwner(agent) {
        require(newOwner != address(0), "bad new owner");
        limits[agent].owner = newOwner;
    }

    function deactivateLimit(address agent) external onlyLimitOwner(agent) {
        limits[agent].active = false;
        emit LimitDeactivated(agent);
    }

    /// @notice Call this BEFORE executing a payment on behalf of `agent`.
    /// Reverts if the spend would exceed the cap for the current window.
    /// If the current window has elapsed, it resets automatically as part
    /// of this call — callers don't need to reset separately.
    ///
    /// This should be called by your relayer (see jobEscrowClient.ts /
    /// x402JobPayment.ts) immediately before submitting any agent-initiated
    /// payment, and by any other contract that executes agent spends.
    ///
    /// H3 ACL: only the allowlisted recorder (backend relayer) or the
    /// contract owner may record. Permissionless callers could otherwise
    /// inflate spentInWindow and brick an agent's cap without spending a
    /// cent of their own.
    function checkAndRecordSpend(address agent, uint256 amount) external {
        require(msg.sender == recorder || msg.sender == owner, "not recorder");
        Limit storage limit = limits[agent];

        // No limit configured = no cap enforced. This is a deliberate
        // default (agents with no configured limit aren't blocked), NOT an
        // implicit unlimited-trust claim — if you want "no limit configured"
        // to mean "blocked until a limit is set," flip this check at the
        // call site, not here, since that's a product decision.
        if (!limit.active || limit.owner == address(0)) {
            return;
        }

        if (block.timestamp >= limit.windowStart + limit.windowSeconds) {
            // window elapsed — reset
            limit.windowStart = block.timestamp;
            limit.spentInWindow = 0;
            emit WindowReset(agent, limit.windowStart);
        }

        require(limit.spentInWindow + amount <= limit.capPerWindow, "spend exceeds agent limit");

        limit.spentInWindow += amount;
        emit SpendRecorded(agent, amount, limit.spentInWindow, limit.windowStart);
    }

    function getLimit(address agent) external view returns (Limit memory) {
        return limits[agent];
    }

    /// @notice View-only check, doesn't record — useful for a backend to
    /// pre-flight whether a spend WOULD be allowed before even attempting
    /// the transaction (e.g. to give the agent a clear error before it signs
    /// anything, rather than a failed on-chain tx).
    function wouldExceedLimit(address agent, uint256 amount) external view returns (bool) {
        Limit memory limit = limits[agent];
        if (!limit.active || limit.owner == address(0)) {
            return false;
        }

        uint256 effectiveSpent = limit.spentInWindow;
        if (block.timestamp >= limit.windowStart + limit.windowSeconds) {
            effectiveSpent = 0; // window would have reset by then
        }

        return effectiveSpent + amount > limit.capPerWindow;
    }
}
