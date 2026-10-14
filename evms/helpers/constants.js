const { ethers } = require("ethers");

/**
 * Protocol constants for Menoid v1-mainnet (EVM).
 * Anything here that also lives in a circuit or contract must match it exactly.
 */

// BN254 scalar field — every circuit value lives below it
const FIELD_SIZE =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// BabyJubJub prime subgroup order (l) — the spending key is reduced mod l
const BABYJUB_SUBGROUP_ORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// secp256k1 group order (n) — viewing private keys must be in [1, n-1]
const SECP256K1_ORDER =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// Poseidon domain separators — circuits/note_lib.circom, NoidPool.sol (D_CM)
const DOMAIN = {
    USER_COMMITMENT: 1n,
    NULLIFIER_KEY: 2n,
    NOTE_PUBLIC_KEY: 3n,
    COMMITMENT: 4n,
    NULLIFIER: 5n
};

// keccak tags for key derivation (helpers/wallets.js)
const KEY_TAGS = {
    SEED: "menoid/v1m/seed",
    SPEND: "menoid/v1m/spend",
    INCOMING: "menoid/v1m/incoming",
    OUTGOING: "menoid/v1m/outgoing",
    IVK: "menoid/v1m/ivk",
    OVK: "menoid/v1m/ovk"
};

// ext data domains — NoidPool.TRANSFER_EXT_DOMAIN / WITHDRAW_EXT_DOMAIN / SWAP_EXT_DOMAIN
const EXT_DOMAIN = {
    TRANSFER: ethers.utils.id("menoid.v1m.transfer"),
    WITHDRAW: ethers.utils.id("menoid.v1m.withdraw"),
    SWAP: ethers.utils.id("menoid.v1m.swap")
};

// spend shape — contracts/libraries/Types.sol and the circuits
const TREE_DEPTH = 20;
const CHUNK_SIZE = 4;
const N_INS = 4;
const TRANSFER_OUTS = 3;
const WITHDRAW_OUTS = 2;

const MAX_AMOUNT = (1n << 128n) - 1n;

module.exports = {
    FIELD_SIZE,
    BABYJUB_SUBGROUP_ORDER,
    SECP256K1_ORDER,
    DOMAIN,
    KEY_TAGS,
    EXT_DOMAIN,
    TREE_DEPTH,
    CHUNK_SIZE,
    N_INS,
    TRANSFER_OUTS,
    WITHDRAW_OUTS,
    MAX_AMOUNT
};
