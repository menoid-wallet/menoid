pragma circom 2.1.0;

include "./spend_core.circom";

/**
 * Transfer
 *
 * Spends up to 4 notes of ONE token and creates 3 notes of the same token:
 *      out[0] receiver
 *      out[1] change (back to the sender)
 *      out[2] relayer fee
 *
 * Nothing leaves the pool, so publicAmount is fixed to 0 and the token never
 * appears in the public signals: on-chain, a USDC transfer and a MON transfer
 * look the same.
 *
 * extDataHash binds everything the proof does not compute (the encrypted
 * notes, the outgoing record, the chain and the pool). Changing any of it
 * changes the hash and the proof no longer verifies.
 *
 * Refer: notes/zk_proof_transfer.txt
 */
template Transfer(nIns, nOuts, depth) {
    // ─── public (order must match NoidPool._transfer) ───
    signal input root;
    signal input nullifiers[nIns];
    signal input outCommitments[nOuts];
    signal input relayer;
    signal input extDataHash;

    // ─── private ───
    signal input token;
    signal input sk;
    signal input ownerAddress;
    signal input inAmounts[nIns];
    signal input inRandomness[nIns];
    signal input inPathElements[nIns][depth];
    signal input inPathIndices[nIns][depth];
    signal input outAmounts[nOuts];
    signal input outRandomness[nOuts];
    signal input outOwners[nOuts];

    component core = SpendCore(nIns, nOuts, depth);
    core.root <== root;
    core.relayer <== relayer;
    core.token <== token;
    core.publicAmount <== 0;
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

    // keeps extDataHash inside a constraint so it is bound to the proof
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main {public [
    root,
    nullifiers,
    outCommitments,
    relayer,
    extDataHash
]} = Transfer(4, 3, 20);
