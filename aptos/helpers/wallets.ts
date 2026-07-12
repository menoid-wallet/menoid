// @ts-ignore
import { buildPoseidon, buildBabyjub } from "circomlibjs";
import { createHash } from "crypto";
import { Account } from "@aptos-labs/ts-sdk";
// @ts-ignore
import nacl from "tweetnacl";

/**
 * Menoid wallet keys (Aptos)
 *
 * There is NO derived wallet anymore. The user keeps their real Aptos
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
  privateKey: string; // 0x hex ed25519 64-byte secret key
  publicKey: string;  // 0x hex ed25519 32-byte public key
}

export interface NoidWallet {
  account: Account;      // the REAL wallet
  address: string;       // real 0x address
  addressField: string;  // decimal: address bytes (BE) mod p — circuit input
  spend: SpendKeys;
  encryption: EncryptionKeys;
  userCommitment: string; // decimal string
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

/** Reduce a 32-byte Aptos address (big-endian) into the BN254 scalar field. */
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

  // encryption keypair (only for note encryption, never an account)
  const encSeed = createHash("sha256")
    .update(Buffer.concat([Buffer.from("menoid/encryption"), Buffer.from(signature)]))
    .digest();
  const encKeypair = nacl.sign.keyPair.fromSeed(encSeed);
  const toHex = (bytes: Uint8Array) => "0x" + Buffer.from(bytes).toString("hex");
  const encryption: EncryptionKeys = {
    privateKey: toHex(encKeypair.secretKey),
    publicKey: toHex(encKeypair.publicKey),
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
 * Derive the full off-chain wallet state for a REAL Aptos account.
 * The real wallet signs REGISTRATION_MESSAGE (ed25519, deterministic).
 */
export async function deriveNoidWallet(account: Account): Promise<NoidWallet> {
  const signature = account
    .sign(new TextEncoder().encode(REGISTRATION_MESSAGE))
    .toUint8Array();

  const { spend, encryption } = await deriveNoidKeys(signature);

  const address = account.accountAddress.toString();
  const addressField = addressToField(address);
  const userCommitment = await computeUserCommitment(
    addressField,
    spend.publicKey
  );

  return {
    account,
    address,
    addressField,
    spend,
    encryption,
    userCommitment,
  };
}
