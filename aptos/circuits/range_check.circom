pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/bitify.circom";

/**
 * RangeCheck(bits)
 *
 * Constrains:
 *      0 <= in < 2^bits
 *
 * Prevents:
 *      - field overflows
 *      - negative wrapped values
 *      - huge forged balances
 */

template RangeCheck(bits) {

    signal input in;

    component n2b = Num2Bits(bits);

    n2b.in <== in;
}

