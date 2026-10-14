pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/comparators.circom";
include "./note_lib.circom";
include "./merkle_path.circom";
include "./range_check.circom";

/**
 * SpendCore
 *
 * The part transfer and withdraw share. Written once so a fix can never land
 * in one circuit and miss the other.
 *
 * Proves, for one owner and one token:
 *      - the prover knows sk for the user commitment every input is locked to
 *      - every real input exists in the tree under `root`
 *      - every nullifier is Poseidon(D_NF, nk, commitment, randomness)
 *      - every output commitment is well formed
 *      - the last output belongs to the relayer
 *      - sum(inputs) == sum(outputs) + publicAmount
 *
 * Fixed shape: there are always nIns nullifiers and nOuts output commitments.
 * An input with amount 0 is a dummy: its Merkle check is skipped, but its
 * nullifier is still computed and published, so it looks like a real one.
 * Unused outputs are zero-value notes. Nothing public reveals how many notes
 * were really spent or created.
 *
 * A single `token` signal feeds every input and output commitment, so a proof
 * can only move value within one token.
 */
template SpendCore(nIns, nOuts, depth) {
    // shared with the wrapper circuit
    signal input root;
    signal input nullifiers[nIns];
    signal input outCommitments[nOuts];
    signal input relayer;          // relayer's user commitment (owner of the last output)
    signal input token;
    signal input publicAmount;     // value leaving the pool (0 for transfers)

    // ownership
    signal input sk;
    signal input ownerAddress;

    // input notes
    signal input inAmounts[nIns];
    signal input inRandomness[nIns];
    signal input inPathElements[nIns][depth];
    signal input inPathIndices[nIns][depth];

    // output notes
    signal input outAmounts[nOuts];
    signal input outRandomness[nOuts];
    signal input outOwners[nOuts];  // user commitments of the receivers

    // ─── OWNERSHIP ───
    component keys = OwnerKeys();
    keys.sk <== sk;
    keys.ownerAddress <== ownerAddress;

    // ─── INPUTS ───
    component inRange[nIns];
    component inNote[nIns];
    component inNullifier[nIns];
    component inPath[nIns];
    component inIsDummy[nIns];

    signal inSum[nIns + 1];
    inSum[0] <== 0;

    for (var i = 0; i < nIns; i++) {
        // 0 <= amount < 2^128 (no wrap-around through the field)
        inRange[i] = RangeCheck(128);
        inRange[i].in <== inAmounts[i];

        // the note is locked to the prover's own user commitment
        inNote[i] = NoteCommitment();
        inNote[i].token <== token;
        inNote[i].amount <== inAmounts[i];
        inNote[i].owner <== keys.userCommitment;
        inNote[i].randomness <== inRandomness[i];

        inNullifier[i] = NoteNullifier();
        inNullifier[i].nullifierKey <== keys.nullifierKey;
        inNullifier[i].commitment <== inNote[i].commitment;
        inNullifier[i].randomness <== inRandomness[i];
        inNullifier[i].nullifier === nullifiers[i];

        inPath[i] = MerklePath(depth);
        inPath[i].leaf <== inNote[i].commitment;
        for (var j = 0; j < depth; j++) {
            inPath[i].pathElements[j] <== inPathElements[i][j];
            inPath[i].pathIndices[j] <== inPathIndices[i][j];
        }

        // a real note (amount != 0) must be in the tree
        inIsDummy[i] = IsZero();
        inIsDummy[i].in <== inAmounts[i];
        (1 - inIsDummy[i].out) * (inPath[i].computedRoot - root) === 0;

        inSum[i + 1] <== inSum[i] + inAmounts[i];
    }

    // ─── OUTPUTS ───
    component outRange[nOuts];
    component outNote[nOuts];

    signal outSum[nOuts + 1];
    outSum[0] <== 0;

    for (var i = 0; i < nOuts; i++) {
        outRange[i] = RangeCheck(128);
        outRange[i].in <== outAmounts[i];

        outNote[i] = NoteCommitment();
        outNote[i].token <== token;
        outNote[i].amount <== outAmounts[i];
        outNote[i].owner <== outOwners[i];
        outNote[i].randomness <== outRandomness[i];
        outNote[i].commitment === outCommitments[i];

        outSum[i + 1] <== outSum[i] + outAmounts[i];
    }

    // the last output slot is always the relayer's fee note
    outOwners[nOuts - 1] === relayer;

    // ─── CONSERVATION ───
    inSum[nIns] === outSum[nOuts] + publicAmount;
}
