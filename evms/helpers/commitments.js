const { ethers } = require("ethers");

const { poseidonHash } = require("./poseidon");
const { DOMAIN } = require("./constants");

/**
 * Notes (v1-mainnet):
 *
 *   npk        = Poseidon(D_NPK, ownerUserCommitment, randomness)   hides the owner
 *   commitment = Poseidon(D_CM, token, amount, npk)                 what the chain stores
 *   nullifier  = Poseidon(D_NF, nullifierKey, commitment, randomness)  published when spent
 *
 * The token is the ERC-20 address as a field element. The native coin is
 * always the wrapped native token (deposits wrap it).
 */

const toBytes32 = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");

// 31 random bytes: always below the field size
function randomFieldElement() {
    return BigInt(ethers.utils.hexlify(ethers.utils.randomBytes(31)));
}

function tokenField(token) {
    return BigInt(ethers.utils.getAddress(token));
}

function notePublicKey(ownerUserCommitment, randomness) {
    return poseidonHash([DOMAIN.NOTE_PUBLIC_KEY, ownerUserCommitment, randomness]);
}

function noteCommitment(token, amount, npk) {
    return poseidonHash([DOMAIN.COMMITMENT, tokenField(token), BigInt(amount), npk]);
}

function noteNullifier(nullifierKey, commitment, randomness) {
    return poseidonHash([DOMAIN.NULLIFIER, nullifierKey, commitment, randomness]);
}

// a fresh note for `owner` (a user commitment)
function createNote({ token, amount, owner, randomness = randomFieldElement() }) {
    const npk = notePublicKey(owner, randomness);
    return {
        token: ethers.utils.getAddress(token),
        amount: BigInt(amount),
        owner: BigInt(owner),
        randomness: BigInt(randomness),
        npk,
        commitment: noteCommitment(token, amount, npk)
    };
}

module.exports = {
    toBytes32,
    randomFieldElement,
    tokenField,
    notePublicKey,
    noteCommitment,
    noteNullifier,
    createNote
};
