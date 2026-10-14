// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// public signals: [root, nullifiers x4, outCommitments x3, relayer, extDataHash]
interface ITransferVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[10] calldata publicSignals
    ) external view returns (bool);
}

// public signals: [root, nullifiers x4, outCommitments x2, relayer, token, amount, extDataHash]
interface IWithdrawVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[11] calldata publicSignals
    ) external view returns (bool);
}

/**
 * A swap venue the pool can route through (Uniswap V3, an aggregator, ...).
 *
 * The pool sends exactly amountIn of tokenIn to the adapter, calls swap, and
 * then measures its own tokenOut balance. The return value is informational:
 * the pool never trusts it.
 */
interface ISwapAdapter {
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata routeData
    ) external returns (uint256 amountOut);
}

// WMON / WETH / WPOL
interface IWrappedNative {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}
