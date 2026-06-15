import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import * as crypto from "crypto";
// @ts-ignore
import nacl from "tweetnacl";

const P = (1n << 255n) - 19n;

function modInverse(e: bigint): bigint {
  return expMod(e, P - 2n, P);
}

function expMod(base: bigint, exp: bigint, mod: bigint): bigint {
  let res = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e % 2n === 1n) res = (res * b) % mod;
    b = (b * b) % mod;
    e /= 2n;
  }
  return res;
}

/**
 * Converts a 32-byte Ed25519 public key to Montgomery Curve25519 public key.
 */
export function ed25519PubkeyToCurve25519(ed25519Pub: Uint8Array): Uint8Array {
  const yBytes = new Uint8Array(ed25519Pub);
  // Clear the most significant bit of the last byte to get y
  yBytes[31] &= 0x7f;
  
  // Convert y bytes (little-endian) to BigInt
  let y = 0n;
  for (let i = 31; i >= 0; i--) {
    y = (y << 8n) + BigInt(yBytes[i]);
  }
  
  // u = (1 + y) * inv(1 - y) mod P
  const num = (1n + y) % P;
  const den = (1n - y + P) % P;
  const u = (num * modInverse(den)) % P;
  
  // Convert u to 32 bytes little-endian
  const uBytes = new Uint8Array(32);
  let temp = u;
  for (let i = 0; i < 32; i++) {
    uBytes[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return uBytes;
}

/**
 * Converts Ed25519 private key seed (or 64-byte secret key) to Curve25519 private key.
 */
export function ed25519SecretKeyToCurve25519(ed25519Sec: Uint8Array): Uint8Array {
  const seed = ed25519Sec.length === 64 ? ed25519Sec.slice(0, 32) : ed25519Sec;
  const hash = crypto.createHash("sha512").update(seed).digest();
  const curveSec = new Uint8Array(hash.slice(0, 32));
  curveSec[0] &= 248;
  curveSec[31] &= 127;
  curveSec[31] |= 64;
  return curveSec;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encrypt a UTF-8 string to the holder of Ed25519 publicKey.
 * Returns a 0x-prefixed hex ciphertext.
 */
export function encryptMessage(message: string, publicKeyBase64: string): string {
  const edPub = Uint8Array.from(Buffer.from(publicKeyBase64, "base64"));
  const recipientCurvePub = ed25519PubkeyToCurve25519(edPub);
  
  // Generate ephemeral Curve25519 keypair
  const ephemeralKeypair = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  
  const msgBytes = encoder.encode(message);
  const encrypted = nacl.box(
    msgBytes,
    nonce,
    recipientCurvePub,
    ephemeralKeypair.secretKey
  );
  
  // ciphertext = ephemeralPublic (32 bytes) + nonce (24 bytes) + encrypted
  const result = new Uint8Array(32 + 24 + encrypted.length);
  result.set(ephemeralKeypair.publicKey, 0);
  result.set(nonce, 32);
  result.set(encrypted, 32 + 24);
  
  return "0x" + Buffer.from(result).toString("hex");
}

/**
 * Decrypt a 0x-prefixed hex ciphertext using Bech32 Ed25519 suiprivkey.
 * Returns the original UTF-8 plaintext.
 */
export function decryptMessage(ciphertextHex: string, secretKeyBech32: string): string {
  const cleanHex = ciphertextHex.startsWith("0x") ? ciphertextHex.slice(2) : ciphertextHex;
  const ciphertext = Uint8Array.from(Buffer.from(cleanHex, "hex"));
  
  const decoded = decodeSuiPrivateKey(secretKeyBech32);
  const recipientCurveSec = ed25519SecretKeyToCurve25519(decoded.secretKey);
  
  const ephemeralPub = ciphertext.slice(0, 32);
  const nonce = ciphertext.slice(32, 56);
  const encrypted = ciphertext.slice(56);
  
  const decrypted = nacl.box.open(
    encrypted,
    nonce,
    ephemeralPub,
    recipientCurveSec
  );
  if (!decrypted) {
    throw new Error("Failed to decrypt message (nacl.box.open returned null)");
  }
  return decoder.decode(decrypted);
}