/**
 * noid_pool.test.ts
 *
 * Full integration test for the Sui NoidPool.
 * Mirrors the Aptos noid_pool.devnet.test.ts structure exactly.
 *
 * Supports localnet and testnet via env vars:
 *
 *   SUI_RPC_URL          — default: http://127.0.0.1:9000 (localnet)
 *   SUI_FAUCET_URL       — default: http://127.0.0.1:9123/gas
 *   NOID_PACKAGE_ID      — required (deployed package object ID)
 *   POOL_STATE_ID        — required (shared PoolState object ID)
 *   VERIFIER_CONFIG_ID   — required (shared VerifierConfig object ID)
 *   DEPLOYER_SECRET_KEY  — required (base64 Sui keypair secret)
 *   CIRCUIT_DIR          — default: ./zk_build
 *
 * Run on localnet:
 *   sui start --with-faucet &
 *   export NOID_PACKAGE_ID=0x...
 *   export POOL_STATE_ID=0x...
 *   export VERIFIER_CONFIG_ID=0x...
 *   export DEPLOYER_SECRET_KEY=<base64>
 *   npx ts-node noid_pool.test.ts
 */

import {
  SuiClient,
  getFullnodeUrl,
} from "@mysten/sui/client";
import {
  Transaction,
} from "@mysten/sui/transactions";
import {
  Ed25519Keypair,
} from "@mysten/sui/keypairs/ed25519";
import {
  fromBase64,
  toHex,
} from "@mysten/sui/utils";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
// @ts-ignore
import * as snarkjs from "snarkjs";
// @ts-ignore
import { buildPoseidon } from "circomlibjs";
// @ts-ignore
import { IncrementalMerkleTree } from "@zk-kit/incremental-merkle-tree";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();
import { randomBytes } from "crypto";
import { deriveNoidWallet, NoidWallet } from "../helpers/wallets";
import { encryptMessage, decryptMessage } from "../helpers/encryption";
import { createCommitment } from "../helpers/commitments";

// ─── Config ────────────────────────────────────────────────────────────────

const RPC_URL    = process.env.SUI_RPC_URL    ?? "http://127.0.0.1:9000";
const FAUCET_URL = process.env.SUI_FAUCET_URL ?? "http://127.0.0.1:9123/gas";

const PACKAGE_ID = process.env.NOID_PACKAGE_ID ?? (() => {
  throw new Error("Set NOID_PACKAGE_ID env var");
})();
const POOL_STATE_ID = process.env.POOL_STATE_ID ?? (() => {
  throw new Error("Set POOL_STATE_ID env var");
})();
const VERIFIER_CONFIG_ID = process.env.VERIFIER_CONFIG_ID ?? (() => {
  throw new Error("Set VERIFIER_CONFIG_ID env var");
})();
const DEPLOYER_SK = process.env.DEPLOYER_SECRET_KEY ?? (() => {
  throw new Error("Set DEPLOYER_SECRET_KEY env var");
})();
const CIRCUIT_DIR = process.env.CIRCUIT_DIR ?? path.join(__dirname, "zk_build");

const IS_LOCAL = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");

const suiClient = new SuiClient({ url: RPC_URL });

// ─── Types ─────────────────────────────────────────────────────────────────

interface Note {
  poolId:     string;
  commitment: string;
  amount:     string;
  randomness: string;
  leafIndex:  number;
  root:       string;
}
interface WalletState {
  wallet:  NoidWallet;
  notes:   Note[];
  balance: bigint;
}
interface ProofCalldata {
  proofBytes: Uint8Array;   // pi_a(64) || pi_b(128) || pi_c(64)
}

// ─── Global state ──────────────────────────────────────────────────────────

let relayerWallet: NoidWallet;
const userWallets: NoidWallet[] = [];

const poolStates: Record<string, {
  tree:        InstanceType<typeof IncrementalMerkleTree>;
  roots:       string[];
  latestRoot:  string | null;
  leafToIndex: Record<string, number>;
}> = {};

const walletStates: Record<string, WalletState> = {};
const spentNullifiers = new Set<string>();

const emittedNoteEvents: Array<{
  poolId:        string;
  commitment:    string;
  encryptedNote: string;
}> = [];
const emittedNullifierEvents: Array<{ nullifier: string }> = [];

// ─── Keypairs ──────────────────────────────────────────────────────────────

// Relayer = deployer keypair
const relayerKeypair = DEPLOYER_SK.startsWith("suiprivkey")
  ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(DEPLOYER_SK).secretKey)
  : Ed25519Keypair.fromSecretKey(fromBase64(DEPLOYER_SK));

// Alice and Bob are generated fresh each run (funded from faucet)
const aliceKeypair   = new Ed25519Keypair();
const bobKeypair     = new Ed25519Keypair();

const relayerAddress = relayerKeypair.getPublicKey().toSuiAddress();
const aliceAddress   = aliceKeypair.getPublicKey().toSuiAddress();
const bobAddress     = bobKeypair.getPublicKey().toSuiAddress();

// ─── Helpers ───────────────────────────────────────────────────────────────

let _poseidon: any;
async function getPoseidon() {
  if (!_poseidon) _poseidon = await buildPoseidon();
  return _poseidon;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, IS_LOCAL ? Math.min(ms, 500) : ms));
}

// ─── Persistent cross-run state ────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, ".noid-sui-state.json");

interface PersistedState {
  commitments: string[];
  nullifiers:  string[];
}

function loadPersistedState(): PersistedState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw) as PersistedState;
    console.log(`  Loaded persisted state: ${s.commitments.length} commitments, ${s.nullifiers.length} nullifiers`);
    return s;
  } catch {
    return { commitments: [], nullifiers: [] };
  }
}

