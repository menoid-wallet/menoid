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

// WMON / WETH / WPOL
interface IWrappedNative {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}
