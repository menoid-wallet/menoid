/**
 * noid_local.test.ts — end-to-end test of the Aptos noid pool on a LOCAL node,
 * using the new architecture:
 *
 *   • The Merkle root is computed by the `new_root` circom circuit and verified
 *     on-chain (no native Poseidon, no caller-supplied roots).
 *   • deposit / transfer / withdraw are permissionless.
 *   • A `relayer` task-queue module sits in front of the pool:
 *       - user submits a task (deposit escrows the APT into the task),
 *       - the relayer (or anyone) attaches one `new_root` proof per output
 *         commitment and forwards the task to the pool.
 *
 * Flow under test:
 *   deposit : alice submit_deposit_task (transfers APT) → relayer process → pool
 *   transfer: submit_transfer_task → relayer process → pool   (relayer-signed)
 *   withdraw: submit_withdraw_task → relayer process → pool    (relayer-signed, APT to receiver)
 *
 * Prereq: a local node is running (aptos node run-local-testnet --with-faucet).
 */

import {
  Aptos, AptosConfig, Network, Account, Ed25519PrivateKey,
  MoveVector, U256, U8, U64,
} from "@aptos-labs/ts-sdk";
// @ts-ignore — snarkjs ships no type declarations
import * as snarkjs from "snarkjs";
// @ts-ignore — circomlibjs ships no type declarations
import { buildPoseidon } from "circomlibjs";
// @ts-ignore
import { IncrementalMerkleTree } from "@zk-kit/incremental-merkle-tree";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { randomBytes } from "crypto";

import { generatePrivateWallet, GeneratedWallet } from "../helpers/wallets";
import { encryptMessage, decryptMessage } from "../helpers/encryption";
import { createCommitment } from "../helpers/commitments";

// ─── Config ─────────────────────────────────────────────────────────────────

const NODE_URL    = "http://127.0.0.1:8080/v1";
const FAUCET_URL  = "http://127.0.0.1:8081";
const CIRCUIT_DIR = path.join(__dirname, "../zk_build");
const APTOS_DIR   = path.join(__dirname, "..");
const DEPTH = 20;

