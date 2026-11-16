// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Two-party confirmation escrow. Disputes freeze payment until admin resolution.
contract FlareHQEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    address public admin;
    address public pendingAdmin;
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
    event EscrowReleased(bytes32 indexed escrowId, address beneficiary, uint256 amount);
    event EscrowRefunded(bytes32 indexed escrowId, address depositor, uint256 amount);
    event AdminTransferStarted(address indexed currentAdmin, address indexed nextAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed nextAdmin);

    constructor(address token_, address admin_) {
        require(token_.code.length > 0 && admin_ != address(0), "invalid configuration");
        token = IERC20(token_);
        admin = admin_;
    }
    function transferAdmin(address next) external {
        require(msg.sender == admin && next != address(0), "invalid admin transfer");
        pendingAdmin = next;
        emit AdminTransferStarted(admin, next);
    }
    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "not pending admin");
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }
    function getEscrow(bytes32 id) external view returns (Escrow memory) { return records[id]; }
    // Explicit tuple return matches the backend ABI (including dynamic string).
    function escrows(bytes32 id) external view returns (Escrow memory) { return records[id]; }
    function createEscrow(bytes32 id, address beneficiary, uint256 amount, uint256 deadline, string calldata condition) external nonReentrant {
        require(id != bytes32(0) && records[id].depositor == address(0), "duplicate or zero id");
        require(beneficiary != address(0) && beneficiary != msg.sender && beneficiary != address(this), "invalid beneficiary");
        require(amount > 0 && deadline > block.timestamp, "invalid terms");
        records[id] = Escrow(msg.sender, beneficiary, amount, deadline, condition, false, false);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) == beforeBalance + amount, "inexact deposit");
        emit EscrowCreated(id, msg.sender, beneficiary, amount, deadline, condition);
    }
    function active(bytes32 id) private view returns (Escrow storage e) {
        e = records[id];
        require(e.depositor != address(0) && !settled[id], "not active");
    }
    function confirmDelivery(bytes32 id) external nonReentrant {
        Escrow storage e = active(id);
        require(!disputed[id] && block.timestamp < e.deadline, "disputed or expired");
        if (msg.sender == e.depositor) e.depositorConfirmed = true;
        else if (msg.sender == e.beneficiary) e.beneficiaryConfirmed = true;
        else revert("not a party");
        if (e.depositorConfirmed && e.beneficiaryConfirmed) pay(id, e, true);
    }
    function dispute(bytes32 id, string calldata reason) external nonReentrant {
        Escrow storage e = active(id);
        require(msg.sender == e.depositor || msg.sender == e.beneficiary, "not a party");
        require(!disputed[id] && block.timestamp < e.deadline && bytes(reason).length > 0, "invalid dispute");
        disputed[id] = true;
        emit EscrowDisputed(id, msg.sender, reason);
    }
    function refundExpired(bytes32 id) external nonReentrant {
        Escrow storage e = active(id);
        require(msg.sender == e.depositor && block.timestamp >= e.deadline && !disputed[id], "refund unavailable");
        pay(id, e, false);
    }
    function resolveDispute(bytes32 id, bool releaseToBeneficiary) external nonReentrant {
        require(msg.sender == admin, "not admin");
        Escrow storage e = active(id);
        require(disputed[id], "not disputed");
        pay(id, e, releaseToBeneficiary);
    }
    function pay(bytes32 id, Escrow storage e, bool release) private {
        settled[id] = true;
        address recipient = release ? e.beneficiary : e.depositor;
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, e.amount);
        require(token.balanceOf(address(this)) + e.amount == beforeBalance, "inexact debit");
        require(token.balanceOf(recipient) == recipientBefore + e.amount, "inexact credit");
        if (release) emit EscrowReleased(id, recipient, e.amount);
        else emit EscrowRefunded(id, recipient, e.amount);
    }
}
