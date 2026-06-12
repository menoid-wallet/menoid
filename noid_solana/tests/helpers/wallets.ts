// @ts-ignore
import { buildPoseidon } from "circomlibjs";
import { createHash } from "crypto";
import pkg from "elliptic";
const EC = pkg.ec;

const secp256k1 = new EC("secp256k1");

export interface PrivateWallet {
  address: string;
  privateKey: string; // 0x-prefixed hex, 32 bytes
  publicKey: string;  // 0x-prefixed hex, 65 bytes uncompressed
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

  // Deterministic 32-byte private key via keccak256 of seed
  const hash = createHash("sha256").update(seedInput).digest();
  const privateKeyHex = "0x" + hash.toString("hex");

  // Derive secp256k1 key pair for ECIES
  const keyPair = secp256k1.keyFromPrivate(hash);
  const publicKeyHex =
    "0x" + keyPair.getPublic(false, "hex"); // uncompressed, 65 bytes

  // Deterministic address = last 20 bytes of keccak256(pubkey[1:])
  const pubBytes = Buffer.from(keyPair.getPublic(false, "hex").slice(2), "hex");
  const addrHash = createHash("sha256").update(pubBytes).digest();
  const address = "0x" + addrHash.slice(12).toString("hex");

  // ZK secret key = private key interpreted as a decimal BigInt
  const sk = BigInt(privateKeyHex).toString(10);

  // ZK public key = Poseidon(3, sk)
  const pkBig = poseidon([BigInt("3"), BigInt(sk)]);
  const pk = poseidon.F.toString(pkBig);

  return {
    privateWallet: {
      address,
      privateKey: privateKeyHex,
      publicKey: publicKeyHex,
    },
    zk: {
      secretKey: sk,
      publicKey: pk,
    },
  };
}
