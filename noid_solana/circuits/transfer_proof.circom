pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/babyjub.circom";
include "./merkle_path.circom";
include "./range_check.circom";
/**
 * Transfer
 *
 * Consumes up to MAX_INPUTS (e.g. 4) private input notes
 * belonging to a single owner and creates up to 3 new
 * private output notes in one proof.
 *
 * Ownership:
 *      spendPk         = BabyJubJub(sk)  (spending keypair derived off-chain
 *                                         from sign("menoid_Wallet"))
 *      user_commitment = Poseidon(walletAddress, spendPk.x, spendPk.y)
 *      commitment      = Poseidon(1, amount, randomness, user_commitment)
 *      nullifier       = Poseidon(2, commitment, randomness, sk)
 *
 * Input notes are masked using an `enabled[]` flag, allowing
 * dummy slots to be ignored while keeping the circuit size fixed.
 *
 * All value conservation, ownership checks, Merkle inclusion,
 * and nullifier correctness are enforced inside the ZK circuit.
 *
 * Refer: notes/zk_proof_transfer.txt
 */


template TransferProof(max_inputs,  depth) {
    // ownership
    // private inputs
    signal input sk;            // BabyJubJub spending private key
    signal input owner_address; // real wallet address of the owner

    // relayer user commitment
    signal input relayer; //public

    // spendPk = BabyJubJub(sk)
    component spendPk = BabyPbk();
    spendPk.in <== sk;

    // user_commitment = Poseidon(address, spendPk.x, spendPk.y)
    component ownershipHasher = Poseidon(3);
    ownershipHasher.inputs[0] <== owner_address;
    ownershipHasher.inputs[1] <== spendPk.Ax;
    ownershipHasher.inputs[2] <== spendPk.Ay;

    signal user_commitment;
    user_commitment <== ownershipHasher.out;


    /// INPUTS SECTION

    // we need max_inpts of enalbled flags to check existence ✅
    // we need max_inputs of c_in i.e commitments ✅
    // we need a_in, r_in for every c_in for computation checkup ✅
    // max_inputs of roots , path_indices , path_elements i.e for every commitment to check leaf validity in the tree ✅
    // we need max_inputs of nullifiers to check nullifier == poseidon(c_in,r_in,sk) ✅
    // we need sum of inputs to check sumInputs == sumOutputs✅

    // enabled flag
    signal input enabled[max_inputs]; //public (0 or 1)

    // input commitments validity check
    signal input c_ins[max_inputs]; // private
    signal input a_ins[max_inputs]; // private
    signal input r_ins[max_inputs]; // private

    // cmx validity check in merkle tree
    signal input roots[max_inputs]; // public
    signal input pathElements[max_inputs][depth]; // private
    signal input pathIndices[max_inputs][depth];  // private

    // nullifier validity check
    signal input nullifiers[max_inputs]; // public

    // compute sum of inputs
    signal sum[max_inputs + 1];
    sum[0] <== 0;
    signal x[max_inputs];

    component hasher[max_inputs];
    component merklePath[max_inputs];
    component nullHasher[max_inputs];
    component inputRangeChecks[max_inputs];

    // note: in circom we cannot to circular addition like sum <== sum + amount;
    //       thats why we are using sum array.

    for (var i = 0; i < max_inputs; i++) {
        // enable flag constraint
        enabled[i] * (1 - enabled[i]) === 0;

        // amount range constraint
        inputRangeChecks[i] = RangeCheck(128);
        inputRangeChecks[i].in <== a_ins[i];

        // amount summation
        x[i] <== enabled[i] * a_ins[i];
        sum[i + 1] <== sum[i] + x[i];

        // input commitment computation checkup
        hasher[i] = Poseidon(4);
        hasher[i].inputs[0] <== 1; //<-- domain seperator
        hasher[i].inputs[1] <== a_ins[i];
        hasher[i].inputs[2] <== r_ins[i];
        hasher[i].inputs[3] <== user_commitment;

        enabled[i] * (c_ins[i] - hasher[i].out) === 0; //commitment checkup

        // root validity check for that commitment
        merklePath[i] = MerklePath(depth);
        merklePath[i].leaf <== c_ins[i];
        for (var j = 0; j < depth ; j++ ){
            pathIndices[i][j] * (1 - pathIndices[i][j]) === 0;

            merklePath[i].pathIndices[j] <== pathIndices[i][j];
            merklePath[i].pathElements[j] <== pathElements[i][j];
        }

        enabled[i] * (merklePath[i].computedRoot - roots[i]) === 0;

        // nullifier computation checkup for that commitment
        // nullifier -> poseidon(c_in,r_in,sk)
        nullHasher[i] = Poseidon(4);
        nullHasher[i].inputs[0] <== 2; // <-- domain sepeartor
        nullHasher[i].inputs[1] <== c_ins[i];
        nullHasher[i].inputs[2] <== r_ins[i]; // "r" used to create that commitment
        nullHasher[i].inputs[3] <== sk;  // why not user_commitment? because only the owner can compute the nullifier.

        enabled[i] * (nullHasher[i].out - nullifiers[i]) === 0;

    }

    // OUTPUTS SECTION
    // we need enabled flags (i.e only 3) 1.receiver 2.change 3.relayer ✅
    // we need output commitments ✅
    // we need a_out , r_out , receiver user commitment to check commitment validity ✅
    // sum of outputs ✅

    signal input output_enabled[3]; // public
    signal input c_outs[3]; // public
    signal input a_outs[3]; // private
    signal input r_outs[3]; //private
    signal input receivers[3]; //private (user commitments of the receivers)
    receivers[2] === relayer;

    component outHasher[3];
    component outputRangeChecks[3];

    signal out_sum[4];
    out_sum[0] <== 0;
    signal y[3];
    for (var i = 0 ; i < 3 ; i++){
        // output enabled flag constraint
        output_enabled[i] * (1 - output_enabled[i]) === 0;

        // output amount range constraint
        outputRangeChecks[i] = RangeCheck(128);
        outputRangeChecks[i].in <== a_outs[i];

        //output commitment checkup
        outHasher[i] = Poseidon(4);
        outHasher[i].inputs[0] <== 1;
        outHasher[i].inputs[1] <== a_outs[i];
        outHasher[i].inputs[2] <== r_outs[i];
        outHasher[i].inputs[3] <== receivers[i];

        y[i] <== output_enabled[i] * a_outs[i];
        out_sum[i + 1] <== out_sum[i] + y[i];

        output_enabled[i] * (c_outs[i] - outHasher[i].out) === 0;
    }

    // sum of inputs === sum of outputs
    sum[max_inputs] === out_sum[3];

}

component main {public [
    relayer,
    enabled,
    roots,
    nullifiers,
    output_enabled,
    c_outs
]} = TransferProof(4,20);
