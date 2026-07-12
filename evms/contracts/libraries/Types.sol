// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
uint32 constant MAX_INPUTS = 4;

struct Inputs {
    uint8[MAX_INPUTS] enabled; // decides wether input at index is present or not
    bytes32[MAX_INPUTS] roots; // tree roots which the respective commiment belongs to.
    uint256[MAX_INPUTS] poolIds; // poolid of that root
    bytes32[MAX_INPUTS] nullifiers; // nullifier for each commitment
}

// transfer call
struct TransferCall {
    // zk proof
    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;
    //input details
    Inputs inputs;
    // outputs (maximum of 3)
    bytes32 C1; // receiver commitment (Required)
    bytes32 C2; // change commitment
    bytes32 C3; // relayer commitment
    bytes encryptedNote1; // receiver encrypted note
    bytes encryptedNote2; // change encrypted note
    bytes encryptedNote3; // relayer encrypted note
}

/*
    * - Each TransferCall consumes between 1 and MAX_INPUTS private input notes
    * - Multiple TransferCalls can be executed atomically in a single transaction
    * - Later TransferCalls may spend commitments created by earlier TransferCalls
    *   within the same transaction
    * - This enables note aggregation and large fan-in transfers
    *   while remaining atomic and private
    */

/**
 * Zk proof for transfer
 * Consumes up to MAX_INPUTS (e.g. 4) private input notes
 * belonging to a single owner and creates up to 3 new
 * private output notes in one proof.
 *
 * For exact understanding Refer: notes/zk_proof_transfer.txt
 */

    // withdraw
/**
 * input commiments are surrendered
 * and the value of those inputs is transferred to the "To" account.
 * in withdraw also we need 2 extra commitments because 1. change 2. relayer
 */

struct WithdrawCall {
    // zkproof
    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;
    // input details
    Inputs inputs;
    // output details
    bytes32 C1; //change commitment
    bytes32 C2; //relayer commitment
    bytes encryptedNote1; // change encrypted note
    bytes encryptedNote2; // relayer encrypted note
    //withdraw amount for this call
    uint256 withdrawAmount;
}


    // helper functions
struct InsertedNote {
    uint256 poolId;
    bytes32 commitment;
}

