// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Spend shape — must match circuits/transfer_proof.circom and withdraw_proof.circom.
uint256 constant N_INS = 4;          // input notes per proof (dummies fill unused slots)
uint256 constant TRANSFER_OUTS = 3;  // receiver, change, relayer fee
uint256 constant WITHDRAW_OUTS = 2;  // change, relayer fee

struct Proof {
    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;
}

/**
 * Everything a transfer proof does not compute itself.
 * Its hash is a public signal (extDataHash), so none of it can be changed
 * after the proof is made — not by the relayer, not by a front-runner.
 */
struct TransferExtData {
    bytes[TRANSFER_OUTS] encryptedOutputs; // [receiver, change, relayer fee], each encrypted to its owner
    bytes outgoingRecord;                   // sender's own record of the payment (outgoing viewing key)
}

struct TransferCall {
    Proof proof;
    uint256 treeId;                          // tree the input notes live in
    bytes32 root;                            // a recent root of that tree
    bytes32[N_INS] nullifiers;               // always N_INS: dummy inputs publish random-looking ones
    bytes32[TRANSFER_OUTS] outCommitments;   // always TRANSFER_OUTS: unused outputs are zero-value notes
    bytes32 relayer;                         // user commitment that owns the fee note (last output)
    TransferExtData ext;
}

struct WithdrawExtData {
    address recipient;                      // public destination of the released funds
    bool unwrapNative;                      // wrapped native token only: send the native coin instead
    bytes[WITHDRAW_OUTS] encryptedOutputs;  // [change, relayer fee]
    bytes outgoingRecord;
}

struct WithdrawCall {
    Proof proof;
    uint256 treeId;
    bytes32 root;
    bytes32[N_INS] nullifiers;
    bytes32[WITHDRAW_OUTS] outCommitments;
    bytes32 relayer;
    address token;                           // token leaving the pool (public)
    uint256 amount;                          // amount leaving the pool (public)
    WithdrawExtData ext;
}

/**
 * A swap reuses the withdraw proof: amountIn of tokenIn leaves the private
 * balance. Where it goes, and the note it buys, are bound here.
 */
struct SwapExtData {
    address adapter;                        // whitelisted venue the pool routes through
    address tokenOut;
    uint256 minAmountOut;                   // the trade reverts below this
    uint256 deadline;                       // unix seconds
    bytes32 npkOut;                         // Poseidon(D_NPK, ownerUserCommitment, rOut): owner of the bought note
    bytes routeData;                        // adapter-specific route (Uniswap V3: the path)
    bytes encryptedOutput;                  // the bought note (amount is read from the Swapped event)
    bytes[WITHDRAW_OUTS] encryptedOutputs;  // [change, relayer fee] in tokenIn
    bytes outgoingRecord;
}

struct SwapCall {
    Proof proof;
    uint256 treeId;
    bytes32 root;
    bytes32[N_INS] nullifiers;
    bytes32[WITHDRAW_OUTS] outCommitments;  // [change, relayer fee] in tokenIn
    bytes32 relayer;
    address tokenIn;                         // the withdraw proof's public token
    uint256 amountIn;                        // the withdraw proof's public amount
    SwapExtData ext;
}
