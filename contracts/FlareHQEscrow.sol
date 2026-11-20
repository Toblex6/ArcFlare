// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title FlareHQEscrow
/// @notice Two-party USDC escrow with an arbiter, expiry refunds and a 25 bps
///         release fee paid to the FlareHQ treasury.
///
/// Roles:
///   - owner    — protocol admin (the Safe). Two-step transfer via Ownable2Step.
///   - arbiter  — resolves disputes only. Cannot create, release or refund.
///   - treasury — receives the 25 bps release fee.
///
/// Safety properties:
///   - Release/refund is single-shot (`settled` set before any transfer).
///   - Reentrancy-guarded; fee-on-transfer and false-returning tokens are
///     rejected by exact balance-delta checks (SafeERC20 + before/after).
///   - Release requires both parties before expiry, or an arbiter resolution
///     of an open dispute. Refund requires the depositor after expiry and is
///     blocked while a dispute is open.
///   - The fee is taken only on release; an expired refund returns the full
///     amount to the depositor.
contract FlareHQEscrow is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Release fee in basis points (25 = 0.25%).
    uint256 public constant FEE_BPS = 25;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_DEADLINE = 3650 days;

    IERC20 public immutable token;
    address public arbiter;
    address public treasury;

    struct Escrow {
        address depositor;
        address beneficiary;
        uint256 amount;
        uint256 deadline;
        string ref;
        bool depositorConfirmed;
        bool beneficiaryConfirmed;
    }

    mapping(bytes32 => Escrow) private records;
    mapping(bytes32 => bool) public disputed;
    mapping(bytes32 => bool) public settled;

    event EscrowCreated(bytes32 indexed escrowId, address indexed depositor, address indexed beneficiary, uint256 amount, uint256 deadline, string ref);
    event EscrowDisputed(bytes32 indexed escrowId, address indexed raisedBy, string reason);
    event EscrowReleased(bytes32 indexed escrowId, address indexed beneficiary, uint256 amount);
    event EscrowRefunded(bytes32 indexed escrowId, address indexed depositor, uint256 amount);
    event EscrowFeePaid(bytes32 indexed escrowId, address indexed treasury, uint256 amount);
    event ArbiterChanged(address indexed previousArbiter, address indexed nextArbiter);
    event TreasuryChanged(address indexed previousTreasury, address indexed nextTreasury);
    event AdminTransferStarted(address indexed currentAdmin, address indexed nextAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed nextAdmin);

    constructor(address token_, address owner_, address arbiter_, address treasury_) Ownable(owner_) {
        require(token_ != address(0) && token_.code.length > 0, "invalid token");
        require(owner_ != address(0), "invalid owner");
        require(arbiter_ != address(0) && arbiter_ != address(this), "invalid arbiter");
        require(treasury_ != address(0) && treasury_ != address(this), "invalid treasury");
        token = IERC20(token_);
        arbiter = arbiter_;
        treasury = treasury_;
    }

    // ── Roles ────────────────────────────────────────────────────────────────

    /// @notice Back-compat alias for the owner (older backend ABI reads `admin`).
    function admin() external view returns (address) { return owner(); }

    /// @notice Back-compat alias for the pending owner.
    function pendingAdmin() external view returns (address) { return pendingOwner(); }

    /// @notice Back-compat: starts the same two-step ownership transfer.
    function transferAdmin(address next) external onlyOwner {
        require(next != address(0), "invalid admin transfer");
        transferOwnership(next);
        emit AdminTransferStarted(owner(), next);
    }

    /// @notice Back-compat: accepts the pending ownership transfer.
    function acceptAdmin() external {
        address previous = owner();
        acceptOwnership();
        emit AdminTransferred(previous, msg.sender);
    }

    function setArbiter(address next) external onlyOwner {
        require(next != address(0) && next != address(this), "invalid arbiter");
        emit ArbiterChanged(arbiter, next);
        arbiter = next;
    }

    function setTreasury(address next) external onlyOwner {
        require(next != address(0) && next != address(this), "invalid treasury");
        emit TreasuryChanged(treasury, next);
        treasury = next;
    }

    // ── Escrow lifecycle ─────────────────────────────────────────────────────

    function getEscrow(bytes32 id) external view returns (Escrow memory) { return records[id]; }

    /// @notice Explicit tuple return matches the backend ABI (including dynamic string).
    function escrows(bytes32 id) external view returns (Escrow memory) { return records[id]; }

    function createEscrow(bytes32 id, address beneficiary, uint256 amount, uint256 deadline, string calldata condition) external nonReentrant {
        require(id != bytes32(0) && records[id].depositor == address(0), "duplicate or zero id");
        require(beneficiary != address(0) && beneficiary != msg.sender && beneficiary != address(this), "invalid beneficiary");
        require(amount > 0, "invalid amount");
        require(deadline > block.timestamp && deadline <= block.timestamp + MAX_DEADLINE, "invalid deadline");
        records[id] = Escrow(msg.sender, beneficiary, amount, deadline, condition, false, false);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) == beforeBalance + amount, "inexact deposit");
        emit EscrowCreated(id, msg.sender, beneficiary, amount, deadline, condition);
    }

    function _active(bytes32 id) private view returns (Escrow storage e) {
        e = records[id];
        require(e.depositor != address(0) && !settled[id], "not active");
    }

    function confirmDelivery(bytes32 id) external nonReentrant {
        Escrow storage e = _active(id);
        require(!disputed[id], "disputed");
        require(block.timestamp < e.deadline, "expired");
        if (msg.sender == e.depositor) e.depositorConfirmed = true;
        else if (msg.sender == e.beneficiary) e.beneficiaryConfirmed = true;
        else revert("not a party");
        if (e.depositorConfirmed && e.beneficiaryConfirmed) _pay(id, e, true);
    }

    function dispute(bytes32 id, string calldata reason) external nonReentrant {
        Escrow storage e = _active(id);
        require(msg.sender == e.depositor || msg.sender == e.beneficiary, "not a party");
        require(!disputed[id], "already disputed");
        require(block.timestamp < e.deadline, "expired");
        require(bytes(reason).length > 0, "empty reason");
        disputed[id] = true;
        emit EscrowDisputed(id, msg.sender, reason);
    }

    function refundExpired(bytes32 id) external nonReentrant {
        Escrow storage e = _active(id);
        require(msg.sender == e.depositor, "not depositor");
        require(block.timestamp >= e.deadline, "not expired");
        require(!disputed[id], "disputed");
        _pay(id, e, false);
    }

    /// @notice Arbiter resolves an open dispute. Only the arbiter; never a party.
    function resolveDispute(bytes32 id, bool releaseToBeneficiary) external nonReentrant {
        require(msg.sender == arbiter, "not arbiter");
        Escrow storage e = _active(id);
        require(disputed[id], "not disputed");
        _pay(id, e, releaseToBeneficiary);
    }

    // ── Settlement ───────────────────────────────────────────────────────────

    function _pay(bytes32 id, Escrow storage e, bool release) private {
        // Checks-effects-interactions: mark settled before any external call.
        settled[id] = true;
        uint256 amount = e.amount;
        uint256 fee = release ? (amount * FEE_BPS) / BPS_DENOMINATOR : 0;
        uint256 net = amount - fee;
        address recipient = release ? e.beneficiary : e.depositor;

        uint256 contractBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        uint256 treasuryBefore = fee > 0 ? token.balanceOf(treasury) : 0;

        token.safeTransfer(recipient, net);
        if (fee > 0) token.safeTransfer(treasury, fee);

        require(token.balanceOf(address(this)) + amount == contractBefore, "inexact debit");
        require(token.balanceOf(recipient) == recipientBefore + net, "inexact credit");
        if (fee > 0) require(token.balanceOf(treasury) == treasuryBefore + fee, "inexact fee credit");

        if (release) {
            emit EscrowReleased(id, recipient, amount);
            if (fee > 0) emit EscrowFeePaid(id, treasury, fee);
        } else {
            emit EscrowRefunded(id, recipient, amount);
        }
    }
}
