// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArcFlarePaymentRouter
/// @notice Thin non-custodial payment router: customer pays token X, merchant
/// receives settlement token Y, atomically, in one transaction.
///
/// Flow (single tx, msg.sender = payer/trader):
///   payer -> router (pull X via transferFrom) -> SwapPool -> Y -> merchantSCA
///
/// DESIGN DECISION (v1): thin router over recipient-mode pool extension.
/// The deployed ArcFlareSwapPool pays `msg.sender` on swap() and already holds
/// seeded liquidity. Extending the pool would force a redeploy + liquidity
/// migration; the router leaves the canonical pool untouched and adds a single
/// trusted hop. Both router legs (EOA->contract pull, contract->EOA forward)
/// use transfer patterns already fee-measured on Arc testnet (see
/// scripts/swap-pool-e2e.ts); the two contract-side legs (router->pool,
/// pool->router) are measured by scripts/router-e2e.ts.
///
/// RULES (enforced on-chain, not by convention):
/// - ONLY the canonical USDC/EURC pair. Both token addresses and the pool
///   address are immutable, bound at construction, and cross-checked against
///   the pool's own tokenA()/tokenB(). No caller-supplied path, pool, or
///   token can reach an external call.
/// - minAmountOut is a floor on what the RECIPIENT is actually credited
///   (balance-delta), not just what the pool computed — so the final-leg
///   transfer fee is inside the guarantee. The same floor is also passed to
///   the pool so a bad quote reverts early with the pool's slippage error.
/// - deadline is enforced against block.timestamp. Zero minOut / zero amount
///   / expired deadline all revert.
/// - Recipient must be a non-zero address distinct from the router and the
///   pool (prevents burning output into protocol contracts).
/// - nonReentrant. External calls are limited to the three immutable
///   addresses (tokenIn, tokenOut, pool). The router holds no allowances
///   beyond the in-flight amountIn and forwards its full output-token delta
///   every call, so no customer funds can be stranded in normal operation.
/// - No owner, no pause, no rescue, non-upgradeable. Direct (non-route)
///   token transfers to this contract are NOT recoverable by design — the
///   route() path itself never leaves a residual (asserted in tests).
interface IArcFlareSwapPool {
    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut);
    function tokenA() external view returns (address);
    function tokenB() external view returns (address);
}

contract ArcFlarePaymentRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IERC20 public immutable eurc;
    IArcFlareSwapPool public immutable pool;

    event PaymentRouted(
        address indexed payer,
        address indexed tokenIn,
        uint256 amountIn,
        address indexed tokenOut,
        uint256 amountOut,
        address recipient,
        address pool
    );

    /// @param _usdc Canonical USDC address.
    /// @param _eurc Canonical EURC address.
    /// @param _pool Canonical ArcFlareSwapPool address. Its tokenA()/tokenB()
    /// must be exactly (_usdc, _eurc) in either order, otherwise construction
    /// reverts — a router can never be bound to a wrong/foreign pool.
    constructor(address _usdc, address _eurc, address _pool) {
        require(_usdc != address(0) && _eurc != address(0) && _pool != address(0), "bad address");
        require(_usdc != _eurc, "tokens must differ");
        IArcFlareSwapPool p = IArcFlareSwapPool(_pool);
        address a = p.tokenA();
        address b = p.tokenB();
        require(
            (a == _usdc && b == _eurc) || (a == _eurc && b == _usdc),
            "pool tokens mismatch canonical pair"
        );
        usdc = IERC20(_usdc);
        eurc = IERC20(_eurc);
        pool = p;
    }

    /// @notice Route an exact input of X into Y paid directly to `recipient`.
    /// @param tokenIn Canonical USDC or EURC address (X). tokenOut is the other.
    /// @param amountIn Exact X pulled from msg.sender (caller must approve router).
    /// @param minAmountOut Floor credited to `recipient` in Y base units. Must be > 0.
    /// @param deadline Unix timestamp; reverts when block.timestamp exceeds it.
    /// @param recipient Frozen merchantSCA. Must not be zero/router/pool.
    /// @return amountOut Actual Y credited to `recipient` (>= minAmountOut).
    function route(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        address recipient
    ) external nonReentrant returns (uint256 amountOut) {
        require(amountIn > 0, "zero amount in");
        require(minAmountOut > 0, "zero minOut");
        require(block.timestamp <= deadline, "quote expired");

        bool inIsUsdc = tokenIn == address(usdc);
        require(inIsUsdc || tokenIn == address(eurc), "unsupported token");
        IERC20 tokenOut = inIsUsdc ? eurc : usdc;

        require(recipient != address(0), "bad recipient");
        require(recipient != address(this) && recipient != address(pool), "bad recipient");

        // Pull X from the payer. Any sender-side transfer fee is debited from
        // the payer on top (observed Arc behavior); the router is credited the
        // full amountIn, matching the direct-swap pattern.
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Exact, single-use allowance for the canonical pool only.
        IERC20(tokenIn).forceApprove(address(pool), amountIn);

        uint256 recipientBefore = tokenOut.balanceOf(recipient);

        // Pool pays msg.sender (= this router). Pool-level slippage guard
        // reverts early on a stale quote; the binding guarantee is the
        // recipient-credit check below.
        pool.swap(tokenIn, amountIn, minAmountOut);

        // Allowance must be fully consumed — no lingering approval survives.
        require(IERC20(tokenIn).allowance(address(this), address(pool)) == 0, "allowance leftover");

        // Forward EVERYTHING received (full delta, including any dust that was
        // already here — nothing is ever stranded by route()).
        uint256 routerOutBalance = tokenOut.balanceOf(address(this));
        require(routerOutBalance > 0, "no output received");
        tokenOut.safeTransfer(recipient, routerOutBalance);

        amountOut = tokenOut.balanceOf(recipient) - recipientBefore;
        require(amountOut >= minAmountOut, "slippage: recipient below minimum");

        emit PaymentRouted(
            msg.sender,
            tokenIn,
            amountIn,
            address(tokenOut),
            amountOut,
            recipient,
            address(pool)
        );
    }
}
