const { ethers } = require("ethers");
const circomlibjs = require("circomlibjs");

/**
 * Menoid wallet keys
 *
 * There is NO derived wallet anymore. The user keeps their real wallet
 * address. The real wallet signs REGISTRATION_MESSAGE once and from that
 * signature we derive:
 *
 *   - spending keypair (BabyJubJub):  sk, pk = sk * Base8
 *   - encryption keypair (secp256k1): used only for encrypting/decrypting
 *     notes off-chain, never used as an on-chain account
 *
 * The user representation on-chain is:
 *
 *   userCommitment = Poseidon(walletAddress, spendPk.x, spendPk.y)
 *
 * which is registered once via NoidPool.register(userCommitment).
 */

const REGISTRATION_MESSAGE = "menoid_Wallet";

// BabyJubJub prime subgroup order (l)
const BABYJUB_SUBGROUP_ORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;

let babyJubPromise = null;
let poseidonPromise = null;

function getBabyJub() {
    if (!babyJubPromise) {
        babyJubPromise = circomlibjs.buildBabyjub();
    }
    return babyJubPromise;
}

function getPoseidon() {
    if (!poseidonPromise) {
        poseidonPromise = circomlibjs.buildPoseidon();
    }
    return poseidonPromise;
}

// derive spending + encryption keys from the real wallet's signature
async function deriveNoidKeys(signature) {

    const babyJub = await getBabyJub();

    // spending private key (BabyJubJub scalar)
    const spendPrivateKey =
        BigInt(
            ethers.utils.solidityKeccak256(
                ["string", "bytes"],
                ["menoid/spend", signature]
            )
        ) % BABYJUB_SUBGROUP_ORDER;

    // spending public key = sk * Base8
    const pkPoint =
        babyJub.mulPointEscalar(
            babyJub.Base8,
            spendPrivateKey
        );

    const spendPublicKey = {
        x: babyJub.F.toString(pkPoint[0]),
        y: babyJub.F.toString(pkPoint[1])
    };

    // encryption keypair (only for note encryption, never an account)
    const encPrivateKey =
        ethers.utils.solidityKeccak256(
            ["string", "bytes"],
            ["menoid/encryption", signature]
        );

    const encPublicKey =
        new ethers.utils.SigningKey(encPrivateKey).publicKey;

    return {

        spend: {
            privateKey: spendPrivateKey.toString(),
            publicKey: spendPublicKey
        },

        encryption: {
            privateKey: encPrivateKey,
            publicKey: encPublicKey
        }
    };
}

// userCommitment = Poseidon(walletAddress, spendPk.x, spendPk.y)
async function computeUserCommitment(walletAddress, spendPublicKey) {

    const poseidon = await getPoseidon();

    const decimal =
        poseidon.F.toString(
            poseidon([
                ethers.BigNumber.from(walletAddress).toString(),
                spendPublicKey.x,
                spendPublicKey.y
            ])
        );

    const bytes32 =
        ethers.utils.hexZeroPad(
            ethers.BigNumber.from(decimal).toHexString(),
            32
        );

    return { decimal, bytes32 };
}

// derive the full off-chain wallet state for a signer (no registration)
async function deriveWallet(signer) {

    const signature =
        await signer.signMessage(REGISTRATION_MESSAGE);

    const keys =
        await deriveNoidKeys(signature);

    const address =
        await signer.getAddress();

    const userCommitment =
        await computeUserCommitment(
            address,
            keys.spend.publicKey
        );

    return {
        signer,
        address,
        spend: keys.spend,
        encryption: keys.encryption,
        userCommitment
    };
}

/**
 * register_wallet(walletAddress, signature)
 *
 * - derive the BabyJubJub spending keypair from the signature
 * - userCommitment = Poseidon(walletAddress, spendPk.x, spendPk.y)
 * - call the on-chain register(userCommitment) from the real wallet
 *
 * Throws if the wallet is already registered.
 */
async function registerWallet(signer, pool) {

    const wallet =
        await deriveWallet(signer);

    const tx =
        await pool
            .connect(signer)
            .register(wallet.userCommitment.bytes32);

    await tx.wait();

    return wallet;
}

module.exports = {
    REGISTRATION_MESSAGE,
    BABYJUB_SUBGROUP_ORDER,
    deriveNoidKeys,
    computeUserCommitment,
    deriveWallet,
    registerWallet
};