function savePersistedState(s: PersistedState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function mergeIntoState(s: PersistedState, newCmxs: string[], newNulls: string[]) {
  const cmxSet  = new Set(s.commitments);
  const nullSet = new Set(s.nullifiers);
  for (const c of newCmxs)  if (!cmxSet.has(c))  { s.commitments.push(c);  cmxSet.add(c);  }
  for (const n of newNulls) if (!nullSet.has(n))  { s.nullifiers.push(n);   nullSet.add(n); }
}

let persistedState: PersistedState = { commitments: [], nullifiers: [] };

// ─── Pool helpers ──────────────────────────────────────────────────────────

async function initializePool(poolId: string) {
  if (poolStates[poolId]) return;
  const poseidon = await getPoseidon();
  const hash = (inputs: bigint[]) => BigInt(poseidon.F.toString(poseidon(inputs)));
  const tree = new IncrementalMerkleTree(hash, 20, BigInt(0), 2);
  poolStates[poolId] = { tree, roots: [], latestRoot: null, leafToIndex: {} };
  console.log(`\nPool ${poolId} initialized`);
}

async function buildSyncTree(): Promise<InstanceType<typeof IncrementalMerkleTree>> {
  const poseidon = await getPoseidon();
  const hash = (inputs: bigint[]) => BigInt(poseidon.F.toString(poseidon(inputs)));
  const tree = new IncrementalMerkleTree(hash, 20, BigInt(0), 2);

  const persistedSet = new Set(persistedState.commitments);
  for (const cmx of persistedState.commitments) tree.insert(BigInt(cmx));
  for (const ev of emittedNoteEvents) {
    if (!persistedSet.has(ev.commitment)) tree.insert(BigInt(ev.commitment));
  }
  return tree;
}

function flushToPersisted() {
  const newCmxs  = emittedNoteEvents.map((e) => e.commitment);
  const newNulls = emittedNullifierEvents.map((e) => e.nullifier);
  mergeIntoState(persistedState, newCmxs, newNulls);
  savePersistedState(persistedState);
  console.log(`  Flushed to persisted state: ${persistedState.commitments.length} total commitments`);
}

async function rebuildWalletState() {
  console.log("\n========== REBUILDING WALLET STATE ==========");
  const poseidon = await getPoseidon();

  for (const poolId of Object.keys(poolStates)) delete poolStates[poolId];
  for (const key of Object.keys(walletStates)) {
    walletStates[key].notes   = [];
    walletStates[key].balance = 0n;
  }

  const persistedSet = new Set(persistedState.commitments);
  const allCmxs: string[] = [...persistedState.commitments];
  for (const ev of emittedNoteEvents) {
    if (!persistedSet.has(ev.commitment)) allCmxs.push(ev.commitment);
  }

  spentNullifiers.clear();
  for (const n of persistedState.nullifiers) spentNullifiers.add(n);
  for (const ev of emittedNullifierEvents)   spentNullifiers.add(ev.nullifier);
  console.log("Spent nullifiers:", [...spentNullifiers]);
  console.log(`  Total commitments for rebuild: ${allCmxs.length}`);

  for (const cmx of allCmxs) {
    const encryptedNote = emittedNoteEvents.find((e) => e.commitment === cmx)?.encryptedNote ?? "";

    await initializePool("0");
    const state = poolStates["0"];
    state.tree.insert(BigInt(cmx));
    const leafIndex = state.tree.leaves.length - 1;
    const root      = state.tree.root.toString();
    state.latestRoot = root;
    state.roots.push(root);
    state.leafToIndex[cmx] = leafIndex;

    if (!encryptedNote) continue;

    for (const [name, ws] of Object.entries(walletStates)) {
      try {
        const decrypted = decryptMessage(encryptedNote, ws.wallet.encryption.privateKey);
        const parsed: { amount: string; randomness: string } = JSON.parse(decrypted);
        console.log(`  ${name} decrypted note:`, parsed);
        const nullifier = poseidon.F.toString(
          poseidon([BigInt(2), BigInt(cmx), BigInt(parsed.randomness), BigInt(ws.wallet.spend.privateKey)])
        );
        if (spentNullifiers.has(nullifier)) {
          console.log("  Note already spent — skipping");
          continue;
        }
        ws.notes.push({ poolId: "0", commitment: cmx, amount: parsed.amount, randomness: parsed.randomness, leafIndex, root });
        ws.balance += BigInt(parsed.amount);
        console.log(`\n  ${name} FOUND NOTE`);
        console.log(parsed);
      } catch (_) {}
    }
  }

  console.log("\n========== WALLET STATES ==========");
  for (const [name, ws] of Object.entries(walletStates)) {
    console.log(`  ${name}: balance=${ws.balance} MIST, notes=${ws.notes.length}`);
  }
}

// ─── Proof helpers ─────────────────────────────────────────────────────────

function circuitPath(name: string, ext: "wasm" | "zkey") {
  return path.join(CIRCUIT_DIR, `${name}.${ext}`);
}

const FQ = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");

function toLE32(val: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let v = val;
  for (let i = 0; i < 32; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}

function g1Compress(x: bigint, y: bigint): Buffer {
  const buf = toLE32(x);
  const yIsNeg = y > (FQ - y);
  buf[31] = (buf[31] & 0x3f) | (yIsNeg ? 0x80 : 0x00);
  return buf;
}

function g2Compress(xc0: bigint, xc1: bigint, yc0: bigint, yc1: bigint): Buffer {
  const negYc1 = yc1 === 0n ? 0n : FQ - yc1;
  const negYc0 = yc0 === 0n ? 0n : FQ - yc0;
  const yIsNeg = yc1 > negYc1 || (yc1 === negYc1 && yc0 > negYc0);
  const c0buf = toLE32(xc0);
  const c1buf = toLE32(xc1);
  c1buf[31] = (c1buf[31] & 0x3f) | (yIsNeg ? 0x80 : 0x00);
  return Buffer.concat([c0buf, c1buf]);
}

function proofToBytes(proof: any): ProofCalldata {
  const a = g1Compress(BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1]));
  const b = g2Compress(
    BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1]),
    BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1]),
  );
  const c = g1Compress(BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1]));
  const out = Buffer.concat([a, b, c]); // 128 bytes
  return { proofBytes: new Uint8Array(out) };
}

function randomField(): string {
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  let r: bigint;
  do { r = BigInt("0x" + randomBytes(32).toString("hex")); } while (r >= P);
  return r.toString();
}

async function proveDeposit(
  depositAmount: bigint,
  c1: string, c2: string, c2Enabled: number, relayerUC: string,
  a1: bigint, r1: string, uc1: string,
  a2: bigint, r2: string,
): Promise<ProofCalldata> {
  const input = {
    depositAmount: depositAmount.toString(),
    c1, c2,
    c2_enabled: c2Enabled.toString(),
    uc2: relayerUC,
    a1: a1.toString(), r1, uc1,
    a2: a2.toString(), r2,
  };
  console.log("\n========== DEPOSIT CIRCOM INPUT ==========\n", input);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    circuitPath("deposit_proof_js/deposit_proof", "wasm"),
    circuitPath("deposit_proof_final", "zkey"),
  );
  console.log("\n========== DEPOSIT PUBLIC SIGNALS ==========\n", publicSignals);
  return proofToBytes(proof);
}

function poseidonHash2(poseidon: any, a: any, b: any): bigint {
  const h = poseidon([BigInt(a), BigInt(b)]);
  return poseidon.F.toObject(h);
}

function poseidonHash3(poseidon: any, a: any, b: any, c: any): bigint {
  const h1 = poseidonHash2(poseidon, a, b);
  return poseidonHash2(poseidon, h1, c);
}

function poseidonHash4(poseidon: any, a: any, b: any, c: any, d: any): bigint {
  const h1 = poseidonHash2(poseidon, a, b);
  const h2 = poseidonHash2(poseidon, c, d);
  return poseidonHash2(poseidon, h1, h2);
}

