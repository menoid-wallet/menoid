pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/babyjub.circom";

/**
 * Menoid v1-mainnet note primitives.
 *
 * Keys (derived off-chain from the wallet signature, see helpers/wallets.js):
 *      spendPk         = sk * Base8                                (BabyJubJub)
 *      user_commitment = Poseidon(D_UC, walletAddress, spendPk.x, spendPk.y)
 *      nullifier_key   = Poseidon(D_NK, sk)
 *
 * Notes:
 *      npk        = Poseidon(D_NPK, owner_user_commitment, randomness)
 *      commitment = Poseidon(D_CM, token, amount, npk)
 *      nullifier  = Poseidon(D_NF, nullifier_key, commitment, randomness)
 *
 * The domain separators keep every hash in its own space. They must match
 * helpers/constants.js and NoidPool.sol (D_CM is used on-chain for deposits).
 *
 * Refer: notes/zk_proof_transfer.txt
 */

function D_UC()  { return 1; }  // user commitment
function D_NK()  { return 2; }  // nullifier key
function D_NPK() { return 3; }  // note public key
function D_CM()  { return 4; }  // note commitment
function D_NF()  { return 5; }  // nullifier


// sk -> (user commitment, nullifier key)
// Proving knowledge of sk for a user commitment is what proves ownership.
template OwnerKeys() {
    signal input sk;
    signal input ownerAddress;

    signal output userCommitment;
    signal output nullifierKey;

    component spendPk = BabyPbk();
    spendPk.in <== sk;

    component ucHasher = Poseidon(4);
    ucHasher.inputs[0] <== D_UC();
    ucHasher.inputs[1] <== ownerAddress;
    ucHasher.inputs[2] <== spendPk.Ax;
    ucHasher.inputs[3] <== spendPk.Ay;
    userCommitment <== ucHasher.out;

    // one-way: whoever holds nk can recognise spends, but cannot recover sk
    component nkHasher = Poseidon(2);
    nkHasher.inputs[0] <== D_NK();
    nkHasher.inputs[1] <== sk;
    nullifierKey <== nkHasher.out;
}


// (token, amount, owner, randomness) -> commitment
// The token is a private field inside the hash: this is the hidden token pointer.
template NoteCommitment() {
    signal input token;
    signal input amount;
    signal input owner;       // owner's user commitment
    signal input randomness;

    signal output commitment;

    // npk hides the owner behind fresh randomness
    component npkHasher = Poseidon(3);
    npkHasher.inputs[0] <== D_NPK();
    npkHasher.inputs[1] <== owner;
    npkHasher.inputs[2] <== randomness;

    component cmHasher = Poseidon(4);
    cmHasher.inputs[0] <== D_CM();
    cmHasher.inputs[1] <== token;
    cmHasher.inputs[2] <== amount;
    cmHasher.inputs[3] <== npkHasher.out;
    commitment <== cmHasher.out;
}


// (nk, commitment, randomness) -> nullifier
// randomness is included so that holding nk alone is not enough to test
// arbitrary on-chain commitments: you must also be able to open the note.
template NoteNullifier() {
    signal input nullifierKey;
    signal input commitment;
    signal input randomness;

    signal output nullifier;

    component hasher = Poseidon(4);
    hasher.inputs[0] <== D_NF();
    hasher.inputs[1] <== nullifierKey;
    hasher.inputs[2] <== commitment;
    hasher.inputs[3] <== randomness;
    nullifier <== hasher.out;
}
