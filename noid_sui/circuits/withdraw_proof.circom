pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "./merkle_path.circom";
include "./range_check.circom";

template Hash2() {
    signal input inputs[2];
    signal output out;
    
    component h1 = Poseidon(2);
    h1.inputs[0] <== inputs[0];
    h1.inputs[1] <== inputs[1];
    
    out <== h1.out;
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
 * Withdraw
 *
 * Consumes up to MAX_INPUTS private input notes
 * belonging to a single owner and releases ETH to a public
 * address, while optionally creating up to 2 new private
 * output notes (change and relayer).
 *
 * Input notes are masked using an `enabled[]` flag, allowing
 * dummy slots to be ignored while keeping the circuit size fixed.
 *
 * All value conservation, Merkle inclusion, ownership checks,
 * and nullifier correctness are enforced inside the ZK circuit.
 */

template WithdrawProof(max_inputs, depth) {
    // ownership
    signal input pk; // private
    signal input sk; // private

    //receiver
    signal input receiver; //public <- address
    signal input changeReceiver; //private
    //relayer
    signal input relayer; //public


    // owndership check
    component ownHasher = Poseidon(2);
    ownHasher.inputs[0] <== 3;
    ownHasher.inputs[1] <== sk;
    pk === ownHasher.out;

    //INPUTS VALIDATION

    // commitments validity required fields
    signal input enabled[max_inputs];  // 0 or 1                                       // private
    signal input enabled_hash;                                                         // public
    signal input c_ins[max_inputs]; // cmx                                             //private
    signal input a_ins[max_inputs]; // amount in for that cmx                          //private
    signal input r_ins[max_inputs]; // "r" used to create that cmx                     //private
    signal input roots[max_inputs]; // root for the merkle tree that cmx present in    // private
    signal input roots_hash;                                                           // public
    signal input pathElements[max_inputs][depth]; // path elements to the root         //private 
    signal input pathIndices[max_inputs][depth]; // path indices to the root           //private

    // nullifiers 
    signal input nullifiers[max_inputs]; // private
    signal input nullifiers_hash;        // public

    signal sum[max_inputs + 1]; // sum[max_inputs] will be sum of inputs
    sum[0] <== 0;
    signal x[max_inputs];

    component comHasher[max_inputs];
    component merklePath[max_inputs];
    component nullHasher[max_inputs];
    component inputRangeChecks[max_inputs];

    for(var i = 0; i < max_inputs ; i++){
        // enable constraint
        enabled[i] * (1 - enabled[i]) === 0;

        // amount range constraint
        inputRangeChecks[i] = RangeCheck(128);
        inputRangeChecks[i].in <== a_ins[i];

        // correct way to find sum
        x[i] <== enabled[i] * a_ins[i];
        sum[i + 1] <== sum[i] + x[i];

        //input commitment computation checkup
        comHasher[i] = Poseidon(4);
        comHasher[i].inputs[0] <== 1;
        comHasher[i].inputs[1] <== a_ins[i];
        comHasher[i].inputs[2] <== r_ins[i];
        comHasher[i].inputs[3] <== pk;

        // constraint 
        enabled[i] * (comHasher[i].out - c_ins[i]) === 0;

        // merkle root validity check
        merklePath[i] = MerklePath(depth);
        merklePath[i].leaf <== c_ins[i];
        for (var j = 0; j < depth; j++){
            pathIndices[i][j] * (1 - pathIndices[i][j]) === 0;

            merklePath[i].pathElements[j] <== pathElements[i][j];
            merklePath[i].pathIndices[j] <== pathIndices[i][j];
        }

        // computed root , root equivalent constraint
        enabled[i] * (roots[i] - merklePath[i].computedRoot) === 0;

        // nullifiers checkup
        nullHasher[i] = Poseidon(4);
        nullHasher[i].inputs[0] <== 2;
        nullHasher[i].inputs[1] <== c_ins[i];
        nullHasher[i].inputs[2] <== r_ins[i];
        nullHasher[i].inputs[3] <== sk;

        enabled[i] * (nullHasher[i].out - nullifiers[i]) === 0;
    }

    // OUTPUTS VALIDATION

    // withdraw amount
    signal input withdrawAmount; // private
    signal input withdrawAmount_hash; // public

    component withdrawRangeCheck = RangeCheck(128);
    withdrawRangeCheck.in <== withdrawAmount;

    // output commitments check
    signal input out_enabled[2]; // private
    signal input out_enabled_hash; // public
    signal input a_outs[2]; // private
    signal input r_outs[2]; // private
    signal input c_outs[2]; // private
    signal input c_outs_hash; // public
    signal input receivers[2]; // private


    receivers[0] === changeReceiver;
    receivers[1] === relayer;

    signal outSum[3];
    signal y[2];
    outSum[0] <== 0;

    component outHasher[2];
    component outputRangeChecks[2];

    for(var i = 0; i < 2; i++){
        // output enabled signal
        out_enabled[i] * (1 - out_enabled[i]) === 0;

        // output amount range constraint
        outputRangeChecks[i] = RangeCheck(128);
        outputRangeChecks[i].in <== a_outs[i];

        y[i] <== out_enabled[i] * a_outs[i];
        outSum[i + 1] <== outSum[i] + y[i];

        // output commitment computation checkup
        outHasher[i] = Poseidon(4);
        outHasher[i].inputs[0] <== 1;
        outHasher[i].inputs[1] <== a_outs[i];
        outHasher[i].inputs[2] <== r_outs[i];
        outHasher[i].inputs[3] <== receivers[i];

        //constraint
        out_enabled[i] * (outHasher[i].out - c_outs[i]) === 0;
    }
 
    // Input Summation == Output Summation constraint
    sum[max_inputs] === outSum[2] + withdrawAmount;

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

    component withdrawAmountHasher = Poseidon(2);
    withdrawAmountHasher.inputs[0] <== withdrawAmount;
    withdrawAmountHasher.inputs[1] <== 0;
    withdrawAmount_hash === withdrawAmountHasher.out;

    component outEnabledHasher = Hash2();
    for (var i = 0; i < 2; i++) {
        outEnabledHasher.inputs[i] <== out_enabled[i];
    }
    out_enabled_hash === outEnabledHasher.out;

    component cOutsHasher = Hash2();
    for (var i = 0; i < 2; i++) {
        cOutsHasher.inputs[i] <== c_outs[i];
    }
    c_outs_hash === cOutsHasher.out;
}

component main {public [
    receiver,
    relayer,
    enabled_hash,
    roots_hash,
    nullifiers_hash,
    withdrawAmount_hash,
    out_enabled_hash,
    c_outs_hash
]} = WithdrawProof(4,20);