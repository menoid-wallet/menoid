const circomlibjs = require("circomlibjs");

/**
 * Poseidon + BabyJubJub, the same implementations the circuits use.
 * circomlibjs builds them asynchronously once; call initCrypto() before
 * using the synchronous helpers.
 */

let poseidon = null;
let babyJub = null;

async function initCrypto() {
    if (!poseidon) poseidon = await circomlibjs.buildPoseidon();
    if (!babyJub) babyJub = await circomlibjs.buildBabyjub();
}

function requireReady() {
    if (!poseidon || !babyJub) {
        throw new Error("crypto not initialised: await initCrypto() first");
    }
}

// Poseidon over field elements -> BigInt
function poseidonHash(inputs) {
    requireReady();
    return BigInt(poseidon.F.toString(poseidon(inputs.map((x) => BigInt(x)))));
}

// spendPk = sk * Base8
function babyJubPublicKey(sk) {
    requireReady();
    const point = babyJub.mulPointEscalar(babyJub.Base8, BigInt(sk));
    return {
        x: BigInt(babyJub.F.toString(point[0])),
        y: BigInt(babyJub.F.toString(point[1]))
    };
}

module.exports = {
    initCrypto,
    poseidonHash,
    babyJubPublicKey
};
