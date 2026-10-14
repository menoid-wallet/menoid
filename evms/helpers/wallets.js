const { ethers } = require("ethers");

const { initCrypto, poseidonHash, babyJubPublicKey } = require("./poseidon");
const {
    DOMAIN,
    KEY_TAGS,
    BABYJUB_SUBGROUP_ORDER,
    SECP256K1_ORDER
} = require("./constants");

/**
 * Menoid v1-mainnet key system.
 *
 * The user keeps their real wallet. It signs the key message once per key
 * index; everything else is derived from that signature:
 *
 *   seed            = keccak("menoid/v1m/seed" ‖ signature)          master secret, never stored
 *   sk              = keccak("menoid/v1m/spend" ‖ seed) mod l          spending key (BabyJubJub)
 *   spendPk         = sk · Base8
 *   nullifierKey    = Poseidon(D_NK, sk)                               sees spends, cannot spend
 *   incomingSecret  = keccak("menoid/v1m/incoming" ‖ seed)            -> ivk per viewing epoch
 *   outgoingSecret  = keccak("menoid/v1m/outgoing" ‖ seed)            -> ovk per viewing epoch
 *   ivk_e           = keccak("menoid/v1m/ivk" ‖ incomingSecret ‖ e)    decrypts incoming notes
 *   ovk_e           = keccak("menoid/v1m/ovk" ‖ outgoingSecret ‖ e)    decrypts outgoing records
 *   userCommitment  = Poseidon(D_UC, address, spendPk.x, spendPk.y)
 *
 *   register(userCommitment, ivkPub_0)                                 on-chain, once
 *
 * Refer: notes/keys_and_registration.txt, notes/viewing_keys.txt
 */

// The origin the key message names. Signing it anywhere else gives the keys away.
const APP_ORIGIN = "https://app.menoid.xyz";

function keyMessage(keyIndex = 0) {
    return [
        "Menoid v1-mainnet: create my private account keys.",
        "",
        `Only sign this on ${APP_ORIGIN}`,
        "Anyone holding this signature can spend your private balance.",
        "",
        `Key index: ${keyIndex}`
    ].join("\n");
}

const keccak = (types, values) => ethers.utils.solidityKeccak256(types, values);
const toHex32 = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");

/**
 * Sign the key message. Keys are only recoverable if the wallet produces the
 * same signature every time (RFC 6979). Smart-contract, passkey and some MPC
 * wallets do not, so the signature is requested twice and compared.
 */
async function signKeyMessage(signer, keyIndex = 0, { checkDeterministic = true } = {}) {
    const message = keyMessage(keyIndex);
    const signature = await signer.signMessage(message);

    if (checkDeterministic) {
        const again = await signer.signMessage(message);
        if (again.toLowerCase() !== signature.toLowerCase()) {
            throw new Error(
                "This wallet does not sign deterministically (smart-contract, passkey or MPC wallet). " +
                "Private mode needs a wallet that gives the same signature every time."
            );
        }
    }
    return signature;
}

// incoming viewing key for one epoch: a secp256k1 key pair, ivkPub goes on-chain
function deriveIncomingViewingKey(incomingSecret, epoch) {
    const ivkHash = BigInt(keccak(["string", "bytes32", "uint32"], [KEY_TAGS.IVK, incomingSecret, epoch]));
    // map into [1, n-1] so it is always a valid secp256k1 private key
    const ivk = toHex32((ivkHash % (SECP256K1_ORDER - 1n)) + 1n);
    const ivkPub = new ethers.utils.SigningKey(ivk).publicKey;   // 0x04 ‖ X ‖ Y (65 bytes)
    return { ivk, ivkPub };
}

// outgoing viewing key for one epoch: a 32-byte symmetric secret
function deriveOutgoingViewingKey(outgoingSecret, epoch) {
    return keccak(["string", "bytes32", "uint32"], [KEY_TAGS.OVK, outgoingSecret, epoch]);
}

