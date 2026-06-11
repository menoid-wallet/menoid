/**
 * noid_pool.devnet.test.ts
 *
 * Full integration test for the Aptos NoidPool.
 * Supports both devnet and localnet via env vars:
 *
 *   APTOS_NODE_URL        — default: https://fullnode.devnet.aptoslabs.com/v1
 *   APTOS_FAUCET_URL      — default: https://faucet.devnet.aptoslabs.com
 *   NOID_MODULE_ADDR      — required  (admin / deployer address)
 *   DEPLOYER_PRIVATE_KEY  — required
 *   POOL_SEED             — optional, default "noid-pool-seed-v1"
 *
 * Deposit architecture (corrected):
 *   • Alice is the transaction SENDER — she provides the APT.
 *   • Relayer is the FEE-PAYER — it pays gas via sponsored (fee-payer) transaction.
 *   • Uses aptos.transaction.build.simple({ withFeePayer: true }) + signAsFeePayer.
 *
 * For localnet:
 *   export APTOS_NODE_URL=http://127.0.0.1:8080/v1
 *   export APTOS_FAUCET_URL=http://127.0.0.1:8081
 */

import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
  InputGenerateTransactionPayloadData,
  MoveValue,
} from "@aptos-labs/ts-sdk";
// @ts-ignore
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
// @ts-ignore
import { IncrementalMerkleTree } from "@zk-kit/incremental-merkle-tree";
import * as path from "path";
import * as fs from "fs";
import { randomBytes } from "crypto";
import { generatePrivateWallet, GeneratedWallet } from "./helpers/wallets";
import { encryptMessage, decryptMessage } from "./helpers/encryption";
import { createCommitment } from "./helpers/commitments";

// ─── Config ────────────────────────────────────────────────────────────────

const NODE_URL   = process.env.APTOS_NODE_URL   ?? "https://fullnode.devnet.aptoslabs.com/v1";
const FAUCET_URL = process.env.APTOS_FAUCET_URL ?? "https://faucet.devnet.aptoslabs.com";
const POOL_SEED  = process.env.POOL_SEED        ?? "noid-pool-seed-v1";

const MODULE_ADDR = process.env.NOID_MODULE_ADDR ?? (() => {
  throw new Error("Set NOID_MODULE_ADDR env var");
})();
const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY ?? (() => {
  throw new Error("Set DEPLOYER_PRIVATE_KEY env var");
})();
const CIRCUIT_DIR = process.env.CIRCUIT_DIR ?? path.join(__dirname, "zk_build");

const IS_LOCAL = NODE_URL.includes("127.0.0.1") || NODE_URL.includes("localhost");
const network  = IS_LOCAL ? Network.LOCAL : Network.DEVNET;

const aptos = new Aptos(new AptosConfig({
  network,
  fullnode: NODE_URL,
  faucet:   FAUCET_URL,
}));

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
  wallet:  GeneratedWallet;
  notes:   Note[];
  balance: bigint;
}
interface ProofCalldata {
  aBytes: Uint8Array;
  bBytes: Uint8Array;
  cBytes: Uint8Array;
}

// ─── Global state ──────────────────────────────────────────────────────────

let relayerWallet: GeneratedWallet;
const userWallets: GeneratedWallet[] = [];

// poolResourceAddr is the resource account that actually holds APT
let poolResourceAddr: string = "";

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
//
// Aptos localnet persists between runs, but this process starts fresh each time.
// The #[event]-style Move events can only be queried via the indexer (unavailable
// on a plain localnet). Instead we keep a small JSON file that accumulates every
// commitment and nullifier seen across all runs. Each run merges its new events
// into the file so the next run starts with the correct on-chain tree state.
//
// File location: .noid-state.json next to this test file.

const STATE_FILE = path.join(__dirname, ".noid-state.json");

interface PersistedState {
  commitments: string[];   // in insertion order
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

// Merge new items into persisted state (dedup by value, preserve order)
function mergeIntoState(s: PersistedState, newCmxs: string[], newNulls: string[]) {
  const cmxSet  = new Set(s.commitments);
  const nullSet = new Set(s.nullifiers);
  for (const c of newCmxs)  if (!cmxSet.has(c))  { s.commitments.push(c);  cmxSet.add(c);  }
  for (const n of newNulls) if (!nullSet.has(n))  { s.nullifiers.push(n);   nullSet.add(n); }
}

// Global persisted state for this run
let persistedState: PersistedState = { commitments: [], nullifiers: [] };

async function initializePool(poolId: string) {
  if (poolStates[poolId]) return;
  const poseidon = await getPoseidon();
  const hash = (inputs: bigint[]) => BigInt(poseidon.F.toString(poseidon(inputs)));
  const tree = new IncrementalMerkleTree(hash, 20, BigInt(0), 2);
  poolStates[poolId] = { tree, roots: [], latestRoot: null, leafToIndex: {} };
  console.log(`\nPool ${poolId} initialized`);
}

/**
 * Build a Merkle tree that mirrors the on-chain pool tree exactly.
 *
 * Uses the persisted state (from .noid-state.json) as the base — this covers
 * all commitments from prior runs — then appends any in-memory events from
 * this run that haven't been persisted yet.
 */
async function buildSyncTree(): Promise<InstanceType<typeof IncrementalMerkleTree>> {
  const poseidon = await getPoseidon();
  const hash = (inputs: bigint[]) => BigInt(poseidon.F.toString(poseidon(inputs)));
  const tree = new IncrementalMerkleTree(hash, 20, BigInt(0), 2);

  const persistedSet = new Set(persistedState.commitments);

  // Insert persisted (prior + already-flushed current run) commitments first
  for (const cmx of persistedState.commitments) tree.insert(BigInt(cmx));

  // Append in-memory events from this run not yet persisted
  for (const ev of emittedNoteEvents) {
    if (!persistedSet.has(ev.commitment)) tree.insert(BigInt(ev.commitment));
  }

  return tree;
}

/**
 * Flush all in-memory events into the persisted state file and update
 * the global persistedState so subsequent buildSyncTree() calls see them.
 * Call this immediately after each successful on-chain transaction.
 */
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

