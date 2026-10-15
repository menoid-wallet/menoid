// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../libraries/Interfaces.sol";

interface IV3PoolFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IV3SwapPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/**
 * V3PoolAdapter — routes a NoidPool swap straight through the pools of a
 * Uniswap V3 fork whose router is not Uniswap's SwapRouter02: Capricorn,
 * nad.fun's DEX on Monad, where Monad's memecoins trade.
 *
 * routeData is the same Uniswap V3 path as UniswapV3Adapter's:
 *
 *      tokenIn | fee | token | fee | ... | tokenOut       (20-byte addresses, 3-byte fees)
 *
 * Each hop's pool is the factory's getPool(tokenA, tokenB, fee), and only that
 * pool, while its swap is running, may call back for payment. Exact input:
 * every hop must take all of its input or the swap reverts, so no tokens are
 * ever left here. Middle hops pay out to this adapter, the last one straight
 * to the recipient (the pool, which re-measures what it got).
 *
 * quoteExactInput has QuoterV2's signature and return shape, so the backend
 * quotes this venue the way it quotes Uniswap: by eth_call, each hop's swap
 * runs and is reverted with its result. It never moves tokens.
 *
 * Only the pool can swap. It holds tokens only during that call.
 */
contract V3PoolAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    uint256 private constant ADDRESS_SIZE = 20;
    uint256 private constant HOP_SIZE = 23;   // fee (3) + next token (20)

    // TickMath's bounds: an exact-input hop may move the price as far as it must
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    IV3PoolFactory public immutable factory;
    address public immutable pool;

    // the hop in flight: the only caller allowed to collect, and what it may take
    address private activePool;
    bool private quoting;
    address private activeTokenIn;
    uint256 private activeAmountIn;

    // a quote's result, carried out of the reverted swap
    error QuoteResult(uint256 amountOwed, uint256 amountReceived);

    constructor(address factory_, address pool_) {
        require(factory_ != address(0) && pool_ != address(0), "Zero address");
        factory = IV3PoolFactory(factory_);
        pool = pool_;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata routeData
    ) external returns (uint256 amountOut) {
        require(msg.sender == pool, "Only the pool");
        bytes memory path = routeData;
        uint256 hops = _hops(path);
        require(_tokenAt(path, 0) == tokenIn, "Path must start with tokenIn");
        require(_tokenAt(path, hops) == tokenOut, "Path must end with tokenOut");

        amountOut = amountIn;
        for (uint256 i = 0; i < hops; i++) {
            (address a, uint24 fee, address b) = _hop(path, i);
            amountOut = _swapHop(a, b, fee, amountOut, i == hops - 1 ? recipient : address(this));
        }
        require(amountOut >= minAmountOut, "Insufficient output");
    }

    /// QuoterV2-compatible. Only the amounts are measured: the price and tick lists stay zero.
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        )
    {
        require(activePool == address(0), "Swap in progress");
        uint256 hops = _hops(path);
        sqrtPriceX96AfterList = new uint160[](hops);
        initializedTicksCrossedList = new uint32[](hops);
        uint256 gasBefore = gasleft();

        quoting = true;
        amountOut = amountIn;
        for (uint256 i = 0; i < hops; i++) {
            (address a, uint24 fee, address b) = _hop(path, i);
            amountOut = _quoteHop(a, b, fee, amountOut);
        }
        quoting = false;
        gasEstimate = gasBefore - gasleft();
    }

    // the pools call back under their fork's name; both run the same checks
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _collect(amount0Delta, amount1Delta);
    }

    // Capricorn (nad.fun's DEX on Monad) renamed it
    function capricornCLSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _collect(amount0Delta, amount1Delta);
    }

    function _collect(int256 amount0Delta, int256 amount1Delta) private {
        require(msg.sender == activePool && msg.sender != address(0), "Not the active pool");
        // exact input: the pool is owed the input (the positive delta) and pays out the other
        (int256 owedDelta, int256 paidDelta) = amount0Delta > 0 ? (amount0Delta, amount1Delta) : (amount1Delta, amount0Delta);
        require(owedDelta > 0 && paidDelta <= 0, "Unexpected deltas");
        uint256 owed = uint256(owedDelta);
        if (quoting) revert QuoteResult(owed, uint256(-paidDelta));

        require(owed == activeAmountIn, "Partial fill");
        activePool = address(0);   // collect once
        IERC20(activeTokenIn).safeTransfer(msg.sender, owed);
    }

    // ─── hops ───────────────────────────────────────────────────────────────

    function _swapHop(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, address to) private returns (uint256) {
        address v3pool = _poolFor(tokenIn, tokenOut, fee, amountIn);
        bool zeroForOne = tokenIn < tokenOut;
        activePool = v3pool;
        activeTokenIn = tokenIn;
        activeAmountIn = amountIn;
        (int256 amount0, int256 amount1) = IV3SwapPool(v3pool).swap(
            to,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        require(activePool == address(0), "Pool was not paid");
        int256 out = zeroForOne ? amount1 : amount0;
        require(out < 0, "No output");
        return uint256(-out);
    }

    function _quoteHop(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) private returns (uint256 received) {
        address v3pool = _poolFor(tokenIn, tokenOut, fee, amountIn);
        bool zeroForOne = tokenIn < tokenOut;
        activePool = v3pool;
        try IV3SwapPool(v3pool).swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, "") {
            revert("Quote did not revert");
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != QuoteResult.selector) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
            uint256 owed;
            assembly {
                owed := mload(add(reason, 36))
                received := mload(add(reason, 68))
            }
            require(owed == amountIn, "Not enough liquidity");
        }
        activePool = address(0);
    }

    function _poolFor(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) private view returns (address v3pool) {
        require(amountIn != 0 && amountIn <= uint256(type(int256).max), "Invalid amount");
        v3pool = factory.getPool(tokenIn, tokenOut, fee);
        require(v3pool != address(0), "No pool");
    }

    // ─── the path ───────────────────────────────────────────────────────────

    function _hops(bytes memory path) private pure returns (uint256) {
        require(
            path.length >= ADDRESS_SIZE + HOP_SIZE && (path.length - ADDRESS_SIZE) % HOP_SIZE == 0,
            "Invalid path"
        );
        return (path.length - ADDRESS_SIZE) / HOP_SIZE;
    }

    // the i-th token of the path (0 = tokenIn)
    function _tokenAt(bytes memory path, uint256 i) private pure returns (address token) {
        uint256 offset = i * HOP_SIZE;
        assembly {
            token := shr(96, mload(add(add(path, 32), offset)))
        }
    }

    // hop i: (tokenIn, fee, tokenOut)
    function _hop(bytes memory path, uint256 i) private pure returns (address a, uint24 fee, address b) {
        uint256 offset = i * HOP_SIZE;
        assembly {
            let p := add(add(path, 32), offset)
            a := shr(96, mload(p))
            fee := shr(232, mload(add(p, 20)))
            b := shr(96, mload(add(p, 23)))
        }
    }
}