function deriveViewingKeys(incomingSecret, outgoingSecret, epoch) {
    return {
        epoch,
        ...deriveIncomingViewingKey(incomingSecret, epoch),
        ovk: deriveOutgoingViewingKey(outgoingSecret, epoch)
    };
}

function userCommitmentOf(address, spendPublicKey) {
    return poseidonHash([
        DOMAIN.USER_COMMITMENT,
        BigInt(address),
        spendPublicKey.x,
        spendPublicKey.y
    ]);
}

async function deriveKeysFromSignature(address, signature, { keyIndex = 0, viewingEpoch = 0 } = {}) {
    await initCrypto();

    const seed = keccak(["string", "bytes"], [KEY_TAGS.SEED, signature]);

    const sk = BigInt(keccak(["string", "bytes32"], [KEY_TAGS.SPEND, seed])) % BABYJUB_SUBGROUP_ORDER;
    const spendPublicKey = babyJubPublicKey(sk);
    const nullifierKey = poseidonHash([DOMAIN.NULLIFIER_KEY, sk]);

    const incomingSecret = keccak(["string", "bytes32"], [KEY_TAGS.INCOMING, seed]);
    const outgoingSecret = keccak(["string", "bytes32"], [KEY_TAGS.OUTGOING, seed]);

    const userCommitment = userCommitmentOf(address, spendPublicKey);

    return {
        address: ethers.utils.getAddress(address),
        keyIndex,
        viewingEpoch,
        spend: { sk, publicKey: spendPublicKey },
        nullifierKey,
        incomingSecret,
        outgoingSecret,
        viewing: deriveViewingKeys(incomingSecret, outgoingSecret, viewingEpoch),
        userCommitment,
        userCommitmentBytes32: toHex32(userCommitment)
    };
}

// sign + derive; the returned wallet keeps the signer for sending transactions
async function deriveWallet(signer, { keyIndex = 0, viewingEpoch = 0, checkDeterministic = true } = {}) {
    const signature = await signKeyMessage(signer, keyIndex, { checkDeterministic });
    const address = await signer.getAddress();
    const keys = await deriveKeysFromSignature(address, signature, { keyIndex, viewingEpoch });
    return { ...keys, signer };
}

// same identity, different viewing epoch
function withViewingEpoch(wallet, viewingEpoch) {
    return {
        ...wallet,
        viewingEpoch,
        viewing: deriveViewingKeys(wallet.incomingSecret, wallet.outgoingSecret, viewingEpoch)
    };
}

// ─── on-chain registration ──────────────────────────────────────────────────

async function registerWallet(pool, wallet) {
    const tx = await pool
        .connect(wallet.signer)
        .register(wallet.userCommitmentBytes32, wallet.viewing.ivkPub);
    return tx.wait();
}

// viewing epoch + 1: future notes are encrypted to a new key
async function updateViewingKey(pool, wallet) {
    const next = withViewingEpoch(wallet, wallet.viewingEpoch + 1);
    const tx = await pool.connect(wallet.signer).updateViewingKey(next.viewing.ivkPub);
    await tx.wait();
    return next;
}

// key index + 1: a new spending identity (old notes need the old wallet to spend)
async function rotateKeys(pool, wallet, options = {}) {
    const next = await deriveWallet(wallet.signer, { ...options, keyIndex: wallet.keyIndex + 1, viewingEpoch: 0 });
    const tx = await pool
        .connect(wallet.signer)
        .rotateKeys(next.userCommitmentBytes32, next.viewing.ivkPub);
    await tx.wait();
    return next;
}

// what a sender reads before paying an address
async function resolveRecipient(pool, address) {
    const [userCommitment, viewingPublicKey, keyIndex, viewingEpoch] = await pool.registrationOf(address);
    const uc = BigInt(userCommitment);
    return {
        address: ethers.utils.getAddress(address),
        registered: uc !== 0n,
        userCommitment: uc,
        viewingPublicKey,
        keyIndex,
        viewingEpoch
    };
}

/**
 * Login check: the identity derived from this signature must be the one the
 * chain has for this address. A mismatch means a different key index or a
 * non-deterministic signer, and the wallet must stop rather than act on it.
 */
async function assertRegisteredIdentity(pool, wallet) {
    const onChain = await resolveRecipient(pool, wallet.address);
    if (!onChain.registered) throw new Error("Address is not registered");
    if (onChain.userCommitment !== wallet.userCommitment || onChain.keyIndex !== wallet.keyIndex) {
        throw new Error("Derived identity does not match the on-chain registration");
    }
    return onChain;
}

// ─── viewing keys you can hand to someone else ──────────────────────────────

// incoming + spends + outgoing, all epochs. Cannot spend.
function fullViewingKey(wallet) {
    return {
        kind: "full",
        address: wallet.address,
        keyIndex: wallet.keyIndex,
        userCommitment: wallet.userCommitment,
        incomingSecret: wallet.incomingSecret,
        outgoingSecret: wallet.outgoingSecret,
        nullifierKey: wallet.nullifierKey
    };
}

// incoming notes only, all epochs. No spend status, no outgoing.
function incomingViewingKey(wallet) {
    return {
        kind: "incoming",
        address: wallet.address,
        keyIndex: wallet.keyIndex,
        userCommitment: wallet.userCommitment,
        incomingSecret: wallet.incomingSecret
    };
}

// everything, but only for one viewing epoch
function epochViewingKey(wallet, epoch) {
    const { ivk, ovk } = deriveViewingKeys(wallet.incomingSecret, wallet.outgoingSecret, epoch);
    return {
        kind: "epoch",
        address: wallet.address,
        keyIndex: wallet.keyIndex,
        userCommitment: wallet.userCommitment,
        epoch,
        ivk,
        ovk,
        nullifierKey: wallet.nullifierKey
    };
}

/**
 * String form: "menoid-vk1:<base64url(json)>.<checksum>"
 * checksum = first 4 bytes of keccak256(payload), so a mistyped key fails
 * loudly instead of scanning with garbage.
 */
const VIEWING_KEY_PREFIX = "menoid-vk1:";

function encodeViewingKey(viewingKey) {
    const json = JSON.stringify(viewingKey, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const payload = Buffer.from(json, "utf8").toString("base64url");
    const checksum = ethers.utils.id(payload).slice(2, 10);
    return `${VIEWING_KEY_PREFIX}${payload}.${checksum}`;
}

function decodeViewingKey(encoded) {
    if (!encoded.startsWith(VIEWING_KEY_PREFIX)) throw new Error("Not a Menoid viewing key");
    const [payload, checksum] = encoded.slice(VIEWING_KEY_PREFIX.length).split(".");
    if (ethers.utils.id(payload).slice(2, 10) !== checksum) throw new Error("Viewing key checksum mismatch");

    const key = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    key.userCommitment = BigInt(key.userCommitment);
    if (key.nullifierKey !== undefined) key.nullifierKey = BigInt(key.nullifierKey);
    if (!["full", "incoming", "epoch"].includes(key.kind)) throw new Error(`Unknown viewing key kind: ${key.kind}`);
    return key;
}

module.exports = {
    APP_ORIGIN,
    keyMessage,
    signKeyMessage,
    deriveKeysFromSignature,
    deriveIncomingViewingKey,
    deriveOutgoingViewingKey,
    deriveViewingKeys,
    deriveWallet,
    withViewingEpoch,
    userCommitmentOf,
    registerWallet,
    updateViewingKey,
    rotateKeys,
    resolveRecipient,
    assertRegisteredIdentity,
    fullViewingKey,
    incomingViewingKey,
    epochViewingKey,
    encodeViewingKey,
    decodeViewingKey
};
