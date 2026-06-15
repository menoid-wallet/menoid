// @ts-ignore
import { buildPoseidon } from "circomlibjs";
import { createHash } from "crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export interface PrivateWallet {
  address: string;
  privateKey: string; // Bech32 "suiprivkey..."
  publicKey: string;  // Base64 public key
}

export interface ZkKeys {
  secretKey: string;  // decimal string (BN254 scalar)
  publicKey: string;  // decimal string (Poseidon(3, sk))
}

export interface GeneratedWallet {
  privateWallet: PrivateWallet;
  zk: ZkKeys;
}

/**
 * Derive a deterministic wallet from any string seed.
 * In production the seed is a wallet signature over a fixed message.
 */
export async function generatePrivateWallet(
  seedInput: string
): Promise<GeneratedWallet> {
  const poseidon = await buildPoseidon();

  // Deterministic 32-byte private key via sha256 of seed
  const hash = createHash("sha256").update(seedInput).digest();
  const privateKeyHex = "0x" + hash.toString("hex");

  // Derive Sui Ed25519 Keypair
  const keypair = Ed25519Keypair.fromSecretKey(hash);
  const address = keypair.getPublicKey().toSuiAddress();
  const privateKey = keypair.getSecretKey();
  const publicKey = keypair.getPublicKey().toBase64();

  // ZK secret key = private key interpreted as a decimal BigInt
  const sk = BigInt(privateKeyHex).toString(10);

  // ZK public key = Poseidon(3, sk)
  const pkBig = poseidon([BigInt("3"), BigInt(sk)]);
  const pk = poseidon.F.toString(pkBig);

  return {
    privateWallet: {
      address,
      privateKey,
      publicKey,
    },
    zk: {
      secretKey: sk,
      publicKey: pk,
    },
  };
}