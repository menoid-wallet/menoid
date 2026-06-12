// @ts-ignore
import { encrypt, decrypt } from "eciesjs";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const result = new Uint8Array(clean.length / 2);
  for (let i = 0; i < result.length; i++) {
    result[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encrypt a UTF-8 string to the holder of publicKey.
 * Returns a 0x-prefixed hex ciphertext.
 */
export function encryptMessage(message: string, publicKey: string): string {
  const messageBytes = encoder.encode(message);
  const publicKeyBytes = hexToBytes(publicKey);
  const encrypted = encrypt(publicKeyBytes, Buffer.from(messageBytes));
  return bytesToHex(encrypted);
}

/**
 * Decrypt a 0x-prefixed hex ciphertext using privateKey.
 * Returns the original UTF-8 plaintext.
 */
export function decryptMessage(
  ciphertextHex: string,
  privateKey: string
): string {
  const ciphertextBytes = hexToBytes(ciphertextHex);
  const privateKeyBytes = hexToBytes(privateKey);
  const decrypted = decrypt(
    Buffer.from(privateKeyBytes),
    Buffer.from(ciphertextBytes)
  );
  return decoder.decode(decrypted);
}
