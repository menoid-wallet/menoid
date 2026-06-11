pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

/**
 * Deposit
 *
 * Proves that deposited amount equals
 * the sum of committed note values.
 *
 * To understand the circuit
 *      Refer: notes/zk_proof_depoist.txt 
 */


template DepositProof() {
    //public signals
    signal input depositAmount;
    signal input c1;
    signal input c2;

    //private inputs
    //for 1st commitment
    signal input a1;    // amount of 1st commitment
    signal input r1;    // randomness of 1st commitment
    signal input pk1;   // receiver pubkey of 1st commitment

    // for 2nd commitment
    signal input a2;     
    signal input r2;
    signal input pk2; // public input (relayer)

    component hasher1 = Poseidon(4);
    hasher1.inputs[0] <== 1; //<--- domain seperator
    hasher1.inputs[1] <== a1;
    hasher1.inputs[2] <== r1;
    hasher1.inputs[3] <== pk1;

    c1 === hasher1.out;

    component hasher2 = Poseidon(4);
    hasher2.inputs[0] <== 1; //<--- domain seperator
    hasher2.inputs[1] <== a2;
    hasher2.inputs[2] <== r2;
    hasher2.inputs[3] <== pk2;

    c2 === hasher2.out;

    depositAmount === a1 + a2; // sum of amounts must be equal to deposit
}

component main {public [depositAmount, c1 , c2, pk2]} = DepositProof();