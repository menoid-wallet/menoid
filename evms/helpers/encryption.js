const crypto = require("crypto");
const { ethers } = require("ethers");
const { encrypt, decrypt, ECIES_CONFIG } = require("eciesjs");

const { toBytes32 } = require("./commitments");

/**
 * Two kinds of ciphertext travel with every pool transaction.
 *
 * 1. Encrypted notes — ECIES to the owner's viewing public key (ivkPub).
 *    Anyone with the matching ivk can open them.
 *
 *      plaintext (70 B) = version(1) | flags(1) | token(20) | amount(16) | randomness(32)
 *      ciphertext       = ephemeralPk(33, compressed) | nonce(16) | tag(16) | encrypted plaintext
 *
 * 2. Outgoing records — the SENDER's own record of a spend, for their
 *    outgoing viewing key (ovk). The key is derived from the spend's first
 *    nullifier, so a viewer who knows the nullifier opens it directly.
 *
 *      key        = HKDF-SHA256(ikm = ovk, salt = firstNullifier, info = "menoid/v1m/outgoing-record")
 *      record     = nonce(12) | AES-256-GCM(key, nonce, plaintext) | tag(16)
 *      plaintext  = version(1) | action(1) | token(20) | amount(16) | fee(16)
 *                   | counterpartyAddress(20) | counterpartyUserCommitment(32) | counterpartyNoteRandomness(32)
 *
 *    The nonce is random: a reverted spend that is retried reuses its first
 *    nullifier (so the key), and a fixed nonce would then repeat.
 *
 * Both are standard primitives (HKDF and AES-GCM are in WebCrypto), so the
 * website can implement them without this file.
 */

// protocol constant: both sides must agree on the ephemeral key encoding
ECIES_CONFIG.isEphemeralKeyCompressed = true;

const NOTE_VERSION = 1;
const NOTE_PLAINTEXT_SIZE = 70;

const OUTGOING_VERSION = 1;
const OUTGOING_PLAINTEXT_SIZE = 138;
const OUTGOING_INFO = Buffer.from("menoid/v1m/outgoing-record", "utf8");

const ACTION = { TRANSFER: 1, WITHDRAW: 2 };

const hexToBuf = (hex) => Buffer.from(hex.replace(/^0x/, ""), "hex");
const bufToHex = (buf) => "0x" + Buffer.from(buf).toString("hex");

function writeUint(buf, offset, size, value) {
    const hex = BigInt(value).toString(16).padStart(size * 2, "0");
    if (hex.length > size * 2) throw new Error(`value does not fit in ${size} bytes`);
    Buffer.from(hex, "hex").copy(buf, offset);
}

const readUint = (buf, offset, size) => BigInt("0x" + buf.subarray(offset, offset + size).toString("hex"));
const writeAddress = (buf, offset, address) => hexToBuf(ethers.utils.getAddress(address)).copy(buf, offset);
const readAddress = (buf, offset) => ethers.utils.getAddress(bufToHex(buf.subarray(offset, offset + 20)));

// ─── encrypted notes ────────────────────────────────────────────────────────

function encodeNote({ token, amount, randomness, flags = 0 }) {
    const buf = Buffer.alloc(NOTE_PLAINTEXT_SIZE);
    buf[0] = NOTE_VERSION;
    buf[1] = flags;
    writeAddress(buf, 2, token);
    writeUint(buf, 22, 16, amount);
    writeUint(buf, 38, 32, randomness);
    return buf;
}

function decodeNote(buf) {
    if (buf.length !== NOTE_PLAINTEXT_SIZE || buf[0] !== NOTE_VERSION) throw new Error("Unknown note format");
    return {
        flags: buf[1],
        token: readAddress(buf, 2),
        amount: readUint(buf, 22, 16),
        randomness: readUint(buf, 38, 32)
    };
}

function encryptNote(viewingPublicKey, note) {
    return bufToHex(encrypt(hexToBuf(viewingPublicKey), encodeNote(note)));
}

// trial decryption: null means "not encrypted to this key"
function tryDecryptNote(ivk, ciphertext) {
    try {
        return decodeNote(Buffer.from(decrypt(hexToBuf(ivk), hexToBuf(ciphertext))));
    } catch {
        return null;
    }
}

// ─── outgoing records ───────────────────────────────────────────────────────

function outgoingKey(ovk, firstNullifier) {
    return Buffer.from(crypto.hkdfSync("sha256", hexToBuf(ovk), hexToBuf(toBytes32(firstNullifier)), OUTGOING_INFO, 32));
}

function encodeOutgoingRecord(record) {
    const buf = Buffer.alloc(OUTGOING_PLAINTEXT_SIZE);
    buf[0] = OUTGOING_VERSION;
    buf[1] = record.action;
    writeAddress(buf, 2, record.token);
    writeUint(buf, 22, 16, record.amount);
    writeUint(buf, 38, 16, record.fee);
    writeAddress(buf, 54, record.counterpartyAddress);
    writeUint(buf, 74, 32, record.counterpartyUserCommitment ?? 0n);
    writeUint(buf, 106, 32, record.counterpartyNoteRandomness ?? 0n);
    return buf;
}

function decodeOutgoingRecord(buf) {
    if (buf.length !== OUTGOING_PLAINTEXT_SIZE || buf[0] !== OUTGOING_VERSION) throw new Error("Unknown record format");
    return {
        action: buf[1],
        token: readAddress(buf, 2),
        amount: readUint(buf, 22, 16),
        fee: readUint(buf, 38, 16),
        counterpartyAddress: readAddress(buf, 54),
        counterpartyUserCommitment: readUint(buf, 74, 32),
        counterpartyNoteRandomness: readUint(buf, 106, 32)
    };
}

function encryptOutgoingRecord(ovk, firstNullifier, record) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", outgoingKey(ovk, firstNullifier), nonce);
    const body = Buffer.concat([cipher.update(encodeOutgoingRecord(record)), cipher.final()]);
    return bufToHex(Buffer.concat([nonce, body, cipher.getAuthTag()]));
}

function tryDecryptOutgoingRecord(ovk, firstNullifier, recordHex) {
    try {
        const raw = hexToBuf(recordHex);
        const nonce = raw.subarray(0, 12);
        const tag = raw.subarray(raw.length - 16);
        const body = raw.subarray(12, raw.length - 16);
        const decipher = crypto.createDecipheriv("aes-256-gcm", outgoingKey(ovk, firstNullifier), nonce);
        decipher.setAuthTag(tag);
        return decodeOutgoingRecord(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
        return null;
    }
}

module.exports = {
    ACTION,
    encodeNote,
    decodeNote,
    encryptNote,
    tryDecryptNote,
    encryptOutgoingRecord,
    tryDecryptOutgoingRecord
};