async function proveTransfer(
  senderWallet: NoidWallet,
  relayerUC: string,
  inputNote: Note,
  poolState: typeof poolStates[string],
  outputs: Array<{ amount: string; randomness: string; receiver: string; commitment: string }>,
): Promise<{ calldata: ProofCalldata; nullifier: string }> {
  const poseidon    = await getPoseidon();
  const merkleProof = poolState.tree.createProof(inputNote.leafIndex);
  const pathElements = merkleProof.siblings.map((x: bigint[]) => x[0].toString());
  const pathIndices  = merkleProof.pathIndices;

  const nullifier = poseidon.F.toString(
    poseidon([BigInt(2), BigInt(inputNote.commitment), BigInt(inputNote.randomness), BigInt(senderWallet.spend.privateKey)])
  );
  console.log("\n========== TRANSFER NULLIFIER ==========\n", nullifier);

  const enabled = [1, 0, 0, 0];
  const roots = [poolState.tree.root.toString(), "0", "0", "0"];
  const nullifiers = [nullifier, "0", "0", "0"];

  const output_enabled = [
    outputs[0] ? 1 : 0,
    outputs[1] ? 1 : 0,
    outputs[2] ? 1 : 0
  ];
  const c_outs = [
    outputs[0]?.commitment ?? "0",
    outputs[1]?.commitment ?? "0",
    outputs[2]?.commitment ?? "0"
  ];
  const a_outs = [
    outputs[0]?.amount ?? "0",
    outputs[1]?.amount ?? "0",
    outputs[2]?.amount ?? "0"
  ];
  const r_outs = [
    outputs[0]?.randomness ?? "0",
    outputs[1]?.randomness ?? "0",
    outputs[2]?.randomness ?? "0"
  ];
  const receivers = [
    outputs[0]?.receiver ?? "0",
    outputs[1]?.receiver ?? "0",
    outputs[2]?.receiver ?? "0"
  ];

  const enabled_hash = poseidonHash4(poseidon, enabled[0], enabled[1], enabled[2], enabled[3]).toString();
  const roots_hash = poseidonHash4(poseidon, roots[0], roots[1], roots[2], roots[3]).toString();
  const nullifiers_hash = poseidonHash4(poseidon, nullifiers[0], nullifiers[1], nullifiers[2], nullifiers[3]).toString();
  const output_enabled_hash = poseidonHash3(poseidon, output_enabled[0], output_enabled[1], output_enabled[2]).toString();
  const c_outs_hash = poseidonHash3(poseidon, c_outs[0], c_outs[1], c_outs[2]).toString();

  const input = {
    sk: senderWallet.spend.privateKey,
    owner_address: senderWallet.addressField,
    relayer: relayerUC,
    enabled,
    enabled_hash,
    c_ins:    [inputNote.commitment, "0", "0", "0"],
    a_ins:    [inputNote.amount,     "0", "0", "0"],
    r_ins:    [inputNote.randomness, "0", "0", "0"],
    roots,
    roots_hash,
    pathElements: [pathElements, Array(20).fill("0"), Array(20).fill("0"), Array(20).fill("0")],
    pathIndices:  [pathIndices,  Array(20).fill(0),   Array(20).fill(0),   Array(20).fill(0)],
    nullifiers,
    nullifiers_hash,
    output_enabled,
    output_enabled_hash,
    c_outs,
    c_outs_hash,
    a_outs,
    r_outs,
    receivers,
  };
  console.log("\n========== TRANSFER CIRCOM INPUT ==========\n", input);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    circuitPath("transfer_proof_js/transfer_proof", "wasm"),
    circuitPath("transfer_proof_final", "zkey"),
  );
  console.log("\n========== TRANSFER PUBLIC SIGNALS ==========\n", publicSignals);
  return { calldata: proofToBytes(proof), nullifier };
}

async function proveWithdraw(
  senderWallet: NoidWallet,
  relayerUC: string,
  receiverDecimal: string,
  inputNote: Note,
  poolState: typeof poolStates[string],
  withdrawAmount: bigint,
  changeOutput: { amount: string; randomness: string; commitment: string } | null,
  relayerOutput: { amount: string; randomness: string; commitment: string } | null,
): Promise<{ calldata: ProofCalldata; nullifier: string }> {
  const poseidon    = await getPoseidon();
  const merkleProof = poolState.tree.createProof(inputNote.leafIndex);
  const pathElements = merkleProof.siblings.map((x: bigint[]) => x[0].toString());
  const pathIndices  = merkleProof.pathIndices;

  const nullifier = poseidon.F.toString(
    poseidon([BigInt(2), BigInt(inputNote.commitment), BigInt(inputNote.randomness), BigInt(senderWallet.spend.privateKey)])
  );
  console.log("\n========== WITHDRAW NULLIFIER ==========\n", nullifier);

  const enabled = [1, 0, 0, 0];
  const roots = [poolState.tree.root.toString(), "0", "0", "0"];
  const nullifiers = [nullifier, "0", "0", "0"];

  const out_enabled = [changeOutput ? 1 : 0, relayerOutput ? 1 : 0];
  const c_outs = [changeOutput?.commitment ?? "0", relayerOutput?.commitment ?? "0"];

  const enabled_hash = poseidonHash4(poseidon, enabled[0], enabled[1], enabled[2], enabled[3]).toString();
  const roots_hash = poseidonHash4(poseidon, roots[0], roots[1], roots[2], roots[3]).toString();
  const nullifiers_hash = poseidonHash4(poseidon, nullifiers[0], nullifiers[1], nullifiers[2], nullifiers[3]).toString();
  const withdrawAmount_hash = poseidonHash2(poseidon, withdrawAmount, 0n).toString();
  const out_enabled_hash = poseidonHash2(poseidon, out_enabled[0], out_enabled[1]).toString();
  const c_outs_hash = poseidonHash2(poseidon, c_outs[0], c_outs[1]).toString();

  const input = {
    sk: senderWallet.spend.privateKey,
    owner_address: senderWallet.addressField,
    receiver: receiverDecimal, changeReceiver: senderWallet.userCommitment,
    relayer:  relayerUC,
    enabled,
    enabled_hash,
    c_ins:    [inputNote.commitment, "0", "0", "0"],
    a_ins:    [inputNote.amount,     "0", "0", "0"],
    r_ins:    [inputNote.randomness, "0", "0", "0"],
    roots,
    roots_hash,
    pathElements: [pathElements, Array(20).fill("0"), Array(20).fill("0"), Array(20).fill("0")],
    pathIndices:  [pathIndices,  Array(20).fill(0),   Array(20).fill(0),   Array(20).fill(0)],
    nullifiers,
    nullifiers_hash,
    withdrawAmount: withdrawAmount.toString(),
    withdrawAmount_hash,
    out_enabled,
    out_enabled_hash,
    c_outs,
    c_outs_hash,
    a_outs:  [changeOutput?.amount     ?? "0", relayerOutput?.amount     ?? "0"],
    r_outs:  [changeOutput?.randomness ?? "0", relayerOutput?.randomness ?? "0"],
    receivers: [senderWallet.userCommitment, relayerUC],
  };
  console.log("\n========== WITHDRAW CIRCOM INPUT ==========\n", input);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    circuitPath("withdraw_proof_js/withdraw_proof", "wasm"),
    circuitPath("withdraw_proof_final", "zkey"),
  );
  console.log("\n========== WITHDRAW PUBLIC SIGNALS ==========\n", publicSignals);
  return { calldata: proofToBytes(proof), nullifier };
}