function loadEnv() {
  const envPath = path.join(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}
loadEnv();

const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY!;
const MODULE_ADDR = process.env.NOID_MODULE_ADDR!;

const aptos = new Aptos(new AptosConfig({
  network: Network.LOCAL, fullnode: NODE_URL, faucet: FAUCET_URL,
}));

// ─── Poseidon + tree math ────────────────────────────────────────────────────

let _poseidon: any;
async function getPoseidon() { if (!_poseidon) _poseidon = await buildPoseidon(); return _poseidon; }

let ZEROS: bigint[] = [];
async function computeZeros() {
  const p = await getPoseidon();
  const H = (a: bigint, b: bigint) => BigInt(p.F.toString(p([a, b])));
  let z = 0n; ZEROS = [];
  for (let i = 0; i < DEPTH; i++) { ZEROS.push(z); z = H(z, z); }
}

// Off-chain relayer view of the contract's filled_subtrees (kept in lockstep).
let relayerSubtrees: bigint[] = [];
let relayerNextIdx = 0;

// ─── Global note/tree state (for membership proofs) ──────────────────────────

interface Note { poolId: string; commitment: string; amount: string; randomness: string; leafIndex: number; root: string; }
interface WalletState { wallet: GeneratedWallet; notes: Note[]; balance: bigint; }

const poolStates: Record<string, { tree: any; }> = {};
const walletStates: Record<string, WalletState> = {};
const spentNullifiers = new Set<string>();
const emittedNoteEvents: Array<{ poolId: string; commitment: string; encryptedNote: string }> = [];
const emittedNullifierEvents: Array<{ nullifier: string }> = [];

async function rebuildWalletState() {
  const p = await getPoseidon();
  const hash = (inp: bigint[]) => BigInt(p.F.toString(p(inp)));
  for (const k of Object.keys(poolStates)) delete poolStates[k];
  for (const k of Object.keys(walletStates)) { walletStates[k].notes = []; walletStates[k].balance = 0n; }
  spentNullifiers.clear();
  for (const ev of emittedNullifierEvents) spentNullifiers.add(ev.nullifier);

  for (const ev of emittedNoteEvents) {
    if (!poolStates[ev.poolId]) poolStates[ev.poolId] = { tree: new IncrementalMerkleTree(hash, DEPTH, 0n, 2) };
    const st = poolStates[ev.poolId];
    st.tree.insert(BigInt(ev.commitment));
    const leafIndex = st.tree.leaves.length - 1;
    const root = st.tree.root.toString();
    for (const [, ws] of Object.entries(walletStates)) {
      try {
        const parsed = JSON.parse(decryptMessage(ev.encryptedNote, ws.wallet.privateWallet.privateKey));
        const nullifier = p.F.toString(p([2n, BigInt(ev.commitment), BigInt(parsed.randomness), BigInt(ws.wallet.zk.secretKey)]));
        if (spentNullifiers.has(nullifier)) continue;
        ws.notes.push({ poolId: ev.poolId, commitment: ev.commitment, amount: parsed.amount, randomness: parsed.randomness, leafIndex, root });
        ws.balance += BigInt(parsed.amount);
      } catch (_) {}
    }
  }
}

// ─── Proof helpers ───────────────────────────────────────────────────────────

function cpath(name: string, ext: "wasm" | "zkey") { return path.join(CIRCUIT_DIR, `${name}.${ext}`); }
function pad3<T>(arr: T[], fill: T): T[] { const a = arr.slice(); while (a.length < 3) a.push(fill); return a; }
function writeLE(buf: Uint8Array, v: bigint, off: number, len: number) {
  for (let i = off; i < off + len; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
}
function proofToBytes(proof: any) {
  const g1 = (pt: string[]) => { const b = new Uint8Array(64); writeLE(b, BigInt(pt[0]), 0, 32); writeLE(b, BigInt(pt[1]), 32, 32); return b; };
  const g2 = (pt: string[][]) => { const b = new Uint8Array(128); writeLE(b, BigInt(pt[0][0]), 0, 32); writeLE(b, BigInt(pt[0][1]), 32, 32); writeLE(b, BigInt(pt[1][0]), 64, 32); writeLE(b, BigInt(pt[1][1]), 96, 32); return b; };
  return { aBytes: g1(proof.pi_a), bBytes: g2(proof.pi_b), cBytes: g1(proof.pi_c) };
}

async function proveDeposit(depositAmount: bigint, c1: string, c2: string, relayerPk: string, a1: bigint, r1: string, pk1: string, a2: bigint, r2: string) {
  const input = { depositAmount: depositAmount.toString(), c1, c2, a1: a1.toString(), r1, pk1, a2: a2.toString(), r2, pk2: relayerPk };
  const { proof } = await snarkjs.groth16.fullProve(input, cpath("deposit_proof_js/deposit_proof", "wasm"), cpath("deposit_proof_final", "zkey"));
  return proofToBytes(proof);
}

async function proveTransfer(senderWallet: GeneratedWallet, relayer: GeneratedWallet, inputNote: Note, tree: any, outputs: Array<{ amount: string; randomness: string; receiver: string; commitment: string }>) {
  const p = await getPoseidon();
  const mp = tree.createProof(inputNote.leafIndex);
  const nullifier = p.F.toString(p([2n, BigInt(inputNote.commitment), BigInt(inputNote.randomness), BigInt(senderWallet.zk.secretKey)]));
  const input = {
    sk: senderWallet.zk.secretKey, pk: senderWallet.zk.publicKey, relayer: relayer.zk.publicKey,
    enabled: [1, 0, 0, 0], c_ins: [inputNote.commitment, "0", "0", "0"], a_ins: [inputNote.amount, "0", "0", "0"], r_ins: [inputNote.randomness, "0", "0", "0"],
    roots: [tree.root.toString(), "0", "0", "0"],
    pathElements: [mp.siblings.map((x: bigint[]) => x[0].toString()), Array(20).fill("0"), Array(20).fill("0"), Array(20).fill("0")],
    pathIndices: [mp.pathIndices, Array(20).fill(0), Array(20).fill(0), Array(20).fill(0)],
    nullifiers: [nullifier, "0", "0", "0"],
    // Pad outputs to the circuit's fixed 3 slots. The circuit enforces
    // receivers[2] === relayer unconditionally, so slot 2's receiver is always the relayer.
    output_enabled: pad3(outputs.map(() => 1), 0),
    c_outs:    pad3(outputs.map(o => o.commitment), "0"),
    a_outs:    pad3(outputs.map(o => o.amount), "0"),
    r_outs:    pad3(outputs.map(o => o.randomness), "0"),
    receivers: (() => { const r = pad3(outputs.map(o => o.receiver), relayer.zk.publicKey); r[2] = relayer.zk.publicKey; return r; })(),
  };
  const { proof } = await snarkjs.groth16.fullProve(input, cpath("transfer_proof_js/transfer_proof", "wasm"), cpath("transfer_proof_final", "zkey"));
  return { calldata: proofToBytes(proof), nullifier };
}

async function proveWithdraw(senderWallet: GeneratedWallet, relayer: GeneratedWallet, receiverDecimal: string, inputNote: Note, tree: any, withdrawAmount: bigint, changeOutput: any, relayerOutput: any) {
  const p = await getPoseidon();
  const mp = tree.createProof(inputNote.leafIndex);
  const nullifier = p.F.toString(p([2n, BigInt(inputNote.commitment), BigInt(inputNote.randomness), BigInt(senderWallet.zk.secretKey)]));
  const input = {
    sk: senderWallet.zk.secretKey, pk: senderWallet.zk.publicKey, receiver: receiverDecimal, changeReceiver: senderWallet.zk.publicKey, relayer: relayer.zk.publicKey,
    enabled: [1, 0, 0, 0], c_ins: [inputNote.commitment, "0", "0", "0"], a_ins: [inputNote.amount, "0", "0", "0"], r_ins: [inputNote.randomness, "0", "0", "0"],
    roots: [tree.root.toString(), "0", "0", "0"],
    pathElements: [mp.siblings.map((x: bigint[]) => x[0].toString()), Array(20).fill("0"), Array(20).fill("0"), Array(20).fill("0")],
    pathIndices: [mp.pathIndices, Array(20).fill(0), Array(20).fill(0), Array(20).fill(0)],
    nullifiers: [nullifier, "0", "0", "0"], withdrawAmount: withdrawAmount.toString(),
    out_enabled: [changeOutput ? 1 : 0, relayerOutput ? 1 : 0],
    c_outs: [changeOutput?.commitment ?? "0", relayerOutput?.commitment ?? "0"], a_outs: [changeOutput?.amount ?? "0", relayerOutput?.amount ?? "0"], r_outs: [changeOutput?.randomness ?? "0", relayerOutput?.randomness ?? "0"],
    receivers: [senderWallet.zk.publicKey, relayer.zk.publicKey],
  };
  const { proof } = await snarkjs.groth16.fullProve(input, cpath("withdraw_proof_js/withdraw_proof", "wasm"), cpath("withdraw_proof_final", "zkey"));
  return { calldata: proofToBytes(proof), nullifier };
}

/** Poseidon fold of the subtrees — must match SubtreesHash in new_root.circom. */
function foldSubtrees(arr: bigint[], p: any): bigint {
  let acc = arr[0];
  for (let i = 1; i < DEPTH; i++) acc = BigInt(p.F.toString(p([acc, arr[i]])));
  return acc;
}
/** Off-chain filled-subtree insert — advances the relayer's subtree view. */
function insertSubtrees(sub: bigint[], leaf: bigint, idx: number, p: any): bigint[] {
  const ns = sub.slice();
  let cur = leaf;
  for (let i = 0; i < DEPTH; i++) {
    if (((idx >> i) & 1) === 0) { ns[i] = cur; cur = BigInt(p.F.toString(p([cur, ZEROS[i]]))); }
    else { cur = BigInt(p.F.toString(p([sub[i], cur]))); }
  }
  return ns;
}

/** Generate the new_root proof for one commitment, advancing the relayer's subtree view. */
async function proveNewRootFor(commitmentDecimal: string) {
  const p = await getPoseidon();
  const oldHash = foldSubtrees(relayerSubtrees, p);
  const input = {
    oldSubtreesHash: oldHash.toString(),
    commitment: commitmentDecimal,
    leafIndex: String(relayerNextIdx),
    oldSubtrees: relayerSubtrees.map(String),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, cpath("new_root_js/new_root", "wasm"), cpath("new_root_final", "zkey"));
  const newRoot = publicSignals[0] as string;
  const newSubtreesHash = publicSignals[1] as string;
  relayerSubtrees = insertSubtrees(relayerSubtrees, BigInt(commitmentDecimal), relayerNextIdx, p);
  relayerNextIdx += 1;
  const { aBytes, bBytes, cBytes } = proofToBytes(proof);
  return { aBytes, bBytes, cBytes, newRoot, newSubtreesHash };
}

/** Build the parallel new_root-proof arrays for a list of commitments (insertion order). */
async function buildNewRootProofs(commitments: string[]) {
  const nr_a: number[][] = [], nr_b: number[][] = [], nr_c: number[][] = [], nr_roots: string[] = [], nr_subhashes: string[] = [];
  for (const c of commitments) {
    const pr = await proveNewRootFor(c);
    nr_a.push(Array.from(pr.aBytes)); nr_b.push(Array.from(pr.bBytes)); nr_c.push(Array.from(pr.cBytes));
    nr_roots.push(pr.newRoot); nr_subhashes.push(pr.newSubtreesHash);
  }
  return { nr_a, nr_b, nr_c, nr_roots, nr_subhashes };
}

// ── BCS arg builders for the new_root proof vectors ──
const vvU8  = (x: number[][])  => new MoveVector(x.map((b) => MoveVector.U8(b)));
const vU256 = (x: string[])    => new MoveVector(x.map((v) => new U256(BigInt(v))));
const vvU256= (x: string[][])  => new MoveVector(x.map((inner) => new MoveVector(inner.map((v) => new U256(BigInt(v))))));

// ─── VK encoding ─────────────────────────────────────────────────────────────

function g1ToBytes(pt: string[]) { const b = new Uint8Array(64); writeLE(b, BigInt(pt[0]), 0, 32); writeLE(b, BigInt(pt[1]), 32, 32); return Array.from(b); }
function g2ToBytes(pt: string[][]) { const b = new Uint8Array(128); writeLE(b, BigInt(pt[0][0]), 0, 32); writeLE(b, BigInt(pt[0][1]), 32, 32); writeLE(b, BigInt(pt[1][0]), 64, 32); writeLE(b, BigInt(pt[1][1]), 96, 32); return Array.from(b); }
function icToBytes(ic: string[][]) { const out: number[] = []; for (const pt of ic) out.push(...g1ToBytes(pt)); return out; }
function loadVK(name: string) { return JSON.parse(fs.readFileSync(path.join(CIRCUIT_DIR, name), "utf8")); }

// ─── tx helper ───────────────────────────────────────────────────────────────

async function exec(signer: Account, func: string, args: any[]): Promise<void> {
  const tx = await aptos.transaction.build.simple({
    sender: signer.accountAddress,
    data: { function: `${MODULE_ADDR}::${func}` as `${string}::${string}::${string}`, typeArguments: [], functionArguments: args },
  });
  const pending = await aptos.signAndSubmitTransaction({ signer, transaction: tx });
  const r = await aptos.waitForTransaction({ transactionHash: pending.hash });
  if (!(r as any).success) throw new Error(`tx ${func} failed: ${pending.hash}`);
}
async function view(func: string, args: any[]): Promise<any[]> {
  return await aptos.view({ payload: { function: `${MODULE_ADDR}::${func}` as `${string}::${string}::${string}`, typeArguments: [], functionArguments: args } });
}
function randomField(): string {
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  let r: bigint; do { r = BigInt("0x" + randomBytes(32).toString("hex")); } while (r >= P);
  return r.toString();
}

// ─── Test runner ─────────────────────────────────────────────────────────────

const results: Array<{ name: string; ok: boolean; err?: string }> = [];
async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`▶  ${name} ... `);
  try { await fn(); results.push({ name, ok: true }); console.log("✅"); }
  catch (e: any) { results.push({ name, ok: false, err: e.message }); console.log("❌\n   " + e.message); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await computeZeros();
  relayerSubtrees = ZEROS.slice();
  relayerNextIdx = 0;

  const deployer = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(DEPLOYER_PK) });
  assert(deployer.accountAddress.toString() === MODULE_ADDR, `deployer ${deployer.accountAddress} != MODULE_ADDR ${MODULE_ADDR}`);

  const relayerWallet = await generatePrivateWallet(DEPLOYER_PK + "Menoid wallet");
  const alice  = await generatePrivateWallet("noid-alice-aptos-seed");
  const bob    = await generatePrivateWallet("noid-bob-aptos-seed");
  walletStates["alice"]   = { wallet: alice,         notes: [], balance: 0n };
  walletStates["bob"]     = { wallet: bob,           notes: [], balance: 0n };
  walletStates["relayer"] = { wallet: relayerWallet, notes: [], balance: 0n };

  // Aptos accounts: aliceAcct submits deposit (pays), relayerAcct processes, bob receives.
  const aliceAcct   = Account.generate();
  const relayerAcct = Account.generate();
  const bobAcct     = Account.generate();

  console.log("Deployer:", deployer.accountAddress.toString());

  // ── Fund accounts (direct faucet POST; SDK fundAccount mis-targets the port) ──
  const fundViaFaucet = async (addr: string) => {
    const res = await fetch(`${FAUCET_URL}/mint?amount=1000000000&address=${addr}`, { method: "POST" });
    if (!res.ok) throw new Error(`faucet ${addr}: ${res.status}`);
  };
  await test("Fund accounts from local faucet", async () => {
    for (const a of [deployer.accountAddress, aliceAcct.accountAddress, relayerAcct.accountAddress, bobAcct.accountAddress]) {
      await fundViaFaucet(a.toString());
    }
    await new Promise((r) => setTimeout(r, 1500));
  });

  // ── Publish + initialize ──
  await test("Publish package to local node", async () => {
    execSync(
      `aptos move publish --url ${NODE_URL} --private-key ${DEPLOYER_PK} --assume-yes --skip-fetch-latest-git-deps --max-gas 2000000`,
      { cwd: APTOS_DIR, stdio: "pipe" },
    );
  });

  await test("Register verification keys (incl. new_root)", async () => {
    const dep = loadVK("deposit_verification_key.json");
    const tra = loadVK("transfer_verification_key.json");
    const wit = loadVK("withdraw_verification_key.json");
    const nr  = loadVK("new_root_verification_key.json");
    await exec(deployer, "verifier::initialize_vks", [
      g1ToBytes(dep.vk_alpha_1), g2ToBytes(dep.vk_beta_2), g2ToBytes(dep.vk_gamma_2), g2ToBytes(dep.vk_delta_2), icToBytes(dep.IC),
      g1ToBytes(tra.vk_alpha_1), g2ToBytes(tra.vk_beta_2), g2ToBytes(tra.vk_gamma_2), g2ToBytes(tra.vk_delta_2), icToBytes(tra.IC),
      g1ToBytes(wit.vk_alpha_1), g2ToBytes(wit.vk_beta_2), g2ToBytes(wit.vk_gamma_2), g2ToBytes(wit.vk_delta_2), icToBytes(wit.IC),
      g1ToBytes(nr.vk_alpha_1),  g2ToBytes(nr.vk_beta_2),  g2ToBytes(nr.vk_gamma_2),  g2ToBytes(nr.vk_delta_2),  icToBytes(nr.IC),
    ]);
  });

  await test("Initialize pool + relayer queue", async () => {
    await exec(deployer, "pool::initialize", [
      new U256(BigInt(relayerWallet.zk.publicKey)),
      deployer.accountAddress.toString(),
      MoveVector.U8(Array.from(Buffer.from("noid-pool-seed-v1"))),
    ]);
    await exec(deployer, "relayer::initialize", []);
    const [bal] = await view("pool::locked_balance", [MODULE_ADDR]);
    assert(BigInt(bal as string) === 0n, "fresh pool locked_balance must be 0");
  });

  // ── DEPOSIT via relayer task ──
  let depositAmount = 100_000_000n, fee = 10_000_000n;
  await test("Deposit: alice submits task → relayer processes", async () => {
    const userAmount = depositAmount - fee;
    const r1 = randomField(), r2 = randomField();
    const c1 = await createCommitment(userAmount.toString(), r1, alice.zk.publicKey);
    const c2 = await createCommitment(fee.toString(), r2, relayerWallet.zk.publicKey);
    const enc1 = encryptMessage(JSON.stringify({ amount: userAmount.toString(), randomness: r1 }), alice.privateWallet.publicKey);
    const enc2 = encryptMessage(JSON.stringify({ amount: fee.toString(), randomness: r2 }), relayerWallet.privateWallet.publicKey);

    const { aBytes, bBytes, cBytes } = await proveDeposit(depositAmount, c1.decimal, c2.decimal, relayerWallet.zk.publicKey, userAmount, r1, alice.zk.publicKey, fee, r2);

    // 1) alice submits the task (escrows depositAmount)
    await exec(aliceAcct, "relayer::submit_deposit_task", [
      MODULE_ADDR,
      Array.from(aBytes), Array.from(bBytes), Array.from(cBytes),
      new U256(BigInt(c1.decimal)), new U256(BigInt(c2.decimal)), depositAmount.toString(),
      Array.from(Buffer.from(enc1)), Array.from(Buffer.from(enc2)),
    ]);

    // 2) relayer builds new_root proofs for [c1, c2] and processes the task
    const nrp = await buildNewRootProofs([c1.decimal, c2.decimal]);
    await exec(relayerAcct, "relayer::process_deposit_task", [
      MODULE_ADDR, MODULE_ADDR, "0",
      vvU8(nrp.nr_a), vvU8(nrp.nr_b), vvU8(nrp.nr_c), vU256(nrp.nr_roots), vU256(nrp.nr_subhashes),
    ]);

    const [bal] = await view("pool::locked_balance", [MODULE_ADDR]);
    assert(BigInt(bal as string) === depositAmount, `locked_balance ${bal} != ${depositAmount}`);
    const [c1ex] = await view("pool::commitment_exists", [MODULE_ADDR, c1.decimal]);
    assert(c1ex as boolean, "c1 must exist on-chain");

    emittedNoteEvents.push({ poolId: "0", commitment: c1.decimal, encryptedNote: enc1 });
    emittedNoteEvents.push({ poolId: "0", commitment: c2.decimal, encryptedNote: enc2 });
  });

  // ── TRANSFER via relayer task (alice → bob) ──
  await test("Transfer: alice → bob via relayer task", async () => {
    await rebuildWalletState();
    const inputNote = walletStates["alice"].notes[0];
    assert(!!inputNote, "alice must have a note");
    const tree = poolStates[inputNote.poolId].tree;

    // 1 output (full amount to bob). The transfer ZK proof itself is heavy
    // (19 public signals / 20 IC points), and Aptos cannot hash signals on-chain
    // (no native Poseidon), so its per-tx execution budget leaves room for exactly
    // ONE new_root insert. (deposit's proof is light → it fits 2 inserts.)
    const inAmt = BigInt(inputNote.amount);
    const transferAmt = inAmt;
    const rR = randomField();
    const receiverCmx = await createCommitment(transferAmt.toString(), rR, bob.zk.publicKey);

    const { calldata, nullifier } = await proveTransfer(alice, relayerWallet, inputNote, tree, [
      { amount: transferAmt.toString(), randomness: rR, receiver: bob.zk.publicKey, commitment: receiverCmx.decimal },
    ]);
    const enc1 = encryptMessage(JSON.stringify({ amount: transferAmt.toString(), randomness: rR }), bob.privateWallet.publicKey);
    const dummy = encryptMessage(JSON.stringify({ amount: "0", randomness: "0" }), relayerWallet.privateWallet.publicKey);

    // submit transfer task (output_enabled = [1,0,0])
    await exec(aliceAcct, "relayer::submit_transfer_task", [
      MODULE_ADDR,
      Array.from(calldata.aBytes), Array.from(calldata.bBytes), Array.from(calldata.cBytes),
      MoveVector.U8([1, 0, 0, 0]),
      new MoveVector([0, 0, 0, 0].map((v) => new U64(v))),
      vU256([tree.root.toString(), "0", "0", "0"]),
      vU256([nullifier, "0", "0", "0"]),
      MoveVector.U8([1, 0, 0]),
      vU256([receiverCmx.decimal, "0", "0"]),
      Array.from(Buffer.from(enc1)), Array.from(Buffer.from(dummy)), Array.from(Buffer.from(dummy)),
    ]);

    const nrp = await buildNewRootProofs([receiverCmx.decimal]);
    await exec(relayerAcct, "relayer::process_transfer_task", [
      MODULE_ADDR, MODULE_ADDR, "0",
      vvU8(nrp.nr_a), vvU8(nrp.nr_b), vvU8(nrp.nr_c), vU256(nrp.nr_roots), vU256(nrp.nr_subhashes),
    ]);

    emittedNullifierEvents.push({ nullifier });
    emittedNoteEvents.push({ poolId: "0", commitment: receiverCmx.decimal, encryptedNote: enc1 });

    const [c1ex] = await view("pool::commitment_exists", [MODULE_ADDR, receiverCmx.decimal]);
    assert(c1ex as boolean, "receiver commitment must exist");
  });

  // ── WITHDRAW via relayer task (bob → his Aptos address) ──
  await test("Withdraw: bob → public address via relayer task", async () => {
    await rebuildWalletState();
    const inputNote = walletStates["bob"].notes[0];
    assert(!!inputNote, "bob must have a note");
    const tree = poolStates[inputNote.poolId].tree;

    // 1 change output (no separate fee note) — heavy withdraw proof leaves room for 1 insert.
    const inAmt = BigInt(inputNote.amount);
    const withdrawAmt = inAmt * 8n / 10n;
    const change = inAmt - withdrawAmt;
    const rC = randomField();
    const changeCmx  = await createCommitment(change.toString(), rC, bob.zk.publicKey);

    const BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const receiverDecimal = (BigInt(bobAcct.accountAddress.toString()) % BN254_P).toString();

    const { calldata, nullifier } = await proveWithdraw(bob, relayerWallet, receiverDecimal, inputNote, tree, withdrawAmt,
      { amount: change.toString(), randomness: rC, commitment: changeCmx.decimal },
      null);
    const enc1 = encryptMessage(JSON.stringify({ amount: change.toString(), randomness: rC }), bob.privateWallet.publicKey);
    const dummy = encryptMessage(JSON.stringify({ amount: "0", randomness: "0" }), relayerWallet.privateWallet.publicKey);

    const bobBefore = BigInt((await aptos.getAccountAPTAmount({ accountAddress: bobAcct.accountAddress })).toString());

    await exec(aliceAcct, "relayer::submit_withdraw_task", [
      MODULE_ADDR,
      Array.from(calldata.aBytes), Array.from(calldata.bBytes), Array.from(calldata.cBytes),
      MoveVector.U8([1, 0, 0, 0]),
      new MoveVector([0, 0, 0, 0].map((v) => new U64(v))),
      vU256([tree.root.toString(), "0", "0", "0"]),
      vU256([nullifier, "0", "0", "0"]),
      bobAcct.accountAddress.toString(), withdrawAmt.toString(),
      MoveVector.U8([1, 0]),
      vU256([changeCmx.decimal, "0"]),
      Array.from(Buffer.from(enc1)), Array.from(Buffer.from(dummy)),
    ]);

    const nrp = await buildNewRootProofs([changeCmx.decimal]);
    await exec(relayerAcct, "relayer::process_withdraw_task", [
      MODULE_ADDR, MODULE_ADDR, "0",
      vvU8(nrp.nr_a), vvU8(nrp.nr_b), vvU8(nrp.nr_c), vU256(nrp.nr_roots), vU256(nrp.nr_subhashes),
    ]);

    const bobAfter = BigInt((await aptos.getAccountAPTAmount({ accountAddress: bobAcct.accountAddress })).toString());
    assert(bobAfter - bobBefore === withdrawAmt, `bob received ${bobAfter - bobBefore} != ${withdrawAmt}`);

    emittedNullifierEvents.push({ nullifier });
    emittedNoteEvents.push({ poolId: "0", commitment: changeCmx.decimal, encryptedNote: enc1 });
  });

  // ── Summary ──
  console.log("\n" + "═".repeat(60));
  let pass = 0;
  for (const r of results) { console.log(`  ${r.ok ? "✅" : "❌"}  ${r.name}`); if (r.ok) pass++; }
  console.log("─".repeat(60));
  console.log(`  ${pass} passed / ${results.length - pass} failed / ${results.length} total`);
  console.log("═".repeat(60));
  if (pass !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
