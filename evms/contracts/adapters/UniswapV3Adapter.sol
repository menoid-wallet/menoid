// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../libraries/Interfaces.sol";

// Uniswap SwapRouter02 (@uniswap/swap-router-contracts): exactInput has no
// deadline field — the pool enforces its own deadline.
interface IUniswapV3SwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * UniswapV3Adapter — routes a NoidPool swap through Uniswap V3.
 *
 * routeData is a Uniswap V3 path:
 *
 *      tokenIn | fee | token | fee | ... | tokenOut       (20-byte addresses, 3-byte fees)
 *
 * Menoid's backend picks the path (helpers/uniswap.js findBestRoute, using
 * QuoterV2); the user's proof binds it, so nobody can change it afterwards.
 *
 * Only the pool can call this. It holds tokens only during the call, approves
 * the router for exactly amountIn, and has the output sent straight to the
 * pool, which re-measures it. A wrong path can only fail.
 */
contract UniswapV3Adapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    uint256 private constant ADDRESS_SIZE = 20;
    uint256 private constant HOP_SIZE = 23;   // fee (3) + next token (20)

    IUniswapV3SwapRouter02 public immutable router;
    address public immutable pool;

    constructor(address router_, address pool_) {
        require(router_ != address(0) && pool_ != address(0), "Zero address");
        router = IUniswapV3SwapRouter02(router_);
        pool = pool_;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata path
    ) external returns (uint256 amountOut) {
        require(msg.sender == pool, "Only the pool");
        require(
            path.length >= ADDRESS_SIZE + HOP_SIZE && (path.length - ADDRESS_SIZE) % HOP_SIZE == 0,
            "Invalid path"
        );
        require(address(bytes20(path[:ADDRESS_SIZE])) == tokenIn, "Path must start with tokenIn");
        require(address(bytes20(path[path.length - ADDRESS_SIZE:])) == tokenOut, "Path must end with tokenOut");

        IERC20(tokenIn).forceApprove(address(router), amountIn);
        amountOut = router.exactInput(
            IUniswapV3SwapRouter02.ExactInputParams({
                path: path,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut
            })
        );
        // exactInput spends all of amountIn; leave no allowance behind
        IERC20(tokenIn).forceApprove(address(router), 0);
    }
}