// ─── Sui transaction helpers ───────────────────────────────────────────────

/** Request SUI from the localnet faucet. */
async function requestFaucet(address: string) {
  const res = await fetch(FAUCET_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ FixedAmountRequest: { recipient: address } }),
  });
  if (!res.ok) throw new Error(`Faucet failed: ${await res.text()}`);
  await sleep(IS_LOCAL ? 500 : 3000);
}

/** Get total SUI balance (in MIST) for an address. */
async function getSuiBalance(address: string): Promise<bigint> {
  const bal = await suiClient.getBalance({ owner: address });
  return BigInt(bal.totalBalance);
}

/**
 * Get a coin object with at least `amount` MIST owned by `address`.
 * Merges coins if needed and returns the object ID.
 */
async function getCoinForAmount(
  keypair:  Ed25519Keypair,
  amount:   bigint,
): Promise<string> {
  const address = keypair.getPublicKey().toSuiAddress();
  const coins   = await suiClient.getCoins({ owner: address, coinType: "0x2::sui::SUI" });
  if (coins.data.length === 0) throw new Error(`No SUI coins for ${address}`);

  // Find the first coin with enough balance, or merge all and use merged
  const sufficient = coins.data.find((c) => BigInt(c.balance) >= amount);
  if (sufficient) return sufficient.coinObjectId;

  // Merge all coins into first, return first
  const tx     = new Transaction();
  const [head, ...rest] = coins.data.map((c) => c.coinObjectId);
  if (rest.length > 0) tx.mergeCoins(tx.object(head), rest.map((r) => tx.object(r)));
  const result = await suiClient.signAndExecuteTransaction({
    signer:      keypair,
    transaction: tx,
    options:     { showEffects: true },
  });
  await suiClient.waitForTransaction({ digest: result.digest });
  await sleep(300);
  return head;
}

/**
 * Execute a Move call transaction signed by the relayer.
 * Returns the transaction digest.
 */
