// @ts-ignore
import { buildPoseidon } from "circomlibjs";
import { createHash } from "crypto";
import { Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";

export interface PrivateWallet {
  address: string;
  privateKey: string; // 0x-prefixed hex, 32 bytes
  publicKey: string;  // 0x-prefixed hex, 32 bytes public key
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

  // Derive Aptos Ed25519 Keypair
  const privateKeyObj = new Ed25519PrivateKey(hash);
  const account = Account.fromPrivateKey({ privateKey: privateKeyObj });
  const address = account.accountAddress.toString();

  // NOTE: Ed25519PrivateKey.toString() / Ed25519PublicKey.toString() return
  // AIP-80-prefixed strings ("ed25519-priv-0x..." / "0x..." — the public key
  // string is unprefixed but the private key string is NOT). Use
  // toUint8Array() + manual hex encoding so both privateKey and publicKey are
  // plain "0x"-prefixed hex with no AIP-80 prefix, as required by
  // helpers/encryption.ts's hexToBytes().
  const toHex = (bytes: Uint8Array) => "0x" + Buffer.from(bytes).toString("hex");
  const privateKey = toHex(privateKeyObj.toUint8Array());
  const publicKey = toHex(privateKeyObj.publicKey().toUint8Array());

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