// @ts-ignore
import { buildPoseidon } from "circomlibjs";

export interface Commitment {
  decimal: string;  // decimal string representation
  bytes32: string;  // 0x-prefixed 32-byte hex
}

export async function createCommitment(
  amount: string,
  randomness: string,
  userCommitment: string
): Promise<Commitment> {
  const poseidon = await buildPoseidon();

  const commitmentBigInt: bigint = BigInt(
    poseidon.F.toString(
      poseidon([BigInt(1), BigInt(amount), BigInt(randomness), BigInt(userCommitment)])
    )
  );

  const hex = commitmentBigInt.toString(16).padStart(64, "0");
  const bytes32 = "0x" + hex;

  return {
    decimal: commitmentBigInt.toString(),
    bytes32,
  };
}
