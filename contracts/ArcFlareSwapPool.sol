// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArcFlareSwapPool
/// @notice Minimal constant-product (x*y=k) swap pool for USDC <-> EURC.
///
/// HONEST LIMITATIONS — READ BEFORE DEPLOYING:
/// - This pool starts with ZERO liquidity. It does nothing useful until
///   someone deposits both tokens via addLiquidity(). If you deploy this
///   and don't seed it, every swap will revert or return garbage pricing.
/// - No price oracle, no slippage protection beyond the caller-supplied
///   minAmountOut, no protection against low-liquidity manipulation. This
///   is the simplest CORRECT AMM mechanism, not a production-grade DEX.
///   A real integration with an existing Arc-native DEX/aggregator (if one
///   exists) would give better pricing and real liquidity depth — this
///   contract is a fallback/starting point, not a recommendation to skip
///   that research.
/// - USDC and EURC both assumed 6 decimals here (matches Circle's standard
///   issuance) — verify against the actual deployed token contracts before
///   relying on this, a decimals mismatch will silently produce wrong
///   pricing rather than reverting.
/// - Only supports a single USDC/EURC pair. Not a generalized multi-pool
///   AMM factory.
contract ArcFlareSwapPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable tokenA; // USDC
    IERC20 public immutable tokenB; // EURC

    uint256 public reserveA;
    uint256 public reserveB;

    uint256 public totalLiquidityShares;
    mapping(address => uint256) public liquidityShares;

    uint256 public constant FEE_BPS = 30; // 0.3%, standard constant-product fee — adjust if you want a different rate

    event LiquidityAdded(address indexed provider, uint256 amountA, uint256 amountB, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 amountA, uint256 amountB, uint256 shares);
    event Swapped(address indexed trader, address tokenIn, uint256 amountIn, uint256 amountOut);

    constructor(address _tokenA, address _tokenB) {
        require(_tokenA != address(0) && _tokenB != address(0), "bad token address");
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
    }

    /// @notice Seeds or adds to the pool. First deposit sets the initial
    /// price ratio — get this wrong and the pool will quote a bad
    /// USDC/EURC rate until arbitraged back, which with low liquidity
    /// could take a while or never fully correct. Consider seeding with
    /// amounts reflecting the real-world USDC/EUR exchange rate.
    function addLiquidity(uint256 amountA, uint256 amountB) external nonReentrant returns (uint256 shares) {
        require(amountA > 0 && amountB > 0, "zero amounts");

        tokenA.safeTransferFrom(msg.sender, address(this), amountA);
        tokenB.safeTransferFrom(msg.sender, address(this), amountB);

        if (totalLiquidityShares == 0) {
            shares = sqrt(amountA * amountB);
        } else {
            uint256 shareA = (amountA * totalLiquidityShares) / reserveA;
            uint256 shareB = (amountB * totalLiquidityShares) / reserveB;
            shares = shareA < shareB ? shareA : shareB; // take the smaller to avoid over-crediting an imbalanced deposit
        }
        require(shares > 0, "insufficient liquidity minted");

        reserveA += amountA;
        reserveB += amountB;
        liquidityShares[msg.sender] += shares;
        totalLiquidityShares += shares;

        emit LiquidityAdded(msg.sender, amountA, amountB, shares);
    }

    function removeLiquidity(uint256 shares) external nonReentrant returns (uint256 amountA, uint256 amountB) {
        require(shares > 0 && shares <= liquidityShares[msg.sender], "bad share amount");

        amountA = (shares * reserveA) / totalLiquidityShares;
        amountB = (shares * reserveB) / totalLiquidityShares;

        liquidityShares[msg.sender] -= shares;
        totalLiquidityShares -= shares;
        reserveA -= amountA;
        reserveB -= amountB;

        tokenA.safeTransfer(msg.sender, amountA);
        tokenB.safeTransfer(msg.sender, amountB);

        emit LiquidityRemoved(msg.sender, amountA, amountB, shares);
    }

    /// @notice Swaps an exact amount of tokenIn for tokenOut. Reverts if
    /// the output would be less than minAmountOut — ALWAYS compute this
    /// client-side with a slippage tolerance before calling; passing 0
    /// disables slippage protection entirely, do not do that in production.
    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) external nonReentrant returns (uint256 amountOut) {
        require(amountIn > 0, "zero amount in");
        bool isAToB = tokenIn == address(tokenA);
        require(isAToB || tokenIn == address(tokenB), "unsupported token");
        require(reserveA > 0 && reserveB > 0, "pool not seeded - call addLiquidity first");

        (uint256 reserveIn, uint256 reserveOut) = isAToB ? (reserveA, reserveB) : (reserveB, reserveA);

        uint256 amountInWithFee = amountIn * (10_000 - FEE_BPS);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10_000 + amountInWithFee);

        require(amountOut >= minAmountOut, "slippage: output below minimum");
        require(amountOut < reserveOut, "insufficient pool liquidity for this swap size");

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        if (isAToB) {
            reserveA += amountIn;
            reserveB -= amountOut;
            tokenB.safeTransfer(msg.sender, amountOut);
        } else {
            reserveB += amountIn;
            reserveA -= amountOut;
            tokenA.safeTransfer(msg.sender, amountOut);
        }

        emit Swapped(msg.sender, tokenIn, amountIn, amountOut);
    }

    /// @notice Read-only quote — call this before swap() to compute a
    /// reasonable minAmountOut client-side (e.g. quote * 0.99 for 1% slippage tolerance).
    function getQuote(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut) {
        bool isAToB = tokenIn == address(tokenA);
        require(isAToB || tokenIn == address(tokenB), "unsupported token");
        if (reserveA == 0 || reserveB == 0) return 0;

        (uint256 reserveIn, uint256 reserveOut) = isAToB ? (reserveA, reserveB) : (reserveB, reserveA);
        uint256 amountInWithFee = amountIn * (10_000 - FEE_BPS);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10_000 + amountInWithFee);
    }

    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
