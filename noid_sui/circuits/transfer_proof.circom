pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "./merkle_path.circom";
include "./range_check.circom";

template Hash3() {
    signal input inputs[3];
    signal output out;
    
    component h1 = Poseidon(2);
    h1.inputs[0] <== inputs[0];
    h1.inputs[1] <== inputs[1];
    
    component h2 = Poseidon(2);
    h2.inputs[0] <== h1.out;
    h2.inputs[1] <== inputs[2];
    
    out <== h2.out;
}

template Hash4() {
    signal input inputs[4];
    signal output out;
    
    component h1 = Poseidon(2);
    h1.inputs[0] <== inputs[0];
    h1.inputs[1] <== inputs[1];
    
    component h2 = Poseidon(2);
    h2.inputs[0] <== inputs[2];
    h2.inputs[1] <== inputs[3];
    
    component h3 = Poseidon(2);
    h3.inputs[0] <== h1.out;
    h3.inputs[1] <== h2.out;
    
    out <== h3.out;
}

/**
 * Transfer
 *
 * Consumes up to MAX_INPUTS (e.g. 4) private input notes
 * belonging to a single owner and creates up to 3 new
 * private output notes in one proof.
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
    signal input sk;    // PrivateKey of the wallet
    signal input pk;    // zkPublicKey of the wallet
    
    // relayer address
    signal input relayer; //public 

    // pk = poseidon(sk)
    component ownershipHasher = Poseidon(2);
    ownershipHasher.inputs[0] <== 3; // <--- domain separator
    ownershipHasher.inputs[1] <== sk;
    pk === ownershipHasher.out; // zk publickey ownership constraint


    /// INPUTS SECTION

    // enabled flag
    signal input enabled[max_inputs]; // private
    signal input enabled_hash;        // public

    // input commitments validity check
    signal input c_ins[max_inputs]; // private
    signal input a_ins[max_inputs]; // private
    signal input r_ins[max_inputs]; // private 

    // cmx validity check in merkle tree
    signal input roots[max_inputs]; // private
    signal input roots_hash;        // public
    signal input pathElements[max_inputs][depth]; // private
    signal input pathIndices[max_inputs][depth];  // private

    // nullifier validity check
    signal input nullifiers[max_inputs]; // private
    signal input nullifiers_hash;        // public

    // compute sum of inputs
    signal sum[max_inputs + 1]; 
    sum[0] <== 0;  
    signal x[max_inputs];

    component hasher[max_inputs];
    component merklePath[max_inputs];
    component nullHasher[max_inputs];
    component inputRangeChecks[max_inputs];

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
        hasher[i].inputs[0] <== 1; //<-- domain separator
        hasher[i].inputs[1] <== a_ins[i];
        hasher[i].inputs[2] <== r_ins[i];
        hasher[i].inputs[3] <== pk;

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
        nullHasher[i].inputs[0] <== 2; // <-- domain separator
        nullHasher[i].inputs[1] <== c_ins[i]; 
        nullHasher[i].inputs[2] <== r_ins[i]; // "r" used to create that commitment
        nullHasher[i].inputs[3] <== sk;  // why not pk? because the sender can compute the nullifier.

        enabled[i] * (nullHasher[i].out - nullifiers[i]) === 0;

    }

    // OUTPUTS SECTION

    signal input output_enabled[3]; // private
    signal input output_enabled_hash; // public
    signal input c_outs[3]; // private
    signal input c_outs_hash; // public
    signal input a_outs[3]; // private
    signal input r_outs[3]; // private
    signal input receivers[3]; // private
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

    // Array Hashing Constraints
    component enabledHasher = Hash4();
    for (var i = 0; i < max_inputs; i++) {
        enabledHasher.inputs[i] <== enabled[i];
    }
    enabled_hash === enabledHasher.out;

    component rootsHasher = Hash4();
    for (var i = 0; i < max_inputs; i++) {
        rootsHasher.inputs[i] <== roots[i];
    }
    roots_hash === rootsHasher.out;

    component nullifiersHasher = Hash4();
    for (var i = 0; i < max_inputs; i++) {
        nullifiersHasher.inputs[i] <== nullifiers[i];
    }
    nullifiers_hash === nullifiersHasher.out;

    component outputEnabledHasher = Hash3();
    for (var i = 0; i < 3; i++) {
        outputEnabledHasher.inputs[i] <== output_enabled[i];
    }
    output_enabled_hash === outputEnabledHasher.out;

    component cOutsHasher = Hash3();
    for (var i = 0; i < 3; i++) {
        cOutsHasher.inputs[i] <== c_outs[i];
    }
    c_outs_hash === cOutsHasher.out;
} 

component main {public [ 
    relayer,
    enabled_hash,
    roots_hash,
    nullifiers_hash,
    output_enabled_hash,
    c_outs_hash
]} = TransferProof(4,20);