pragma circom 2.1.0;

include "./spend_core.circom";
include "./range_check.circom";

/**
 * Withdraw
 *
 * Spends up to 4 notes of ONE token, releases `publicAmount` of `publicToken`
 * out of the pool, and creates 2 notes of the same token:
 *      out[0] change (back to the sender)
 *      out[1] relayer fee
 *
 * Here the token must be public (the contract has to know what to send), so
 * the token used inside every commitment IS publicToken.
 *
 * The destination address is not a circuit signal: it is part of the
 * withdraw ext data, and extDataHash binds it. A relayer that changes the
 * recipient changes the hash, and the proof no longer verifies.
 *
 * Swaps will reuse this circuit: "an amount of a token leaves the private
 * balance" is the same statement; only where the value goes differs.
 *
 * Refer: notes/zk_proof_withdraw.txt
 */
template Withdraw(nIns, nOuts, depth) {
    // ─── public (order must match NoidPool._withdraw) ───
    signal input root;
    signal input nullifiers[nIns];
    signal input outCommitments[nOuts];
    signal input relayer;
    signal input publicToken;
    signal input publicAmount;
    signal input extDataHash;

    // ─── private ───
    signal input sk;
    signal input ownerAddress;
    signal input inAmounts[nIns];
    signal input inRandomness[nIns];
    signal input inPathElements[nIns][depth];
    signal input inPathIndices[nIns][depth];
    signal input outAmounts[nOuts];
    signal input outRandomness[nOuts];
    signal input outOwners[nOuts];

    // the released amount is bounded like every other amount
    component amountRange = RangeCheck(128);
    amountRange.in <== publicAmount;

    component core = SpendCore(nIns, nOuts, depth);
    core.root <== root;
    core.relayer <== relayer;
    core.token <== publicToken;
    core.publicAmount <== publicAmount;
    core.sk <== sk;
    core.ownerAddress <== ownerAddress;

    for (var i = 0; i < nIns; i++) {
        core.nullifiers[i] <== nullifiers[i];
        core.inAmounts[i] <== inAmounts[i];
        core.inRandomness[i] <== inRandomness[i];
        for (var j = 0; j < depth; j++) {
            core.inPathElements[i][j] <== inPathElements[i][j];
            core.inPathIndices[i][j] <== inPathIndices[i][j];
        }
    }

    for (var i = 0; i < nOuts; i++) {
        core.outCommitments[i] <== outCommitments[i];
        core.outAmounts[i] <== outAmounts[i];
        core.outRandomness[i] <== outRandomness[i];
        core.outOwners[i] <== outOwners[i];
    }

    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main {public [
    root,
    nullifiers,
    outCommitments,
    relayer,
    publicToken,
    publicAmount,
    extDataHash
]} = Withdraw(4, 2, 20);
