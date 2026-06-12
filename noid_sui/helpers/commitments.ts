/**
 * helpers/commitments.ts
 *
 * Poseidon commitment helper.
 * Direct TypeScript port of the Ethereum helpers/commitments.js.
 *
 * commitment = Poseidon(1, amount, randomness, zkPublicKey)
 *
 * Returns both:
 *   decimal  — plain BigInt string (what Move / circom consume)
 *   bytes32  — 0x-prefixed 32-byte big-endian hex (for display / debugging)
 */

// @ts-ignore
import { buildPoseidon } from "circomlibjs";

export interface Commitment {
  decimal: string;  // decimal string representation
  bytes32: string;  // 0x-prefixed 32-byte hex
}

export async function createCommitment(
  amount: string,
  randomness: string,
  zkPublicKey: string
): Promise<Commitment> {
  const poseidon = await buildPoseidon();

  const commitmentBigInt: bigint = BigInt(
    poseidon.F.toString(
      poseidon([BigInt(1), BigInt(amount), BigInt(randomness), BigInt(zkPublicKey)])
    )
  );

  const hex = commitmentBigInt.toString(16).padStart(64, "0");
  const bytes32 = "0x" + hex;

  return {
    decimal: commitmentBigInt.toString(),
    bytes32,
  };
}