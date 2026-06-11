const circomlibjs = require("circomlibjs");

const { ethers } = require("ethers");

async function createCommitment(
    amount,
    randomness,
    zkPublicKey
) {

    const poseidon =
        await circomlibjs.buildPoseidon();

    const commitmentBigInt =
        poseidon.F.toString(
            poseidon([
                1,
                amount,
                randomness,
                zkPublicKey
            ])
        );

    // solidity bytes32
    const commitmentBytes32 =
        ethers.utils.hexZeroPad(
            ethers.BigNumber
                .from(commitmentBigInt)
                .toHexString(),
            32
        );

    return {

        decimal: commitmentBigInt,

        bytes32: commitmentBytes32
    };
}

module.exports = {
    createCommitment
};