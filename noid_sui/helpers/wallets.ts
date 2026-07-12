// @ts-ignore
import { buildPoseidon, buildBabyjub } from "circomlibjs";
import { createHash } from "crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
// @ts-ignore
import nacl from "tweetnacl";

/**
 * Menoid wallet keys (Sui)
 *
 * There is NO derived wallet anymore. The user keeps their real Sui
 * address. The real wallet signs REGISTRATION_MESSAGE once (ed25519) and
 * from that signature we derive:
 *
 *   - spending keypair (BabyJubJub):  sk, pk = sk * Base8
 *   - encryption keypair (ed25519):   used only for encrypting/decrypting
 *     notes off-chain, never used as an on-chain account
 *
 * The user representation on-chain is:
 *
 *   userCommitment = Poseidon(address mod p, spendPk.x, spendPk.y)
 *
 * which is registered once via pool::register (fails if already registered).
 */

export const REGISTRATION_MESSAGE = "menoid_Wallet";

// BabyJubJub prime subgroup order (l)
export const BABYJUB_SUBGROUP_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// BN254 scalar field prime
export const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface SpendKeys {
  privateKey: string; // decimal string (BabyJubJub scalar)
  publicKey: { x: string; y: string }; // decimal strings
}

export interface EncryptionKeys {
  privateKey: string; // Bech32 "suiprivkey..." (ed25519, for note decryption only)
  publicKey: string;  // Base64 ed25519 public key
}

export interface NoidWallet {
  keypair: Ed25519Keypair; // the REAL wallet
  address: string;         // real 0x address
  addressField: string;    // decimal: address bytes (BE) mod p — circuit input
  spend: SpendKeys;
  encryption: EncryptionKeys;
  userCommitment: string;  // decimal string
}

let _poseidon: any = null;
let _babyjub: any = null;

async function getPoseidon() {
  if (!_poseidon) _poseidon = await buildPoseidon();
  return _poseidon;
}

async function getBabyjub() {
  if (!_babyjub) _babyjub = await buildBabyjub();
  return _babyjub;
}

/** Reduce a 32-byte Sui address (big-endian) into the BN254 scalar field. */
export function addressToField(address: string): string {
  return (BigInt(address) % BN254_P).toString();
}

/** Derive spending + encryption keys from the real wallet's signature. */
export async function deriveNoidKeys(signature: Uint8Array): Promise<{
  spend: SpendKeys;
  encryption: EncryptionKeys;
}> {
  const babyJub = await getBabyjub();

  // spending private key (BabyJubJub scalar)
  const spendSeed = createHash("sha256")
    .update(Buffer.concat([Buffer.from("menoid/spend"), Buffer.from(signature)]))
    .digest();
  const sk =
    BigInt("0x" + spendSeed.toString("hex")) % BABYJUB_SUBGROUP_ORDER;

  // spending public key = sk * Base8
  const pkPoint = babyJub.mulPointEscalar(babyJub.Base8, sk);
  const spend: SpendKeys = {
    privateKey: sk.toString(),
    publicKey: {
      x: babyJub.F.toString(pkPoint[0]),
      y: babyJub.F.toString(pkPoint[1]),
    },
  };

  // encryption keypair (only for note encryption, never an account).
  // Wrapped in an Ed25519Keypair purely so the existing encryption helper
  // formats (base64 pubkey / bech32 secret) keep working.
  const encSeed = createHash("sha256")
    .update(Buffer.concat([Buffer.from("menoid/encryption"), Buffer.from(signature)]))
    .digest();
  const encKeypair = Ed25519Keypair.fromSecretKey(encSeed);
  const encryption: EncryptionKeys = {
    privateKey: encKeypair.getSecretKey(),
    publicKey: encKeypair.getPublicKey().toBase64(),
  };

  return { spend, encryption };
}

/** userCommitment = Poseidon(address mod p, spendPk.x, spendPk.y) */
export async function computeUserCommitment(
  addressField: string,
  spendPublicKey: { x: string; y: string }
): Promise<string> {
  const poseidon = await getPoseidon();
  return poseidon.F.toString(
    poseidon([
      BigInt(addressField),
      BigInt(spendPublicKey.x),
      BigInt(spendPublicKey.y),
    ])
  );
}

/**
 * Derive the full off-chain wallet state for a REAL Sui keypair.
 * The real wallet signs REGISTRATION_MESSAGE (ed25519, deterministic).
 */
export async function deriveNoidWallet(keypair: Ed25519Keypair): Promise<NoidWallet> {
  // raw deterministic ed25519 signature over the registration message
  const secret = naclSecretKey(keypair);
  const signature = nacl.sign.detached(
    new TextEncoder().encode(REGISTRATION_MESSAGE),
    secret
  );

  const { spend, encryption } = await deriveNoidKeys(signature);

  const address = keypair.getPublicKey().toSuiAddress();
  const addressField = addressToField(address);
  const userCommitment = await computeUserCommitment(
    addressField,
    spend.publicKey
  );

  return {
    keypair,
    address,
    addressField,
    spend,
    encryption,
    userCommitment,
  };
}

/** 64-byte nacl secret key (seed || pubkey) from a Sui Ed25519Keypair. */
function naclSecretKey(keypair: Ed25519Keypair): Uint8Array {
  const { secretKey } = decodeSuiPrivateKey(keypair.getSecretKey());
  const kp = nacl.sign.keyPair.fromSeed(secretKey);
  return kp.secretKey;
}