  // Wipe all pool states — always rebuild from scratch
  for (const poolId of Object.keys(poolStates)) delete poolStates[poolId];
  for (const key of Object.keys(walletStates)) {
    walletStates[key].notes = [];
    walletStates[key].balance = 0n;
  }

  // Build the authoritative ordered commitment list:
  // persisted (prior runs + already-flushed current) + unconfirmed in-memory
  const persistedSet = new Set(persistedState.commitments);
  const allCmxs: string[] = [...persistedState.commitments];
  for (const ev of emittedNoteEvents) {
    if (!persistedSet.has(ev.commitment)) allCmxs.push(ev.commitment);
  }

  // Build nullifier set from persisted + in-memory
  spentNullifiers.clear();
  for (const n of persistedState.nullifiers)  spentNullifiers.add(n);
  for (const ev of emittedNullifierEvents)    spentNullifiers.add(ev.nullifier);
  console.log("Spent nullifiers:", [...spentNullifiers]);
  console.log(`  Total commitments for rebuild: ${allCmxs.length}`);

  for (const cmx of allCmxs) {
    // Find encrypted note from in-memory log (persisted state doesn't store enc data)
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
        const decrypted = decryptMessage(encryptedNote, ws.wallet.privateWallet.privateKey);
        const parsed: { amount: string; randomness: string } = JSON.parse(decrypted);
        console.log(`  ${name} decrypted note:`, parsed);
        const nullifier = poseidon.F.toString(
          poseidon([BigInt(2), BigInt(cmx), BigInt(parsed.randomness), BigInt(ws.wallet.zk.secretKey)])
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
    console.log(`  ${name}: balance=${ws.balance} octas, notes=${ws.notes.length}`);
  }
}

// ─── Proof helpers ─────────────────────────────────────────────────────────

function circuitPath(name: string, ext: "wasm" | "zkey") {
  return path.join(CIRCUIT_DIR, `${name}.${ext}`);
}

function writeLE(buf: Uint8Array, value: bigint, offset: number, len: number) {
  let v = value;
  for (let i = offset; i < offset + len; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function proofToBytes(proof: any): ProofCalldata {
  const g1 = (pt: string[]) => {
    const b = new Uint8Array(64);
    writeLE(b, BigInt(pt[0]), 0,  32);
    writeLE(b, BigInt(pt[1]), 32, 32);
    return b;
  };
  const g2 = (pt: string[][]) => {
    const b = new Uint8Array(128);
    writeLE(b, BigInt(pt[0][0]), 0,  32);
    writeLE(b, BigInt(pt[0][1]), 32, 32);
    writeLE(b, BigInt(pt[1][0]), 64, 32);
    writeLE(b, BigInt(pt[1][1]), 96, 32);
    return b;
  };
  return { aBytes: g1(proof.pi_a), bBytes: g2(proof.pi_b), cBytes: g1(proof.pi_c) };
}

async function proveDeposit(
  depositAmount: bigint,
  c1: string, c2: string, relayerPk: string,
  a1: bigint, r1: string, pk1: string,
  a2: bigint, r2: string,
): Promise<ProofCalldata> {
  const input = {
    depositAmount: depositAmount.toString(),
    c1, c2, a1: a1.toString(), r1, pk1,
    a2: a2.toString(), r2, pk2: relayerPk,
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

async function proveTransfer(
  senderWallet: GeneratedWallet,
  relayer: GeneratedWallet,
  inputNote: Note,
  poolState: typeof poolStates[string],
  outputs: Array<{ amount: string; randomness: string; receiver: string; commitment: string }>,
): Promise<{ calldata: ProofCalldata; nullifier: string }> {
  const poseidon     = await getPoseidon();
  const merkleProof  = poolState.tree.createProof(inputNote.leafIndex);
  const pathElements = merkleProof.siblings.map((x: bigint[]) => x[0].toString());
  const pathIndices  = merkleProof.pathIndices;

  const nullifier = poseidon.F.toString(
    poseidon([BigInt(2), BigInt(inputNote.commitment), BigInt(inputNote.randomness), BigInt(senderWallet.zk.secretKey)])
  );
  console.log("\n========== TRANSFER NULLIFIER ==========\n", nullifier);

  const input = {
    sk: senderWallet.zk.secretKey, pk: senderWallet.zk.publicKey,
    relayer: relayer.zk.publicKey,
    enabled:  [1, 0, 0, 0],
    c_ins:    [inputNote.commitment, "0", "0", "0"],
    a_ins:    [inputNote.amount,     "0", "0", "0"],
    r_ins:    [inputNote.randomness, "0", "0", "0"],
    roots:    [poolState.tree.root.toString(), "0", "0", "0"],
    pathElements: [pathElements, Array(20).fill("0"), Array(20).fill("0"), Array(20).fill("0")],
    pathIndices:  [pathIndices,  Array(20).fill(0),   Array(20).fill(0),   Array(20).fill(0)],
    nullifiers:   [nullifier, "0", "0", "0"],
    output_enabled: outputs.map(() => 1),
    c_outs:    outputs.map((o) => o.commitment),
    a_outs:    outputs.map((o) => o.amount),
    r_outs:    outputs.map((o) => o.randomness),
    receivers: outputs.map((o) => o.receiver),
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
  senderWallet: GeneratedWallet,
  relayer: GeneratedWallet,
  receiverDecimal: string,
  inputNote: Note,
  poolState: typeof poolStates[string],
  withdrawAmount: bigint,
  changeOutput: { amount: string; randomness: string; commitment: string } | null,
  relayerOutput: { amount: string; randomness: string; commitment: string } | null,
): Promise<{ calldata: ProofCalldata; nullifier: string }> {
  const poseidon     = await getPoseidon();
  const merkleProof  = poolState.tree.createProof(inputNote.leafIndex);
  const pathElements = merkleProof.siblings.map((x: bigint[]) => x[0].toString());
  const pathIndices  = merkleProof.pathIndices;

  const nullifier = poseidon.F.toString(
    poseidon([BigInt(2), BigInt(inputNote.commitment), BigInt(inputNote.randomness), BigInt(senderWallet.zk.secretKey)])
  );
  console.log("\n========== WITHDRAW NULLIFIER ==========\n", nullifier);

  const input = {
    sk: senderWallet.zk.secretKey, pk: senderWallet.zk.publicKey,
    receiver: receiverDecimal, changeReceiver: senderWallet.zk.publicKey,
    relayer:  relayer.zk.publicKey,
    enabled:  [1, 0, 0, 0],
    c_ins:    [inputNote.commitment, "0", "0", "0"],
    a_ins:    [inputNote.amount,     "0", "0", "0"],
    r_ins:    [inputNote.randomness, "0", "0", "0"],
    roots:    [poolState.tree.root.toString(), "0", "0", "0"],
    pathElements: [pathElements, Array(20).fill("0"), Array(20).fill("0"), Array(20).fill("0")],
    pathIndices:  [pathIndices,  Array(20).fill(0),   Array(20).fill(0),   Array(20).fill(0)],
    nullifiers:   [nullifier, "0", "0", "0"],
    withdrawAmount: withdrawAmount.toString(),
    out_enabled: [changeOutput ? 1 : 0, relayerOutput ? 1 : 0],
    c_outs:  [changeOutput?.commitment ?? "0", relayerOutput?.commitment ?? "0"],
    a_outs:  [changeOutput?.amount     ?? "0", relayerOutput?.amount     ?? "0"],
    r_outs:  [changeOutput?.randomness ?? "0", relayerOutput?.randomness ?? "0"],
    receivers: [senderWallet.zk.publicKey, relayer.zk.publicKey],
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

// ─── Aptos helpers ─────────────────────────────────────────────────────────

function bytesToMoveArg(b: Uint8Array | Buffer): number[] { return Array.from(b); }
function u256ToMoveArg(v: bigint | string): string { return v.toString(); }

function randomField(): string {
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  let r: bigint;
  do { r = BigInt("0x" + randomBytes(32).toString("hex")); } while (r >= P);
  return r.toString();
}

async function fundAccount(account: Account, funder: Account, targetOctas: number) {
  const addr = account.accountAddress;
  const current = await aptos.getAccountAPTAmount({ accountAddress: addr }).catch(() => 0);
  if (current >= targetOctas) {
    console.log(`  ${addr.toString().slice(0, 14)}... already has ${current} octas — skipping`);
    return;
  }
  const needed = targetOctas - current;
  const tx = await aptos.transaction.build.simple({
    sender: funder.accountAddress,
    data: {
      function:          "0x1::aptos_account::transfer",
      typeArguments:     [],
      functionArguments: [addr.toString(), needed.toString()],
    },
    options: { maxGasAmount: 10_000, gasUnitPrice: 100 },
  });
  const signed = await aptos.transaction.sign({ signer: funder, transaction: tx });
  const result = await aptos.transaction.submit.simple({ senderAuthenticator: signed, transaction: tx });
  await aptos.waitForTransaction({ transactionHash: result.hash });
  await sleep(500);
  const balance = await aptos.getAccountAPTAmount({ accountAddress: addr });
  console.log(`  Funded ${addr.toString().slice(0, 14)}... → ${balance} octas`);
}

/**
 * Submit a plain single-signer transaction (relayer pays everything).
 * Used for: transfer, withdraw, initialization — any tx where the relayer
 * is both sender and gas payer.
 */
async function submitRelayer(
  sender:   Account,
  payload:  InputGenerateTransactionPayloadData,
  gasLimit: number = 2_000_000,
) {
  const tx = await aptos.transaction.build.simple({
    sender:  sender.accountAddress,
    data:    payload,
    options: { maxGasAmount: gasLimit, gasUnitPrice: 100 },
  });
  const auth   = await aptos.transaction.sign({ signer: sender, transaction: tx });
  const result = await aptos.transaction.submit.simple({
    senderAuthenticator: auth,
    transaction: tx,
  });
  const receipt = await aptos.waitForTransaction({ transactionHash: result.hash });
  await sleep(IS_LOCAL ? 300 : 3000);
  return receipt;
}

/**
 * Submit a SPONSORED (fee-payer) transaction.
 *
 * Architecture:
 *   sender   — pays the APT being deposited; sequence number is incremented
 *   feePayer — pays gas (the relayer)
 *
 * SDK steps (from official docs):
 *   1. Build with withFeePayer: true
 *   2. sender signs with .sign()
 *   3. feePayer signs with .signAsFeePayer()
 *   4. Submit with both authenticators
 */
async function submitSponsored(
  sender:   Account,
  feePayer: Account,
  payload:  InputGenerateTransactionPayloadData,
  gasLimit: number = 2_000_000,
) {
  // Step 1: Build — mark as fee-payer transaction
  const tx = await aptos.transaction.build.simple({
    sender:      sender.accountAddress,
    withFeePayer: true,
    data:         payload,
    options: { maxGasAmount: gasLimit, gasUnitPrice: 100 },
  });

  // Step 2: Sender signs (Alice)
  const senderAuth = await aptos.transaction.sign({ signer: sender, transaction: tx });

  // Step 3: Fee payer signs AS fee payer (Relayer)
  const feePayerAuth = await aptos.transaction.signAsFeePayer({ signer: feePayer, transaction: tx });

  // Step 4: Submit with both signatures
  const result = await aptos.transaction.submit.simple({
    transaction:          tx,
    senderAuthenticator:  senderAuth,
    feePayerAuthenticator: feePayerAuth,
  });

  const receipt = await aptos.waitForTransaction({ transactionHash: result.hash });
  await sleep(IS_LOCAL ? 300 : 3000);
  return receipt;
}

async function viewFunction(func: string, typeArgs: string[], args: any[]): Promise<MoveValue[]> {
  return aptos.view({
    payload: {
      function:          `${MODULE_ADDR}::pool::${func}` as `${string}::${string}::${string}`,
      typeArguments:     typeArgs,
      functionArguments: args as any,
    },
  });
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
  const NET_LABEL = IS_LOCAL ? "LOCALNET" : "DEVNET";
  console.log("=".repeat(60));
  console.log(`  NoidPool — Aptos ${NET_LABEL} Integration Tests`);
  console.log("=".repeat(60));
  console.log(`  Node:     ${NODE_URL}`);
  console.log(`  Faucet:   ${FAUCET_URL}`);
  console.log(`  Network:  ${NET_LABEL}`);
  console.log(`  Module:   ${MODULE_ADDR}`);
  console.log(`  Circuits: ${CIRCUIT_DIR}`);
  console.log(`  Seed:     ${POOL_SEED}`);

  // Load persisted cross-run state immediately — this is what keeps the
  // local Merkle tree in sync with the localnet across reruns.
  persistedState = loadPersistedState();

  const aliceSigner   = Account.generate();
  const bobSigner     = Account.generate();
  const relayerSigner = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(DEPLOYER_PK) });
  const deployer      = relayerSigner;

  console.log(`\nDeployer/Relayer: ${deployer.accountAddress}`);
  const deployerBalance = await aptos.getAccountAPTAmount({ accountAddress: deployer.accountAddress });
  console.log(`Deployer balance: ${deployerBalance} octas`);

  const MIN_BALANCE = IS_LOCAL ? 1_000_000 : 300_000_000;
  if (deployerBalance < MIN_BALANCE) {
    const cmd = IS_LOCAL
      ? `aptos account fund-with-faucet --profile noid-local --faucet-url http://127.0.0.1:8081 --amount 1000000000`
      : `aptos account fund-with-faucet --profile noid-final --amount 1000000000`;
    throw new Error(`Deployer needs at least ${MIN_BALANCE} octas. Run:\n  ${cmd}`);
  }

  console.log(`\nFunding test accounts (idempotent)...`);
  // Alice needs: 100M (deposit) + gas reserve for sponsored tx sender.
  // For sponsored tx, only the FEE PAYER needs funds for gas — Alice only needs APT for deposit.
  // We give Alice exactly what she needs to deposit (100M) plus a small buffer.
  await fundAccount(aliceSigner, deployer, 110_000_000);
  await fundAccount(bobSigner,   deployer, 50_000_000);
  console.log("Done.\n");

  console.log(`Alice:   ${aliceSigner.accountAddress}`);
  console.log(`Bob:     ${bobSigner.accountAddress}`);
  console.log(`Relayer: ${relayerSigner.accountAddress}`);

  // TEST 1
  await test("Generate deterministic private wallets and ZK keys", async () => {
    relayerWallet = await generatePrivateWallet("noid-relayer-devnet-seed");
    console.log("\n========== RELAYER WALLET ==========\n", relayerWallet);
    const seeds = ["noid-alice-devnet-seed", "noid-bob-devnet-seed", "noid-charlie-devnet-seed"];
    for (let i = 0; i < seeds.length; i++) {
      const w = await generatePrivateWallet(seeds[i]);
      userWallets.push(w);
      console.log(`\n========== USER ${i + 1} WALLET ==========\n`, w);
    }
    assert(userWallets.length === 3, "Should have 3 user wallets");
    assert(relayerWallet.zk.publicKey !== "0", "Relayer PK must be non-zero");
    assert(userWallets[0].zk.publicKey !== userWallets[1].zk.publicKey, "Users must have distinct ZK keys");
  });

  // TEST 2
  await test("Encrypt and decrypt notes between users and relayer", async () => {
    const user  = userWallets[0];
    const note  = { amount: "100000000", randomness: randomField(), zkPublicKey: user.zk.publicKey };
    const plain = JSON.stringify(note);
    const encToRelayer = encryptMessage(plain, relayerWallet.privateWallet.publicKey);
    const decByRelayer = decryptMessage(encToRelayer, relayerWallet.privateWallet.privateKey);
    assert(decByRelayer === plain, "Relayer must decrypt correctly");
    const encToUser = encryptMessage(plain, user.privateWallet.publicKey);
    const decByUser = decryptMessage(encToUser, user.privateWallet.privateKey);
    assert(decByUser === plain, "User must decrypt correctly");
  });

  // TEST 3 — Read the pool resource address (set during initialize)
  await test("Pool is initialized — locked_balance == 0 and resource addr readable", async () => {
    const [balance] = await viewFunction("locked_balance", [], [MODULE_ADDR]);
    console.log(`\nPool locked_balance: ${balance}`);
    assert(typeof BigInt(balance as string) === "bigint", `Expected a number, got ${balance}`);

    // Fetch pool resource address
    const [resAddr] = await viewFunction("pool_resource_addr", [], [MODULE_ADDR]);
    poolResourceAddr = resAddr as string;
    console.log(`Pool resource account: ${poolResourceAddr}`);
    assert(poolResourceAddr.startsWith("0x"), "Resource addr must be a valid address");
    console.log("   (leftover balance from prior runs is normal)");
  });

  // TEST 4
  await test("Verify deposit proof off-chain (snarkjs)", async () => {
    const user = userWallets[0];
    const depositAmount = 100_000_000n, fee = 10_000_000n, userAmount = depositAmount - fee;
    const r1 = randomField(), r2 = randomField();
    const c1 = await createCommitment(userAmount.toString(), r1, user.zk.publicKey);
    const c2 = await createCommitment(fee.toString(),        r2, relayerWallet.zk.publicKey);
    const input = {
      depositAmount: depositAmount.toString(), pk2: relayerWallet.zk.publicKey,
      c1: c1.decimal, c2: c2.decimal,
      a1: userAmount.toString(), r1, pk1: user.zk.publicKey,
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

  // TEST 5 — Sponsored deposit: Alice sends APT, relayer pays gas
  await test(`Alice deposits 1 APT via SPONSORED tx on ${NET_LABEL}`, async () => {
    const user = userWallets[0];
    const depositAmount = 100_000_000n, fee = 10_000_000n, userAmount = depositAmount - fee;
    const r1 = randomField(), r2 = randomField();
    const c1 = await createCommitment(userAmount.toString(), r1, user.zk.publicKey);
    const c2 = await createCommitment(fee.toString(),        r2, relayerWallet.zk.publicKey);
    console.log("\n========== COMMITMENTS ==========\n", c1, "\n", c2);

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: userAmount.toString(), randomness: r1 }),
      user.privateWallet.publicKey
    );
    const encNote2 = encryptMessage(
      JSON.stringify({ amount: fee.toString(), randomness: r2 }),
      relayerWallet.privateWallet.publicKey
    );

    const { aBytes, bBytes, cBytes } = await proveDeposit(
      depositAmount, c1.decimal, c2.decimal, relayerWallet.zk.publicKey,
      userAmount, r1, user.zk.publicKey, fee, r2,
    );

    // Compute deposit roots against the actual on-chain tree state.
    // buildSyncTree includes all prior-run leaves from .noid-state.json.
    let root1: string, root2: string;
    {
      const syncTree = await buildSyncTree();
      syncTree.insert(BigInt(c1.decimal)); root1 = syncTree.root.toString();
      syncTree.insert(BigInt(c2.decimal)); root2 = syncTree.root.toString();
    }
    console.log(`\nDeposit roots: root1=${root1!}  root2=${root2!}`);

    console.log(`\nSubmitting SPONSORED deposit tx to ${NET_LABEL}...`);
    console.log(`  Alice (sender): ${aliceSigner.accountAddress}`);
    console.log(`  Relayer (fee payer): ${relayerSigner.accountAddress}`);

    // Alice is sender (she provides the APT).
    // Relayer is fee-payer (it pays gas via withFeePayer:true pattern).
    const receipt = await submitSponsored(
      aliceSigner,   // sender — Alice pays APT
      relayerSigner, // fee payer — relayer pays gas
      {
        function:      `${MODULE_ADDR}::pool::deposit`,
        typeArguments: [],
        functionArguments: [
          MODULE_ADDR,
          bytesToMoveArg(aBytes), bytesToMoveArg(bBytes), bytesToMoveArg(cBytes),
          u256ToMoveArg(BigInt(c1.decimal)),
          u256ToMoveArg(BigInt(c2.decimal)),
          depositAmount.toString(),
          u256ToMoveArg(BigInt(root1)),
          u256ToMoveArg(BigInt(root2)),
          Array.from(Buffer.from(encNote1)),
          Array.from(Buffer.from(encNote2)),
        ],
      },
      2_000_000,
    );
    console.log("\n========== DEPOSIT RECEIPT ==========\n", receipt);

    // Verify APT moved to the pool resource account, not the admin address
    const poolResBal = await aptos.getAccountAPTAmount({ accountAddress: poolResourceAddr });
    console.log(`\nPool resource account balance: ${poolResBal} octas`);
    assert(BigInt(poolResBal) >= depositAmount, `Pool resource balance should be >= ${depositAmount}`);

    const [lockBal] = await viewFunction("locked_balance", [], [MODULE_ADDR]);
    console.log(`Pool locked_balance: ${lockBal}`);
    assert(BigInt(lockBal as string) >= depositAmount, `locked_balance should be >= ${depositAmount}`);

    const [c1Exists] = await viewFunction("commitment_exists", [], [MODULE_ADDR, c1.decimal]);
    const [c2Exists] = await viewFunction("commitment_exists", [], [MODULE_ADDR, c2.decimal]);
    assert(c1Exists as boolean, "c1 should exist on-chain");
    assert(c2Exists as boolean, "c2 should exist on-chain");

    emittedNoteEvents.push({ poolId: "0", commitment: c1.decimal, encryptedNote: encNote1 });
    emittedNoteEvents.push({ poolId: "0", commitment: c2.decimal, encryptedNote: encNote2 });
    flushToPersisted();  // write to .noid-state.json so next run sees these leaves

    console.log("\n========== ALICE DECRYPTED ==========\n",
      decryptMessage(encNote1, user.privateWallet.privateKey));
    console.log("\n========== RELAYER DECRYPTED ==========\n",
      decryptMessage(encNote2, relayerWallet.privateWallet.privateKey));
  });

  // TEST 6
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
    for (const [pid, state] of Object.entries(poolStates)) {
      console.log(`Pool ${pid}: leaves=${state.tree.leaves.length}, root=${state.latestRoot}`);
    }
    assert(Object.keys(poolStates).length > 0, "At least one pool must exist");
  });

  // TEST 7
  await test("Deposit with duplicate commitment is rejected", async () => {
    const existingC1 = emittedNoteEvents[0].commitment;
    const r_new  = randomField();
    const c2_new = await createCommitment("10000000", r_new, relayerWallet.zk.publicKey);
    let threw = false;
    try {
      const { aBytes, bBytes, cBytes } = await proveDeposit(
        100_000_000n, existingC1, c2_new.decimal, relayerWallet.zk.publicKey,
        90_000_000n, randomField(), userWallets[0].zk.publicKey, 10_000_000n, r_new,
      );
      await submitSponsored(
        aliceSigner,
        relayerSigner,
        {
          function:      `${MODULE_ADDR}::pool::deposit`,
          typeArguments: [],
          functionArguments: [
            MODULE_ADDR,
            bytesToMoveArg(aBytes), bytesToMoveArg(bBytes), bytesToMoveArg(cBytes),
            u256ToMoveArg(BigInt(existingC1)), u256ToMoveArg(BigInt(c2_new.decimal)),
            "100000000",
            u256ToMoveArg(0n), u256ToMoveArg(0n),
            Array.from(Buffer.from("enc1")), Array.from(Buffer.from("enc2")),
          ],
        },
      );
    } catch { threw = true; }
    assert(threw, "Should throw on duplicate commitment");
  });

  // TEST 8
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
    const receiverCmx = await createCommitment(transferAmt.toString(), rReceiver, userWallets[1].zk.publicKey);
    const changeCmx   = await createCommitment(change.toString(),      rChange,   userWallets[0].zk.publicKey);
    const relayerCmx  = await createCommitment(fee.toString(),         rRelayer,  relayerWallet.zk.publicKey);

    const { calldata: { aBytes, bBytes, cBytes }, nullifier } = await proveTransfer(
      userWallets[0], relayerWallet, inputNote, state,
      [
        { amount: transferAmt.toString(), randomness: rReceiver, receiver: userWallets[1].zk.publicKey, commitment: receiverCmx.decimal },
        { amount: change.toString(),      randomness: rChange,   receiver: userWallets[0].zk.publicKey, commitment: changeCmx.decimal   },
        { amount: fee.toString(),         randomness: rRelayer,  receiver: relayerWallet.zk.publicKey,  commitment: relayerCmx.decimal   },
      ],
    );

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: transferAmt.toString(), randomness: rReceiver }),
      userWallets[1].privateWallet.publicKey
    );
    const encNote2 = encryptMessage(
      JSON.stringify({ amount: change.toString(), randomness: rChange }),
      userWallets[0].privateWallet.publicKey
    );
    const encNote3 = encryptMessage(
      JSON.stringify({ amount: fee.toString(), randomness: rRelayer }),
      relayerWallet.privateWallet.publicKey
    );

    // Compute output roots from the full synced tree (includes prior-run leaves)
    let tRoot1: string, tRoot2: string, tRoot3: string;
    {
      const traTree = await buildSyncTree();
      traTree.insert(BigInt(receiverCmx.decimal)); tRoot1 = traTree.root.toString();
      traTree.insert(BigInt(changeCmx.decimal));   tRoot2 = traTree.root.toString();
      traTree.insert(BigInt(relayerCmx.decimal));  tRoot3 = traTree.root.toString();
    }

    console.log(`\nSubmitting transfer tx (relayer single-signer) to ${NET_LABEL}...`);
    const receipt = await submitRelayer(relayerSigner, {
      function:      `${MODULE_ADDR}::pool::transfer`,
      typeArguments: [],
      functionArguments: [
        MODULE_ADDR,
        bytesToMoveArg(aBytes), bytesToMoveArg(bBytes), bytesToMoveArg(cBytes),
        ["1","0","0","0"],
        [inputNote.poolId,"0","0","0"],
        [state.tree.root.toString(),"0","0","0"],
        [nullifier,"0","0","0"],
        ["1","1","1"],
        [receiverCmx.decimal, changeCmx.decimal, relayerCmx.decimal],
        [tRoot1, tRoot2, tRoot3],
        Array.from(Buffer.from(encNote1)),
        Array.from(Buffer.from(encNote2)),
        Array.from(Buffer.from(encNote3)),
      ],
    });
    console.log("\n========== TRANSFER RECEIPT ==========\n", receipt);

    const [nullSpent] = await viewFunction("is_nullifier_spent", [], [MODULE_ADDR, nullifier]);
    assert(nullSpent as boolean, "Alice's nullifier should be spent");
    const [bobExists] = await viewFunction("commitment_exists", [], [MODULE_ADDR, receiverCmx.decimal]);
    assert(bobExists as boolean, "Bob's commitment should exist on-chain");

    emittedNullifierEvents.push({ nullifier });
    emittedNoteEvents.push({ poolId: "0", commitment: receiverCmx.decimal, encryptedNote: encNote1 });
    emittedNoteEvents.push({ poolId: "0", commitment: changeCmx.decimal,   encryptedNote: encNote2 });
    emittedNoteEvents.push({ poolId: "0", commitment: relayerCmx.decimal,  encryptedNote: encNote3 });
    flushToPersisted();  // write to .noid-state.json so next run sees these leaves

    console.log(`\n   Bob receives: ${transferAmt} octas\n   Alice change: ${change} octas`);
  });

  // TEST 9
  await test("Double-spend (same nullifier) is rejected", async () => {
    assert(emittedNullifierEvents.length > 0, "Need a spent nullifier");
    const spentNull = emittedNullifierEvents[0].nullifier;
    let threw = false;
    try {
      const fakeC = await createCommitment("100", randomField(), userWallets[0].zk.publicKey);
      await submitRelayer(relayerSigner, {
        function:      `${MODULE_ADDR}::pool::transfer`,
        typeArguments: [],
        functionArguments: [
          MODULE_ADDR,
          bytesToMoveArg(new Uint8Array(64)),
          bytesToMoveArg(new Uint8Array(128)),
          bytesToMoveArg(new Uint8Array(64)),
          ["1","0","0","0"], ["0","0","0","0"], ["0","0","0","0"],
          [spentNull,"0","0","0"],
          ["1","0","0"], [fakeC.decimal,"0","0"],
          ["0","0","0"],
          Array.from(Buffer.from("enc1")),
          Array.from(Buffer.from("enc2")),
          Array.from(Buffer.from("enc3")),
        ],
      });
    } catch { threw = true; }
    assert(threw, "Should reject double-spend");
  });

  // TEST 10
  await test("Rebuild wallet state after transfer", async () => {
    await rebuildWalletState();
    console.log("\n========== WALLET STATES AFTER TRANSFER ==========");
    for (const [name, ws] of Object.entries(walletStates)) {
      console.log(`  ${name}: notes=${ws.notes.length}, balance=${ws.balance}`);
    }
    assert(walletStates["bob"].notes.length >= 1, "Bob must have at least 1 note");
  });

  // TEST 11 — Bob withdraws: relayer submits single-signer, pool signer_cap sends APT
  await test(`Bob withdraws to his public Aptos address on ${NET_LABEL}`, async () => {
    await rebuildWalletState();
    const inputNote = walletStates["bob"].notes[0];
    if (!inputNote) { console.log("   (skipped — Bob has no notes)"); return; }
    console.log("\n========== WITHDRAW INPUT NOTE ==========\n", inputNote);

    const state      = poolStates[inputNote.poolId];
    const inputAmt   = BigInt(inputNote.amount);
    const withdrawAmt = inputAmt * 8n / 10n;
    const fee         = 1_000_000n;
    const change      = inputAmt - withdrawAmt - fee;

    assert(change >= 0n, "Change must be non-negative");
    assert(withdrawAmt > 0n, "Withdraw amount must be positive");

    const rChange  = randomField();
    const rRelayer = randomField();
    const changeCmx  = change > 0n
      ? await createCommitment(change.toString(),   rChange,  userWallets[1].zk.publicKey)
      : null;
    const relayerCmx = fee > 0n
      ? await createCommitment(fee.toString(),      rRelayer, relayerWallet.zk.publicKey)
      : null;

    // Convert Bob's Aptos address to a BN254 scalar field element.
    // Aptos addresses are 32 bytes and CAN exceed the BN254 prime P.
    // The Move verifier deserializes each public signal as Fr (requires value < P).
    // The circom circuit also works mod P automatically.
    // So BOTH sides must use address % P — not the raw u256.
    // The Move pool.move withdraw() must also do address_to_u256(receiver) % P
    // before packing into sigs (see fix in pool.move address_to_u256).
    const BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const receiverU256 = BigInt("0x" + bobSigner.accountAddress.toString().replace("0x", ""));
    const receiverDecimal = (receiverU256 % BN254_P).toString();
    console.log(`\nBob addr u256: ${receiverU256}, mod P: ${receiverDecimal}`);

    const { calldata: { aBytes, bBytes, cBytes }, nullifier } = await proveWithdraw(
      userWallets[1], relayerWallet, receiverDecimal,
      inputNote, state, withdrawAmt,
      changeCmx  ? { amount: change.toString(),   randomness: rChange,  commitment: changeCmx.decimal  } : null,
      relayerCmx ? { amount: fee.toString(),       randomness: rRelayer, commitment: relayerCmx.decimal } : null,
    );

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: change.toString(), randomness: rChange }),
      userWallets[1].privateWallet.publicKey
    );
    const encNote2 = encryptMessage(
      JSON.stringify({ amount: fee.toString(), randomness: rRelayer }),
      relayerWallet.privateWallet.publicKey
    );

    // Compute output roots from the full synced tree (includes prior-run leaves)
    const wRoots = ["0", "0"];
    {
      const witTree = await buildSyncTree();
      if (changeCmx)  { witTree.insert(BigInt(changeCmx.decimal));  wRoots[0] = witTree.root.toString(); }
      if (relayerCmx) { witTree.insert(BigInt(relayerCmx.decimal)); wRoots[1] = witTree.root.toString(); }
    }

    const balanceBefore = await aptos.getAccountAPTAmount({
      accountAddress: bobSigner.accountAddress,
    });
    console.log(`\nBob APT before withdraw: ${balanceBefore}`);

    const poolBalBefore = await aptos.getAccountAPTAmount({ accountAddress: poolResourceAddr });
    console.log(`Pool resource balance before: ${poolBalBefore}`);

    console.log(`\nSubmitting withdraw tx (relayer single-signer) to ${NET_LABEL}...`);
    // Relayer submits as single-signer — no fee-payer needed here since relayer IS the sender.
    // The withdraw() Move function uses pool_signer_cap internally to send APT to Bob.
    const receipt = await submitRelayer(relayerSigner, {
      function:      `${MODULE_ADDR}::pool::withdraw`,
      typeArguments: [],
      functionArguments: [
        MODULE_ADDR,
        bytesToMoveArg(aBytes), bytesToMoveArg(bBytes), bytesToMoveArg(cBytes),
        ["1","0","0","0"],
        [inputNote.poolId,"0","0","0"],
        [state.tree.root.toString(),"0","0","0"],
        [nullifier,"0","0","0"],
        bobSigner.accountAddress.toString(),
        withdrawAmt.toString(),
        [changeCmx ? "1" : "0", relayerCmx ? "1" : "0"],
        [changeCmx?.decimal ?? "0", relayerCmx?.decimal ?? "0"],
        wRoots,
        Array.from(Buffer.from(encNote1)),
        Array.from(Buffer.from(encNote2)),
      ],
    });
    console.log("\n========== WITHDRAW RECEIPT ==========\n", receipt);

    const [nullSpent] = await viewFunction("is_nullifier_spent", [], [MODULE_ADDR, nullifier]);
    assert(nullSpent as boolean, "Bob's nullifier should be spent");

    const [lockBal]    = await viewFunction("locked_balance", [], [MODULE_ADDR]);
    const balanceAfter = await aptos.getAccountAPTAmount({ accountAddress: bobSigner.accountAddress });
    const poolBalAfter = await aptos.getAccountAPTAmount({ accountAddress: poolResourceAddr });

    console.log(`\nPool locked_balance: ${lockBal}`);
    console.log(`Pool resource balance: ${poolBalBefore} → ${poolBalAfter}`);
    console.log(`Bob APT: ${balanceBefore} → ${balanceAfter}`);

    assert(
      BigInt(balanceAfter) > BigInt(balanceBefore),
      `Bob's balance should increase. Before=${balanceBefore} After=${balanceAfter}`
    );
    assert(
      BigInt(poolBalAfter) < BigInt(poolBalBefore),
      `Pool resource balance should decrease. Before=${poolBalBefore} After=${poolBalAfter}`
    );

    emittedNullifierEvents.push({ nullifier });
    if (changeCmx)  emittedNoteEvents.push({ poolId: "0", commitment: changeCmx.decimal,  encryptedNote: encNote1 });
    if (relayerCmx) emittedNoteEvents.push({ poolId: "0", commitment: relayerCmx.decimal, encryptedNote: encNote2 });
    flushToPersisted();  // write to .noid-state.json so next run sees these leaves
  });

  // TEST 12
  await test("Withdraw with zeroed proof bytes is rejected", async () => {
    let threw = false;
    try {
      await submitRelayer(relayerSigner, {
        function:      `${MODULE_ADDR}::pool::withdraw`,
        typeArguments: [],
        functionArguments: [
          MODULE_ADDR,
          bytesToMoveArg(new Uint8Array(64)),
          bytesToMoveArg(new Uint8Array(128)),
          bytesToMoveArg(new Uint8Array(64)),
          ["1","0","0","0"], ["0","0","0","0"], ["0","0","0","0"],
          [randomField(),"0","0","0"],
          bobSigner.accountAddress.toString(),
          "1000000",
          ["0","0"], ["0","0"],
          ["0","0"],
          Array.from(Buffer.from("enc1")),
          Array.from(Buffer.from("enc2")),
        ],
      });
    } catch { threw = true; }
    assert(threw, "Zeroed proof must be rejected");
  });

  // TEST 13
  await test("Poseidon domain-separator consistency (off-chain smoke test)", async () => {
    const poseidon = await getPoseidon();
    const sk = "12345678901234567890";
    const pk = poseidon.F.toString(poseidon([BigInt(3), BigInt(sk)]));
    assert(BigInt(pk) > 0n, "PK must be non-zero");
    const c  = (await createCommitment("100000000", "999888777", pk)).decimal;
    assert(BigInt(c) > 0n, "Commitment must be non-zero");
    const n  = poseidon.F.toString(poseidon([BigInt(2), BigInt(c), BigInt("999888777"), BigInt(sk)]));
    assert(BigInt(n) > 0n, "Nullifier must be non-zero");
    const c2 = (await createCommitment("100000000", "999888778", pk)).decimal;
    assert(c !== c2, "Different r must yield different commitment");
    console.log(`\n   sk=${sk} pk=${pk} cmx=${c} nullifier=${n}`);
  });

  // TEST 14
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

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log(`  TEST RESULTS  —  Aptos ${NET_LABEL}`);
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