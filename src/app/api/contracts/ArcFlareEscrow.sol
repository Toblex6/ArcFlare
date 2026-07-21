// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─── FlareHQ Trustless Escrow Contract ──────────────────────────────────────
// Deployed on Arc Testnet (Chain ID: 84532)
// Integrates with Circle CCTP V2 USDC on Arc L1
// Supports merchant-agent trustless payment flows

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ArcFlareEscrow {
    // ─── USDC contract on Arc Testnet ─────────────────────────────────────
    address public constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;

    // ─── FlareHQ admin — can resolve disputes ────────────────────────────
    address public admin;

    // ─── Escrow states ────────────────────────────────────────────────────
    enum EscrowStatus { ACTIVE, RELEASED, REFUNDED, DISPUTED }

    struct Escrow {
        address depositor;      // Agent or merchant who locks funds
        address beneficiary;    // Agent or merchant who receives funds
        uint256 amount;         // USDC amount locked (in 6 decimals)
        uint256 deadline;       // Unix timestamp — auto-refund after this
        EscrowStatus status;
        string reference;       // FlareHQ payment reference
        bool depositorConfirmed;
        bool beneficiaryConfirmed;
    }

    // ─── Storage ──────────────────────────────────────────────────────────
    mapping(bytes32 => Escrow) public escrows;
    bytes32[] public escrowIds;

    // ─── Events ───────────────────────────────────────────────────────────
    event EscrowCreated(bytes32 indexed escrowId, address depositor, address beneficiary, uint256 amount, string reference);
    event EscrowConfirmed(bytes32 indexed escrowId, address confirmedBy);
    event EscrowReleased(bytes32 indexed escrowId, address beneficiary, uint256 amount);
    event EscrowRefunded(bytes32 indexed escrowId, address depositor, uint256 amount);
    event EscrowDisputed(bytes32 indexed escrowId, address raisedBy);
    event DisputeResolved(bytes32 indexed escrowId, address winner, uint256 amount);

    constructor() {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "FlareHQ: Not admin");
        _;
    }

    // ─── Create a new escrow ──────────────────────────────────────────────
    function createEscrow(
        address beneficiary,
        uint256 amount,
        uint256 deadlineSeconds,
        string calldata reference
    ) external returns (bytes32 escrowId) {
        require(beneficiary != address(0), "Invalid beneficiary");
        require(amount > 0, "Amount must be > 0");
        require(deadlineSeconds > block.timestamp, "Deadline must be in future");

        // Transfer USDC from depositor to this contract
        bool transferred = IERC20(USDC).transferFrom(msg.sender, address(this), amount);
        require(transferred, "USDC transfer failed");

        escrowId = keccak256(
            abi.encodePacked(msg.sender, beneficiary, amount, block.timestamp, reference)
        );

        escrows[escrowId] = Escrow({
            depositor: msg.sender,
            beneficiary: beneficiary,
            amount: amount,
            deadline: deadlineSeconds,
            status: EscrowStatus.ACTIVE,
            reference: reference,
            depositorConfirmed: false,
            beneficiaryConfirmed: false
        });

        escrowIds.push(escrowId);

        emit EscrowCreated(escrowId, msg.sender, beneficiary, amount, reference);
    }

    // ─── Confirm delivery (both parties must confirm to release) ─────────
    function confirmDelivery(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.ACTIVE, "Escrow not active");
        require(
            msg.sender == e.depositor || msg.sender == e.beneficiary,
            "Not a party to this escrow"
        );

        if (msg.sender == e.depositor) e.depositorConfirmed = true;
        if (msg.sender == e.beneficiary) e.beneficiaryConfirmed = true;

        emit EscrowConfirmed(escrowId, msg.sender);

        // Auto-release when both confirm
        if (e.depositorConfirmed && e.beneficiaryConfirmed) {
            _release(escrowId);
        }
    }

    // ─── Release funds to beneficiary (admin or both confirmed) ──────────
    function release(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.ACTIVE, "Escrow not active");
        require(
            msg.sender == admin ||
            (msg.sender == e.depositor && e.beneficiaryConfirmed) ||
            (msg.sender == e.beneficiary && e.depositorConfirmed),
            "Not authorized to release"
        );
        _release(escrowId);
    }

    function _release(bytes32 escrowId) internal {
        Escrow storage e = escrows[escrowId];
        e.status = EscrowStatus.RELEASED;
        IERC20(USDC).transfer(e.beneficiary, e.amount);
        emit EscrowReleased(escrowId, e.beneficiary, e.amount);
    }

    // ─── Refund to depositor after deadline ───────────────────────────────
    function refund(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.ACTIVE, "Escrow not active");
        require(
            block.timestamp > e.deadline,
            "Deadline not reached yet"
        );
        require(
            msg.sender == e.depositor || msg.sender == admin,
            "Not authorized to refund"
        );

        e.status = EscrowStatus.REFUNDED;
        IERC20(USDC).transfer(e.depositor, e.amount);
        emit EscrowRefunded(escrowId, e.depositor, e.amount);
    }

    // ─── Raise dispute ────────────────────────────────────────────────────
    function dispute(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.ACTIVE, "Escrow not active");
        require(
            msg.sender == e.depositor || msg.sender == e.beneficiary,
            "Not a party to this escrow"
        );

        e.status = EscrowStatus.DISPUTED;
        emit EscrowDisputed(escrowId, msg.sender);
    }

    // ─── Admin resolves dispute ───────────────────────────────────────────
    function resolveDispute(bytes32 escrowId, address winner) external onlyAdmin {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.DISPUTED, "Escrow not disputed");
        require(
            winner == e.depositor || winner == e.beneficiary,
            "Winner must be a party"
        );

        e.status = winner == e.beneficiary
            ? EscrowStatus.RELEASED
            : EscrowStatus.REFUNDED;

        IERC20(USDC).transfer(winner, e.amount);
        emit DisputeResolved(escrowId, winner, e.amount);
    }

    // ─── View escrow details ──────────────────────────────────────────────
    function getEscrow(bytes32 escrowId) external view returns (Escrow memory) {
        return escrows[escrowId];
    }

    function getEscrowCount() external view returns (uint256) {
        return escrowIds.length;
    }

    // ─── Update admin ─────────────────────────────────────────────────────
    function transferAdmin(address newAdmin) external onlyAdmin {
        admin = newAdmin;
    }
}