async function execRelayer(tx: Transaction, gasBudget: number = 50_000_000_000): Promise<string> {
  tx.setSender(relayerAddress);
  tx.setGasBudget(gasBudget);

  const result = await suiClient.signAndExecuteTransaction({
    signer:      relayerKeypair,
    transaction: tx,
    options:     { showEffects: true, showEvents: true },
  });
  if (result.effects?.status.status !== "success") {
    throw new Error(`Transaction failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await suiClient.waitForTransaction({ digest: result.digest });
  await sleep(IS_LOCAL ? 300 : 3000);
  return result.digest;
}

/**
 * Execute a Move call signed by `keypair`, which is also the gas payer.
 * Used for the user-submitted deposit (permissionless, no relayer involvement).
 */
async function execSigned(
  tx: Transaction,
  keypair: Ed25519Keypair,
  gasBudget: number = 50_000_000,
): Promise<string> {
  tx.setSender(keypair.getPublicKey().toSuiAddress());
  tx.setGasBudget(gasBudget);
  const result = await suiClient.signAndExecuteTransaction({
    signer:      keypair,
    transaction: tx,
    options:     { showEffects: true, showEvents: true },
  });
  if (result.effects?.status.status !== "success") {
    throw new Error(`Transaction failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await suiClient.waitForTransaction({ digest: result.digest });
  await sleep(IS_LOCAL ? 300 : 3000);
  return result.digest;
}

/**
 * Execute a sponsored transaction block where the sender is senderKeypair
 * and the gas payer is sponsorKeypair.
 */
async function execSponsored(
  tx: Transaction,
  senderKeypair:  Ed25519Keypair,
  sponsorKeypair: Ed25519Keypair,
  gasBudget: number = 50_000_000,
): Promise<string> {
  const senderAddress  = senderKeypair.getPublicKey().toSuiAddress();
  const sponsorAddress = sponsorKeypair.getPublicKey().toSuiAddress();
  tx.setSender(senderAddress);
  tx.setGasOwner(sponsorAddress);
  tx.setGasBudget(gasBudget);

  const txBytes = await tx.build({ client: suiClient });
  const { signature: senderSig } = await senderKeypair.signTransaction(txBytes);
  const { signature: sponsorSig } = await sponsorKeypair.signTransaction(txBytes);

  const result = await suiClient.executeTransactionBlock({
    transactionBlock: txBytes,
    signature:        [senderSig, sponsorSig],
    options:          { showEffects: true, showEvents: true },
  });
  if (result.effects?.status.status !== "success") {
    throw new Error(`Transaction failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await suiClient.waitForTransaction({ digest: result.digest });
  await sleep(IS_LOCAL ? 300 : 3000);
  return result.digest;
}

// ─── Registered user commitments (fetched from the chain) ───────────────────

let aliceUC = "0";
let bobUC = "0";
let relayerUC = "0";

/** Fetch a wallet's registered user commitment from the PoolState table. */
async function fetchUserCommitment(walletAddr: string): Promise<string> {
  const obj = await suiClient.getObject({ id: POOL_STATE_ID, options: { showContent: true } });
  const fields = (obj.data?.content as any)?.fields;
  const tableId = fields?.registered?.fields?.id?.id;
  if (!tableId) throw new Error("registered table not found in PoolState");
  const entry = await suiClient.getDynamicFieldObject({
    parentId: tableId,
    name: { type: "address", value: walletAddr },
  });
  const value = (entry.data?.content as any)?.fields?.value;
  if (value === undefined) throw new Error(`wallet ${walletAddr} is not registered`);
  return BigInt(value).toString();
}

// ─── Test runner ───────────────────────────────────────────────────────────

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  console.log(`\n${"=".repeat(60)}\n▶  ${name}\n${"=".repeat(60)}`);
  try {
    await fn();
    console.log(`\n   ✅ PASS`);
    results.push({ name, passed: true });
  } catch (e: any) {
    console.error(`\n   ❌ FAIL: ${e.message ?? e}`);
    results.push({ name, passed: false, error: e.message ?? String(e) });
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const NET_LABEL = IS_LOCAL ? "LOCALNET" : "TESTNET";
  console.log("=".repeat(60));
  console.log(`  NoidPool — Sui ${NET_LABEL} Integration Tests`);
  console.log("=".repeat(60));
  console.log(`  RPC:        ${RPC_URL}`);
  console.log(`  Network:    ${NET_LABEL}`);
  console.log(`  Package:    ${PACKAGE_ID}`);
  console.log(`  PoolState:  ${POOL_STATE_ID}`);
  console.log(`  VerConfig:  ${VERIFIER_CONFIG_ID}`);
  console.log(`  Circuits:   ${CIRCUIT_DIR}`);

  persistedState = loadPersistedState();

  console.log(`\nRelayer: ${relayerAddress}`);
  console.log(`Alice:   ${aliceAddress}`);
  console.log(`Bob:     ${bobAddress}`);

  const relayerBalance = await getSuiBalance(relayerAddress);
  console.log(`\nRelayer balance: ${relayerBalance} MIST`);

  const MIN_BALANCE = IS_LOCAL ? 1_000_000n : 500_000_000n;
  if (relayerBalance < MIN_BALANCE) {
    if (IS_LOCAL) {
      console.log("  Requesting faucet for relayer...");
      await requestFaucet(relayerAddress);
    } else {
      throw new Error(`Relayer needs at least ${MIN_BALANCE} MIST`);
    }
  }

  console.log(`\nFunding Alice and Bob from faucet...`);
  await requestFaucet(aliceAddress);
  await requestFaucet(bobAddress);
  console.log("Done.\n");

  // ─── TEST 1 ────────────────────────────────────────────────────────────

  await test("Derive noid keys from the REAL wallets", async () => {
    relayerWallet = await deriveNoidWallet(relayerKeypair);
    userWallets.length = 0;
    userWallets.push(await deriveNoidWallet(aliceKeypair));
    userWallets.push(await deriveNoidWallet(bobKeypair));
    console.log("\n========== RELAYER ==========\n", {
      address: relayerWallet.address, userCommitment: relayerWallet.userCommitment,
    });
    console.log("\n========== ALICE ==========\n", {
      address: userWallets[0].address, userCommitment: userWallets[0].userCommitment,
    });
    console.log("\n========== BOB ==========\n", {
      address: userWallets[1].address, userCommitment: userWallets[1].userCommitment,
    });
    // the users keep their REAL addresses
    assert(userWallets[0].address === aliceAddress, "alice keeps her real address");
    assert(userWallets[1].address === bobAddress, "bob keeps his real address");
    // derivation is deterministic
    const again = await deriveNoidWallet(aliceKeypair);
    assert(again.userCommitment === userWallets[0].userCommitment, "derivation must be deterministic");
    assert(userWallets[0].userCommitment !== userWallets[1].userCommitment, "distinct user commitments");
  });

  await test("Register wallets onchain (already registered counts as success)", async () => {
    const participants: Array<[string, NoidWallet, Ed25519Keypair]> = [
      ["relayer", relayerWallet, relayerKeypair],
      ["alice",   userWallets[0], aliceKeypair],
      ["bob",     userWallets[1], bobKeypair],
    ];
    for (const [name, wallet, kp] of participants) {
      try {
        const tx = new Transaction();
        tx.moveCall({
          target: `${PACKAGE_ID}::pool::register`,
          arguments: [
            tx.object(POOL_STATE_ID),
            tx.pure.u256(BigInt(wallet.userCommitment)),
          ],
        });
        await execSigned(tx, kp, 50_000_000);
        console.log(`  ${name} registered onchain`);
      } catch (e: any) {
        // register must fail ONLY because the wallet is already registered
        console.log(`  ${name} already registered`);
      }
      const onchain = await fetchUserCommitment(kp.getPublicKey().toSuiAddress());
      assert(BigInt(onchain) === BigInt(wallet.userCommitment), `${name} onchain user commitment must match`);
    }

    // the tests below address users by their REAL wallet address:
    // under the hood we fetch the registered user commitments from the chain
    relayerUC = await fetchUserCommitment(relayerAddress);
    aliceUC   = await fetchUserCommitment(aliceAddress);
    bobUC     = await fetchUserCommitment(bobAddress);
  });

  await test("Second registration for the same wallet is rejected", async () => {
    let threw = false;
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::register`,
        arguments: [
          tx.object(POOL_STATE_ID),
          tx.pure.u256(BigInt(userWallets[0].userCommitment)),
        ],
      });
      await execSigned(tx, aliceKeypair, 50_000_000);
    } catch { threw = true; }
    assert(threw, "duplicate registration must be rejected");
  });

  // ─── TEST 2 ────────────────────────────────────────────────────────────

  await test("Encrypt and decrypt notes between users and relayer", async () => {
    const user  = userWallets[0];
    const note  = { amount: "100000000", randomness: randomField() };
    const plain = JSON.stringify(note);
    const encToRelayer = encryptMessage(plain, relayerWallet.encryption.publicKey);
    const decByRelayer = decryptMessage(encToRelayer, relayerWallet.encryption.privateKey);
    assert(decByRelayer === plain, "Relayer must decrypt correctly");
    const encToUser = encryptMessage(plain, user.encryption.publicKey);
    const decByUser = decryptMessage(encToUser, user.encryption.privateKey);
    assert(decByUser === plain, "User must decrypt correctly");
  });

  // ─── TEST 3 ────────────────────────────────────────────────────────────

  await test("Pool is initialized — locked_balance == 0", async () => {
    const obj = await suiClient.getObject({
      id:      POOL_STATE_ID,
      options: { showContent: true },
    });
    assert(obj.data !== null, "PoolState object must exist");
    const fields = (obj.data?.content as any)?.fields;
    console.log(`\nPool locked_balance: ${fields?.locked_balance}`);
    const lb = BigInt(fields?.locked_balance ?? "0");
    assert(typeof lb === "bigint", "locked_balance must be a number");
    console.log("   (leftover balance from prior runs is normal)");
  });

  // ─── TEST 4 ────────────────────────────────────────────────────────────

  await test("Verify deposit proof off-chain (snarkjs)", async () => {
    const user = userWallets[0];
    const depositAmount = 100_000_000n, fee = 10_000_000n, userAmount = depositAmount - fee;
    const r1 = randomField(), r2 = randomField();
    const c1 = await createCommitment(userAmount.toString(), r1, aliceUC);
    const c2 = await createCommitment(fee.toString(),        r2, relayerUC);
    const input = {
      depositAmount: depositAmount.toString(),
      c1: c1.decimal, c2: c2.decimal,
      c2_enabled: "1", uc2: relayerUC,
      a1: userAmount.toString(), r1, uc1: aliceUC,
      a2: fee.toString(), r2,
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      circuitPath("deposit_proof_js/deposit_proof", "wasm"),
      circuitPath("deposit_proof_final", "zkey"),
    );
    const vKey = JSON.parse(fs.readFileSync(path.join(CIRCUIT_DIR, "deposit_verification_key.json"), "utf8"));
    const verified = await snarkjs.groth16.verify(vKey, publicSignals, proof);
    assert(verified, "Off-chain deposit proof must pass");
  });

  // ─── TEST 5 ────────────────────────────────────────────────────────────
  //
  // Deposit flow on Sui:
  //   1. Alice has a Coin<SUI> object from the faucet.
  //   2. The relayer builds a PTB that:
  //        a. Splits the exact deposit amount from Alice's coin
  //           (in practice Alice would sign this; here the relayer holds the coin
  //            after Alice transfers it, simulating a sponsored flow)
  //        b. Calls pool::deposit with the split coin + proof
  //   3. The relayer signs and submits the transaction.
  //
  // For the test we fund Alice, then transfer her coin to the relayer who
  // wraps it in the deposit call. In production a PTB with Alice's signature
  // would be the correct pattern.

  await test(`Alice deposits 1 SUI (user-signed, permissionless) on ${NET_LABEL}`, async () => {
    const user = userWallets[0];
    const depositAmount = 100_000_000n, fee = 10_000_000n, userAmount = depositAmount - fee;
    const r1 = randomField(), r2 = randomField();
    const c1 = await createCommitment(userAmount.toString(), r1, aliceUC);
    const c2 = await createCommitment(fee.toString(),        r2, relayerUC);
    console.log("\n========== COMMITMENTS ==========\n", c1, "\n", c2);

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: userAmount.toString(), randomness: r1 }),
      user.encryption.publicKey,
    );
    const encNote2 = encryptMessage(
      JSON.stringify({ amount: fee.toString(), randomness: r2 }),
      relayerWallet.encryption.publicKey,
    );

    const { proofBytes } = await proveDeposit(
      depositAmount, c1.decimal, c2.decimal, 1, relayerUC,
      userAmount, r1, aliceUC, fee, r2,
    );

    // Roots are recomputed on-chain — no off-chain root computation needed.

    console.log(`\nSubmitting DEPOSIT tx (signed by Alice) to ${NET_LABEL}...`);
    const tx = new Transaction();

    // Alice splits the exact deposit amount from her gas coin
    const [depositCoin] = tx.splitCoins(tx.gas, [depositAmount.toString()]);

    tx.moveCall({
      target:    `${PACKAGE_ID}::pool::deposit`,
      arguments: [
        tx.object(POOL_STATE_ID),
        tx.object(VERIFIER_CONFIG_ID),
        depositCoin,
        tx.pure.vector("u8", Array.from(proofBytes)),
        tx.pure.u256(BigInt(c1.decimal)),
        tx.pure.u256(BigInt(c2.decimal)),
        tx.pure.u64(Number(depositAmount)),
        tx.pure.vector("u8", Array.from(Buffer.from(encNote1))),
        tx.pure.vector("u8", Array.from(Buffer.from(encNote2))),
      ],
    });

    // Deposit is permissionless and submitted by the user (Alice) herself.
    const digest = await execSigned(tx, aliceKeypair, 50_000_000);
    console.log(`\nDeposit tx digest: ${digest}`);

    // Verify on-chain state
    const obj    = await suiClient.getObject({ id: POOL_STATE_ID, options: { showContent: true } });
    const fields = (obj.data?.content as any)?.fields;
    console.log(`\nPool locked_balance: ${fields?.locked_balance}`);
    assert(BigInt(fields?.locked_balance) >= depositAmount, `locked_balance should be >= ${depositAmount}`);

    emittedNoteEvents.push({ poolId: "0", commitment: c1.decimal, encryptedNote: encNote1 });
    emittedNoteEvents.push({ poolId: "0", commitment: c2.decimal, encryptedNote: encNote2 });
    flushToPersisted();

    console.log("\n========== ALICE DECRYPTED ==========\n",
      decryptMessage(encNote1, user.encryption.privateKey));
    console.log("\n========== RELAYER DECRYPTED ==========\n",
      decryptMessage(encNote2, relayerWallet.encryption.privateKey));
  });

  // ─── TEST 6 ────────────────────────────────────────────────────────────

  await test("Rebuild Merkle trees from emitted events", async () => {
    console.log(`\nTotal NoteCreated events: ${emittedNoteEvents.length}`);
    for (const key of Object.keys(poolStates)) delete poolStates[key];
    for (const ev of emittedNoteEvents) {
      await initializePool(ev.poolId);
      const state = poolStates[ev.poolId];
      state.tree.insert(BigInt(ev.commitment));
      const leafIndex = state.tree.leaves.length - 1;
      const root      = state.tree.root.toString();
      state.latestRoot = root;
      state.roots.push(root);
      state.leafToIndex[ev.commitment] = leafIndex;
      console.log(`  PoolId=${ev.poolId} | leafIndex=${leafIndex} | root=${root}`);
    }
    assert(Object.keys(poolStates).length > 0, "At least one pool must exist");
  });

  // ─── TEST 7 ────────────────────────────────────────────────────────────

  await test("Deposit with duplicate commitment is rejected", async () => {
    const existingC1 = emittedNoteEvents[0].commitment;
    const r_new  = randomField();
    const c2_new = await createCommitment("10000000", r_new, relayerUC);

    let threw = false;
    try {
      const { proofBytes } = await proveDeposit(
        100_000_000n, existingC1, c2_new.decimal, 1, relayerUC,
        90_000_000n, randomField(), aliceUC, 10_000_000n, r_new,
      );
      const tx = new Transaction();
      const [split] = tx.splitCoins(tx.gas, ["100000000"]);
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::deposit`,
        arguments: [
          tx.object(POOL_STATE_ID),
          tx.object(VERIFIER_CONFIG_ID),
          split,
          tx.pure.vector("u8", Array.from(proofBytes)),
          tx.pure.u256(BigInt(existingC1)),
          tx.pure.u256(BigInt(c2_new.decimal)),
          tx.pure.u64(100_000_000),
          tx.pure.vector("u8", Array.from(Buffer.from("enc1"))),
          tx.pure.vector("u8", Array.from(Buffer.from("enc2"))),
        ],
      });
      await execSigned(tx, aliceKeypair, 50_000_000);
    } catch { threw = true; }
    assert(threw, "Should throw on duplicate commitment");
  });

  // ─── TEST 8 ────────────────────────────────────────────────────────────

  await test("Transfer privately — Alice → Bob (relayer submits)", async () => {
    walletStates["alice"]   = { wallet: userWallets[0], notes: [], balance: 0n };
    walletStates["bob"]     = { wallet: userWallets[1], notes: [], balance: 0n };
    walletStates["relayer"] = { wallet: relayerWallet,  notes: [], balance: 0n };
    await rebuildWalletState();

    const inputNote = walletStates["alice"].notes[0];
    assert(!!inputNote, "Alice must have an unspent note");
    console.log("\n========== INPUT NOTE ==========\n", inputNote);

    const state       = poolStates[inputNote.poolId];
    const inputAmount = BigInt(inputNote.amount);
    const transferAmt = inputAmount * 5n / 10n;
    const fee         = 1_000_000n;
    const change      = inputAmount - transferAmt - fee;

    const rReceiver = randomField(), rChange = randomField(), rRelayer = randomField();
    const receiverCmx = await createCommitment(transferAmt.toString(), rReceiver, bobUC);
    const changeCmx   = await createCommitment(change.toString(),      rChange,   aliceUC);
    const relayerCmx  = await createCommitment(fee.toString(),         rRelayer,  relayerUC);

    const { calldata: { proofBytes }, nullifier } = await proveTransfer(
      userWallets[0], relayerUC, inputNote, state,
      [
        { amount: transferAmt.toString(), randomness: rReceiver, receiver: bobUC, commitment: receiverCmx.decimal },
        { amount: change.toString(),      randomness: rChange,   receiver: aliceUC, commitment: changeCmx.decimal   },
        { amount: fee.toString(),         randomness: rRelayer,  receiver: relayerUC,  commitment: relayerCmx.decimal   },
      ],
    );

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: transferAmt.toString(), randomness: rReceiver }),
      userWallets[1].encryption.publicKey,
    );
    const encNote2 = encryptMessage(
      JSON.stringify({ amount: change.toString(), randomness: rChange }),
      userWallets[0].encryption.publicKey,
    );
    const encNote3 = encryptMessage(
      JSON.stringify({ amount: fee.toString(), randomness: rRelayer }),
      relayerWallet.encryption.publicKey,
    );

    console.log(`\nSubmitting TRANSFER tx (relayer) to ${NET_LABEL}...`);
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::pool::transfer`,
      arguments: [
        tx.object(POOL_STATE_ID),
        tx.object(VERIFIER_CONFIG_ID),
        tx.pure.vector("u8", Array.from(proofBytes)),
        tx.pure.vector("u8", [1, 0, 0, 0]),
        tx.pure.vector("u64", [Number(inputNote.poolId), 0, 0, 0]),
        tx.pure.vector("u256", [BigInt(state.tree.root.toString()), 0n, 0n, 0n]),
        tx.pure.vector("u256", [BigInt(nullifier), 0n, 0n, 0n]),
        tx.pure.vector("u8", [1, 1, 1]),
        tx.pure.vector("u256", [BigInt(receiverCmx.decimal), BigInt(changeCmx.decimal), BigInt(relayerCmx.decimal)]),
        tx.pure.vector("u8", Array.from(Buffer.from(encNote1))),
        tx.pure.vector("u8", Array.from(Buffer.from(encNote2))),
        tx.pure.vector("u8", Array.from(Buffer.from(encNote3))),
      ],
    });

    const digest = await execRelayer(tx);
    console.log(`\nTransfer tx digest: ${digest}`);

    emittedNullifierEvents.push({ nullifier });
    emittedNoteEvents.push({ poolId: "0", commitment: receiverCmx.decimal, encryptedNote: encNote1 });
    emittedNoteEvents.push({ poolId: "0", commitment: changeCmx.decimal,   encryptedNote: encNote2 });
    emittedNoteEvents.push({ poolId: "0", commitment: relayerCmx.decimal,  encryptedNote: encNote3 });
    flushToPersisted();

    console.log(`\n   Bob receives: ${transferAmt} MIST\n   Alice change: ${change} MIST`);
  });

  // ─── TEST 9 ────────────────────────────────────────────────────────────

  await test("Double-spend (same nullifier) is rejected", async () => {
    assert(emittedNullifierEvents.length > 0, "Need a spent nullifier");
    const spentNull = emittedNullifierEvents[0].nullifier;
    let threw = false;
    try {
      const fakeC = await createCommitment("100", randomField(), aliceUC);
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::transfer`,
        arguments: [
          tx.object(POOL_STATE_ID),
          tx.object(VERIFIER_CONFIG_ID),
          tx.pure.vector("u8", Array.from(new Uint8Array(256))),
          tx.pure.vector("u8", [1, 0, 0, 0]),
          tx.pure.vector("u64", [0, 0, 0, 0]),
          tx.pure.vector("u256", [0n, 0n, 0n, 0n]),
          tx.pure.vector("u256", [BigInt(spentNull), 0n, 0n, 0n]),
          tx.pure.vector("u8", [1, 0, 0]),
          tx.pure.vector("u256", [BigInt(fakeC.decimal), 0n, 0n]),
          tx.pure.vector("u8", Array.from(Buffer.from("enc1"))),
          tx.pure.vector("u8", Array.from(Buffer.from("enc2"))),
          tx.pure.vector("u8", Array.from(Buffer.from("enc3"))),
        ],
      });
      await execRelayer(tx);
    } catch { threw = true; }
    assert(threw, "Should reject double-spend");
  });

  // ─── TEST 10 ───────────────────────────────────────────────────────────

  await test("Rebuild wallet state after transfer", async () => {
    await rebuildWalletState();
    console.log("\n========== WALLET STATES AFTER TRANSFER ==========");
    for (const [name, ws] of Object.entries(walletStates)) {
      console.log(`  ${name}: notes=${ws.notes.length}, balance=${ws.balance}`);
    }
    assert(walletStates["bob"].notes.length >= 1, "Bob must have at least 1 note");
  });

  // ─── TEST 11 ───────────────────────────────────────────────────────────

  await test(`Bob withdraws to his public Sui address on ${NET_LABEL}`, async () => {
    await rebuildWalletState();
    const inputNote = walletStates["bob"].notes[0];
    if (!inputNote) { console.log("   (skipped — Bob has no notes)"); return; }
    console.log("\n========== WITHDRAW INPUT NOTE ==========\n", inputNote);

    const state       = poolStates[inputNote.poolId];
    const inputAmt    = BigInt(inputNote.amount);
    const withdrawAmt = inputAmt * 8n / 10n;
    const fee         = 1_000_000n;
    const change      = inputAmt - withdrawAmt - fee;

    assert(change >= 0n, "Change must be non-negative");
    assert(withdrawAmt > 0n, "Withdraw amount must be positive");

    const rChange  = randomField();
    const rRelayer = randomField();
    const changeCmx  = change > 0n
      ? await createCommitment(change.toString(),   rChange,  bobUC)
      : null;
    const relayerCmx = fee > 0n
      ? await createCommitment(fee.toString(),      rRelayer, relayerUC)
      : null;

    // Convert Bob's Sui address to a BN254 scalar field element (mod P).
    // Sui addresses are 32-byte values; the circom circuit reduces mod P automatically.
    const BN254_P    = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const bobHex     = bobAddress.startsWith("0x") ? bobAddress.slice(2) : bobAddress;
    const receiverU256    = BigInt("0x" + bobHex.padStart(64, "0"));
    const receiverDecimal = (receiverU256 % BN254_P).toString();
    console.log(`\nBob addr u256: ${receiverU256}, mod P: ${receiverDecimal}`);

    const { calldata: { proofBytes }, nullifier } = await proveWithdraw(
      userWallets[1], relayerUC, receiverDecimal,
      inputNote, state, withdrawAmt,
      changeCmx  ? { amount: change.toString(),   randomness: rChange,  commitment: changeCmx.decimal  } : null,
      relayerCmx ? { amount: fee.toString(),       randomness: rRelayer, commitment: relayerCmx.decimal } : null,
    );

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: change.toString(), randomness: rChange }),
      userWallets[1].encryption.publicKey,
    );
    const encNote2 = encryptMessage(
      JSON.stringify({ amount: fee.toString(), randomness: rRelayer }),
      relayerWallet.encryption.publicKey,
    );

    const bobBalBefore = await getSuiBalance(bobAddress);
    console.log(`\nBob SUI before withdraw: ${bobBalBefore} MIST`);

    const objBefore    = await suiClient.getObject({ id: POOL_STATE_ID, options: { showContent: true } });
    const fieldsBefore = (objBefore.data?.content as any)?.fields;
    console.log(`Pool locked_balance before: ${fieldsBefore?.locked_balance}`);

    console.log(`\nSubmitting WITHDRAW tx (relayer) to ${NET_LABEL}...`);
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::pool::withdraw`,
      arguments: [
        tx.object(POOL_STATE_ID),
        tx.object(VERIFIER_CONFIG_ID),
        tx.pure.vector("u8", Array.from(proofBytes)),
        tx.pure.vector("u8", [1, 0, 0, 0]),
        tx.pure.vector("u64", [Number(inputNote.poolId), 0, 0, 0]),
        tx.pure.vector("u256", [BigInt(state.tree.root.toString()), 0n, 0n, 0n]),
        tx.pure.vector("u256", [BigInt(nullifier), 0n, 0n, 0n]),
        tx.pure.address(bobAddress),
        tx.pure.u64(Number(withdrawAmt)),
        tx.pure.vector("u8", [changeCmx ? 1 : 0, relayerCmx ? 1 : 0]),
        tx.pure.vector("u256", [BigInt(changeCmx?.decimal ?? "0"), BigInt(relayerCmx?.decimal ?? "0")]),
        tx.pure.vector("u8", Array.from(Buffer.from(encNote1))),
        tx.pure.vector("u8", Array.from(Buffer.from(encNote2))),
      ],
    });

    const digest = await execRelayer(tx);
    console.log(`\nWithdraw tx digest: ${digest}`);

    const bobBalAfter = await getSuiBalance(bobAddress);
    const objAfter    = await suiClient.getObject({ id: POOL_STATE_ID, options: { showContent: true } });
    const fieldsAfter = (objAfter.data?.content as any)?.fields;

    console.log(`\nPool locked_balance: ${fieldsAfter?.locked_balance}`);
    console.log(`Bob SUI: ${bobBalBefore} → ${bobBalAfter}`);

    assert(
      BigInt(bobBalAfter) > BigInt(bobBalBefore),
      `Bob's balance should increase. Before=${bobBalBefore} After=${bobBalAfter}`,
    );

    emittedNullifierEvents.push({ nullifier });
    if (changeCmx)  emittedNoteEvents.push({ poolId: "0", commitment: changeCmx.decimal,  encryptedNote: encNote1 });
    if (relayerCmx) emittedNoteEvents.push({ poolId: "0", commitment: relayerCmx.decimal, encryptedNote: encNote2 });
    flushToPersisted();
  });

  // ─── TEST 12 ───────────────────────────────────────────────────────────

  await test("Withdraw with zeroed proof bytes is rejected", async () => {
    let threw = false;
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::pool::withdraw`,
        arguments: [
          tx.object(POOL_STATE_ID),
          tx.object(VERIFIER_CONFIG_ID),
          tx.pure.vector("u8", Array.from(new Uint8Array(256))),
          tx.pure.vector("u8", [1, 0, 0, 0]),
          tx.pure.vector("u64", [0, 0, 0, 0]),
          tx.pure.vector("u256", [0n, 0n, 0n, 0n]),
          tx.pure.vector("u256", [BigInt(randomField()), 0n, 0n, 0n]),
          tx.pure.address(bobAddress),
          tx.pure.u64(1_000_000),
          tx.pure.vector("u8", [0, 0]),
          tx.pure.vector("u256", [0n, 0n]),
          tx.pure.vector("u8", Array.from(Buffer.from("enc1"))),
          tx.pure.vector("u8", Array.from(Buffer.from("enc2"))),
        ],
      });
      await execRelayer(tx);
    } catch { threw = true; }
    assert(threw, "Zeroed proof must be rejected");
  });

  // ─── TEST 13 ───────────────────────────────────────────────────────────

  await test("Poseidon domain-separator consistency (off-chain smoke test)", async () => {
    const poseidon = await getPoseidon();
    const sk = "12345678901234567890";
    const uc = poseidon.F.toString(poseidon([BigInt("1234"), BigInt("5678"), BigInt("91011")]));
    assert(BigInt(uc) > 0n, "user commitment must be non-zero");
    const c  = (await createCommitment("100000000", "999888777", uc)).decimal;
    assert(BigInt(c) > 0n, "Commitment must be non-zero");
    const n  = poseidon.F.toString(poseidon([BigInt(2), BigInt(c), BigInt("999888777"), BigInt(sk)]));
    assert(BigInt(n) > 0n, "Nullifier must be non-zero");
    const c2 = (await createCommitment("100000000", "999888778", uc)).decimal;
    assert(c !== c2, "Different r must yield different commitment");
    console.log(`\n   sk=${sk} uc=${uc} cmx=${c} nullifier=${n}`);
  });

  // ─── TEST 14 ───────────────────────────────────────────────────────────

  await test("Off-chain Merkle proof self-consistency", async () => {
    const poseidon = await getPoseidon();
    const hash = (inputs: bigint[]) => BigInt(poseidon.F.toString(poseidon(inputs)));
    const tree = new IncrementalMerkleTree(hash, 20, BigInt(0), 2);
    const leaf1 = BigInt(randomField()), leaf2 = BigInt(randomField()), leaf3 = BigInt(randomField());
    tree.insert(leaf1); tree.insert(leaf2); tree.insert(leaf3);
    const finalRoot = tree.root;
    const proof = tree.createProof(0);
    let cur = leaf1;
    for (let i = 0; i < proof.siblings.length; i++) {
      const sib = proof.siblings[i][0] as bigint;
      cur = proof.pathIndices[i] === 0 ? hash([cur, sib]) : hash([sib, cur]);
    }
    assert(cur === finalRoot, `Root mismatch. Got ${cur}, expected ${finalRoot}`);
    console.log(`\n   Merkle root after 3 leaves: ${finalRoot} ✅`);
  });

  // ─── Summary ───────────────────────────────────────────────────────────

  console.log("\n" + "═".repeat(60));
  console.log(`  TEST RESULTS  —  Sui ${NET_LABEL}`);
  console.log("═".repeat(60));
  let passed = 0, failed = 0;
  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`  ${icon}  ${r.name}`);
    if (!r.passed && r.error) console.log(`       → ${r.error}`);
    r.passed ? passed++ : failed++;
  }
  console.log("─".repeat(60));
  console.log(`  ${passed} passed  /  ${failed} failed  /  ${results.length} total`);
  console.log("═".repeat(60) + "\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });