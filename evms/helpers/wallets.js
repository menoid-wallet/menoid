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
 * The user keeps their real wallet. It signs the key message once per network
 * and key index; everything else is derived from that signature:
 *
 *   seed            = keccak("menoid/v1m/seed" ‖ network ‖ signature)  master secret, never stored
 *   sk              = keccak("menoid/v1m/spend" ‖ seed) mod l          spending key (BabyJubJub)
 *   spendPk         = sk · Base8
 *   nullifierKey    = Poseidon(D_NK, sk)                               sees spends, cannot spend
 *   incomingSecret  = keccak("menoid/v1m/incoming" ‖ seed)            -> ivk per viewing epoch
 *   outgoingSecret  = keccak("menoid/v1m/outgoing" ‖ seed)            -> ovk per viewing epoch
 *   ivk_e           = keccak("menoid/v1m/ivk" ‖ incomingSecret ‖ e)    decrypts incoming notes
 *   ovk_e           = keccak("menoid/v1m/ovk" ‖ outgoingSecret ‖ e)    decrypts outgoing records
 *   userCommitment  = Poseidon(D_UC, address, spendPk.x, spendPk.y)
 *
 *   register(userCommitment, ivkPub_0)                                 on-chain, once per chain
 *
 * Mainnet and testnet keys are separate. The message names the network
 * ("Network: mainnet" / "Network: testnet") and the network is also mixed
 * into the seed, so the same wallet has unrelated keys on each: nothing
 * signed, leaked or derived on a testnet can ever spend or reveal mainnet
 * notes. There is no default network — every caller must say which one.
 *
 * Refer: notes/keys_and_registration.txt, notes/viewing_keys.txt
 */

// The key message names the network and the only origin that should ask for it.
const KEY_NETWORKS = {
    mainnet: { label: "mainnet", origin: "https://app.menoid.xyz" },
    testnet: { label: "testnet", origin: "https://testnet.menoid.xyz" }
};

// Monad, Base, Polygon, Arbitrum, Ethereum, Optimism. Every other chain —
// testnets, local nodes — uses testnet keys.
const MAINNET_CHAIN_IDS = new Set([143, 8453, 137, 42161, 1, 10]);

function keyNetworkForChainId(chainId) {
    return MAINNET_CHAIN_IDS.has(Number(chainId)) ? "mainnet" : "testnet";
}

function requireKeyNetwork(network) {
    if (!KEY_NETWORKS[network]) {
        throw new Error(`key network must be "mainnet" or "testnet" (got ${JSON.stringify(network)})`);
    }
    return KEY_NETWORKS[network];
}

function keyMessage({ network, keyIndex = 0 } = {}) {
    const { label, origin } = requireKeyNetwork(network);
    return [
        "Menoid: create my private account keys.",
        "",
        `Only sign this on ${origin}`,
        "Anyone holding this signature can spend your private balance.",
        "",
        `Network: ${label}`,
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
async function signKeyMessage(signer, { network, keyIndex = 0, checkDeterministic = true } = {}) {
    const message = keyMessage({ network, keyIndex });
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

async function deriveKeysFromSignature(address, signature, { network, keyIndex = 0, viewingEpoch = 0 } = {}) {
    requireKeyNetwork(network);
    await initCrypto();

    // the network is mixed in as well as signed: even a mainnet signature fed
    // into testnet code (or the reverse) yields unrelated keys
    const seed = keccak(["string", "string", "bytes"], [KEY_TAGS.SEED, network, signature]);

    const sk = BigInt(keccak(["string", "bytes32"], [KEY_TAGS.SPEND, seed])) % BABYJUB_SUBGROUP_ORDER;
    const spendPublicKey = babyJubPublicKey(sk);
    const nullifierKey = poseidonHash([DOMAIN.NULLIFIER_KEY, sk]);

    const incomingSecret = keccak(["string", "bytes32"], [KEY_TAGS.INCOMING, seed]);
    const outgoingSecret = keccak(["string", "bytes32"], [KEY_TAGS.OUTGOING, seed]);

    const userCommitment = userCommitmentOf(address, spendPublicKey);

    return {
        address: ethers.utils.getAddress(address),
        network,
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

// sign + derive; the returned wallet keeps the signer for sending transactions.
// network is required: "mainnet" or "testnet" (see keyNetworkForChainId)
async function deriveWallet(signer, { network, keyIndex = 0, viewingEpoch = 0, checkDeterministic = true } = {}) {
    requireKeyNetwork(network);
    const signature = await signKeyMessage(signer, { network, keyIndex, checkDeterministic });
    const address = await signer.getAddress();
    const keys = await deriveKeysFromSignature(address, signature, { network, keyIndex, viewingEpoch });
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

// key index + 1: a new spending identity on the same network
// (old notes need the old wallet to spend)
async function rotateKeys(pool, wallet, options = {}) {
    const next = await deriveWallet(wallet.signer, {
        ...options,
        network: wallet.network,
        keyIndex: wallet.keyIndex + 1,
        viewingEpoch: 0
    });
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
//
// Each carries its network: a testnet key only ever opens testnet notes.

// incoming + spends + outgoing, all epochs. Cannot spend.
function fullViewingKey(wallet) {
    return {
        kind: "full",
        address: wallet.address,
        network: wallet.network,
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
        network: wallet.network,
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
        network: wallet.network,
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
    requireKeyNetwork(key.network);
    return key;
}

module.exports = {
    KEY_NETWORKS,
    MAINNET_CHAIN_IDS,
    keyNetworkForChainId,
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
