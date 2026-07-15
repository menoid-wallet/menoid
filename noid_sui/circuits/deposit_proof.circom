pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "./range_check.circom";

/**
 * Deposit
 *
 * Proves that deposited amount equals
 * the sum of committed note values.
 *
 * Notes are locked to user commitments:
 *      user_commitment = Poseidon(walletAddress, spendPk.x, spendPk.y)
 *      commitment      = Poseidon(1, amount, randomness, user_commitment)
 *
 * c2 is the optional relayer fee note. When c2_enabled == 0
 * the second commitment is skipped and the full deposit goes to c1.
 *
 * To understand the circuit
 *      Refer: notes/zk_proof_depoist.txt
 */


template DepositProof() {
    //public signals
    signal input depositAmount;
    signal input c1;
    signal input c2;
    signal input c2_enabled; // 1 -> relayer fee note present, 0 -> c2 unused
    signal input uc2;        // relayer user commitment (public input)

    //private inputs
    //for 1st commitment
    signal input a1;    // amount of 1st commitment
    signal input r1;    // randomness of 1st commitment
    signal input uc1;   // receiver user commitment of 1st commitment

    // for 2nd commitment (relayer fee)
    signal input a2;
    signal input r2;

    // enabled flag constraint
    c2_enabled * (1 - c2_enabled) === 0;

    // amount range constraints
    // depositAmount === a1 + fee is a field equation. Without a bound on the
    // amounts it is satisfiable by wrapping around the prime (pick a huge a1,
    // then a2 = depositAmount - a1 mod p), which mints a note of arbitrary
    // value from a dust deposit. Bounding both to 128 bits keeps a1 + fee far
    // below the prime, so the equation holds over the integers.
    // 128 matches the bound transfer/withdraw enforce on the same amounts.
    component a1Range = RangeCheck(128);
    a1Range.in <== a1;

    component a2Range = RangeCheck(128);
    a2Range.in <== a2;

    component hasher1 = Poseidon(4);
    hasher1.inputs[0] <== 1; //<--- domain seperator
    hasher1.inputs[1] <== a1;
    hasher1.inputs[2] <== r1;
    hasher1.inputs[3] <== uc1;

    c1 === hasher1.out;

    component hasher2 = Poseidon(4);
    hasher2.inputs[0] <== 1; //<--- domain seperator
    hasher2.inputs[1] <== a2;
    hasher2.inputs[2] <== r2;
    hasher2.inputs[3] <== uc2;

    c2_enabled * (c2 - hasher2.out) === 0;

    // when the fee note is disabled its amount must not count
    signal fee;
    fee <== c2_enabled * a2;

    depositAmount === a1 + fee; // sum of amounts must be equal to deposit
}

component main {public [depositAmount, c1, c2, c2_enabled, uc2]} = DepositProof();
