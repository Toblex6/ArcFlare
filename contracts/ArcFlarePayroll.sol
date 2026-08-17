// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArcFlarePayroll
/// @notice Bulk-pay tooling: a merchant funds one batch, then pays N
/// recipients in a single execution. This is deliberately SINGLE-PARTY —
/// per your handoff notes, payroll is the "cleanest target" for wallet
/// migration precisely because there's no two-party ownership ambiguity
/// like escrow/streams have. The merchant funds their own payroll and pays
/// their own team; there's no worker-trust problem to solve here the way
/// there is in ArcFlareJobEscrow.
///
/// This means payroll does NOT need the one-way-release guarantee that
/// job escrow has — a merchant CAN cancel/reclaim an unpaid batch, because
/// it's their own money and their own team, not a third party who needs
/// to trust the job won't be pulled.
contract ArcFlarePayroll is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum BatchStatus {
        None,
        Funded,      // budget locked, recipients set, not yet paid
        Executing,   // paid partially (see partial-failure handling below)
        Completed,   // all recipients paid successfully
        Cancelled    // merchant reclaimed unpaid funds before execution
    }

    struct PayrollBatch {
        address merchant;
        address token;           // USDC or EURC on Arc Testnet
        uint256 totalFunded;
        uint256 totalPaidOut;    // running total actually paid, for partial-failure tracking
        BatchStatus status;
        uint64 createdAt;
        uint32 recipientCount;
    }

    /// @notice relayer role — same pattern as ArcFlareJobEscrow, lets your
    /// backend submit payroll execution on the merchant's behalf so THEY
    /// don't need to hold gas either. Merchant still must have approved
    /// funding, or the relayer forwards already-settled funds, same as
    /// the job escrow relayer pattern.
    address public relayer;
    address public owner;

    uint256 public nextBatchId;
    mapping(uint256 => PayrollBatch) public batches;
    // batchId => recipient => amount owed (0 once paid)
    mapping(uint256 => mapping(address => uint256)) public recipientAmounts;
    // batchId => ordered list of recipients, for iteration
    mapping(uint256 => address[]) public batchRecipients;
    // batchId => recipient => paid flag, prevents double-pay on retry
    mapping(uint256 => mapping(address => bool)) public paid;

    event BatchFunded(uint256 indexed batchId, address indexed merchant, address token, uint256 totalFunded, uint32 recipientCount);
    event RecipientPaid(uint256 indexed batchId, address indexed recipient, uint256 amount);
    event BatchCompleted(uint256 indexed batchId, uint256 totalPaidOut);
    event BatchCancelled(uint256 indexed batchId, uint256 refundedAmount);
    event RelayerUpdated(address indexed newRelayer);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyRelayerOrMerchant(uint256 batchId) {
        require(
            msg.sender == relayer || msg.sender == batches[batchId].merchant,
            "not relayer or batch merchant"
        );
        _;
    }

    constructor(address _owner, address _relayer) {
        owner = _owner;
        relayer = _relayer;
    }

    function setRelayer(address newRelayer) external onlyOwner {
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }

    /// @notice Merchant funds a new payroll batch directly (holds own gas).
    /// recipients/amounts arrays must be the same length; total must equal
    /// the sum of amounts, checked to avoid funding/recipient mismatches.
    function fundBatch(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant returns (uint256 batchId) {
        batchId = _createBatch(msg.sender, token, recipients, amounts);
        IERC20(token).safeTransferFrom(msg.sender, address(this), batches[batchId].totalFunded);
    }

    /// @notice Relayer variant — same as fundBatch, but relayer submits and
    /// pays gas on behalf of `merchant`, typically after settling payment
    /// via x402/Gateway Wallet the same way job funding does. Relayer must
    /// already hold the funds (msg.sender in safeTransferFrom is the relayer).
    function fundBatchFor(
        address merchant,
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant returns (uint256 batchId) {
        require(msg.sender == relayer, "not relayer");
        batchId = _createBatch(merchant, token, recipients, amounts);
        IERC20(token).safeTransferFrom(msg.sender, address(this), batches[batchId].totalFunded);
    }

    function _createBatch(
        address merchant,
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) internal returns (uint256 batchId) {
        require(recipients.length > 0, "no recipients");
        require(recipients.length == amounts.length, "length mismatch");
        require(recipients.length <= 200, "batch too large - split into multiple batches"); // gas safety cap, tune based on actual Arc gas limits

        uint256 total = 0;
        batchId = nextBatchId++;

        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "bad recipient");
            require(amounts[i] > 0, "zero amount");
            recipientAmounts[batchId][recipients[i]] += amounts[i]; // += in case same recipient appears twice in the array intentionally
            total += amounts[i];
        }

        batchRecipients[batchId] = recipients;
        batches[batchId] = PayrollBatch({
            merchant: merchant,
            token: token,
            totalFunded: total,
            totalPaidOut: 0,
            status: BatchStatus.Funded,
            createdAt: uint64(block.timestamp),
            recipientCount: uint32(recipients.length)
        });

        emit BatchFunded(batchId, merchant, token, total, uint32(recipients.length));
    }

    /// @notice Executes payout for the whole batch. Callable by the relayer
    /// (gas-sponsored) or the merchant directly. Designed to be SAFE TO
    /// RETRY: if it fails partway (e.g. runs out of gas mid-loop on a large
    /// batch), already-paid recipients are skipped on retry via the `paid`
    /// mapping — no double-payment risk.
    function executeBatch(uint256 batchId) external onlyRelayerOrMerchant(batchId) nonReentrant {
        PayrollBatch storage batch = batches[batchId];
        require(
            batch.status == BatchStatus.Funded || batch.status == BatchStatus.Executing,
            "batch not in payable state"
        );

        batch.status = BatchStatus.Executing;
        address[] storage recipients = batchRecipients[batchId];

        for (uint256 i = 0; i < recipients.length; i++) {
            address recipient = recipients[i];
            if (paid[batchId][recipient]) continue; // already paid, skip (retry-safety)

            uint256 amount = recipientAmounts[batchId][recipient];
            if (amount == 0) continue;

            paid[batchId][recipient] = true; // set BEFORE transfer, checks-effects-interactions
            batch.totalPaidOut += amount;
            IERC20(batch.token).safeTransfer(recipient, amount);
            emit RecipientPaid(batchId, recipient, amount);
        }

        batch.status = BatchStatus.Completed;
        emit BatchCompleted(batchId, batch.totalPaidOut);
    }

    /// @notice Merchant reclaims any UNPAID portion of a batch before (or
    /// during, for a partially-executed one) execution completes. Unlike
    /// ArcFlareJobEscrow, this refund path is intentional here — payroll is
    /// single-party, the merchant is reclaiming their own money, there's no
    /// third-party worker trust being broken.
    function cancelBatch(uint256 batchId) external {
        PayrollBatch storage batch = batches[batchId];
        require(msg.sender == batch.merchant, "not merchant");
        require(
            batch.status == BatchStatus.Funded || batch.status == BatchStatus.Executing,
            "batch not cancellable"
        );

        uint256 unpaidAmount = batch.totalFunded - batch.totalPaidOut;
        batch.status = BatchStatus.Cancelled;

        if (unpaidAmount > 0) {
            IERC20(batch.token).safeTransfer(batch.merchant, unpaidAmount);
        }

        emit BatchCancelled(batchId, unpaidAmount);
    }

    function getBatch(uint256 batchId) external view returns (PayrollBatch memory) {
        return batches[batchId];
    }

    function getBatchRecipients(uint256 batchId) external view returns (address[] memory) {
        return batchRecipients[batchId];
    }
}
