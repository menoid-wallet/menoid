/**
 * deploy_local.ts — publish + initialize the noid pool on a LOCAL Aptos node.
 *
 * Prereq: a fresh local node is running:
 *   aptos node run-local-testnet --with-faucet --force-restart
 *
 * Steps:
 *   1. fund the deployer from the local faucet
 *   2. publish the Move package
 *   3. register the verification keys (deposit/transfer/withdraw/new_root)
 *   4. pool::initialize with the relayer's user commitment
 *   5. pool::register the relayer wallet
 *
 * Then run the tests:
 *   APTOS_NODE_URL=http://127.0.0.1:8080/v1 APTOS_FAUCET_URL=http://127.0.0.1:8081 \
 *   npx ts-node noid_pool.devnet.test.ts
 */

import {
  Aptos, AptosConfig, Network, Account, Ed25519PrivateKey,
} from "@aptos-labs/ts-sdk";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

import { deriveNoidWallet } from "../helpers/wallets";

const NODE_URL    = process.env.APTOS_NODE_URL   ?? "http://127.0.0.1:8080/v1";
const FAUCET_URL  = process.env.APTOS_FAUCET_URL ?? "http://127.0.0.1:8081";
const CIRCUIT_DIR = path.join(__dirname, "../zk_build");
const APTOS_DIR   = path.join(__dirname, "..");
const POOL_SEED   = process.env.POOL_SEED ?? "noid-pool-seed-v1";

function loadEnv() {
  const envPath = path.join(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !process.env[line.slice(0, i).trim()]) {
      process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
}
loadEnv();

const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY!;
// On a fresh localnet the module address is simply the address derived from
// the deployer key (the .env NOID_MODULE_ADDR may belong to devnet/testnet).
const MODULE_ADDR = Account.fromPrivateKey({
  privateKey: new Ed25519PrivateKey(DEPLOYER_PK),
}).accountAddress.toString();

const aptos = new Aptos(new AptosConfig({
  network: Network.LOCAL, fullnode: NODE_URL, faucet: FAUCET_URL,
}));

// ── VK encoding (little-endian, matches bn254_algebra formats) ──

function writeLE(buf: Uint8Array, v: bigint, off: number, len: number) {
  for (let i = off; i < off + len; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
}
function g1ToBytes(pt: string[]) { const b = new Uint8Array(64); writeLE(b, BigInt(pt[0]), 0, 32); writeLE(b, BigInt(pt[1]), 32, 32); return Array.from(b); }
function g2ToBytes(pt: string[][]) { const b = new Uint8Array(128); writeLE(b, BigInt(pt[0][0]), 0, 32); writeLE(b, BigInt(pt[0][1]), 32, 32); writeLE(b, BigInt(pt[1][0]), 64, 32); writeLE(b, BigInt(pt[1][1]), 96, 32); return b && Array.from(b); }
function icToBytes(ic: string[][]) { const out: number[] = []; for (const pt of ic) out.push(...g1ToBytes(pt)); return out; }
function loadVK(name: string) { return JSON.parse(fs.readFileSync(path.join(CIRCUIT_DIR, name), "utf8")); }

async function exec(signer: Account, func: string, args: any[]): Promise<void> {
  const tx = await aptos.transaction.build.simple({
    sender: signer.accountAddress,
    data: { function: `${MODULE_ADDR}::${func}` as `${string}::${string}::${string}`, typeArguments: [], functionArguments: args },
    options: { maxGasAmount: 2_000_000, gasUnitPrice: 100 },
  });
  const pending = await aptos.signAndSubmitTransaction({ signer, transaction: tx });
  const r = await aptos.waitForTransaction({ transactionHash: pending.hash });
  if (!(r as any).success) throw new Error(`tx ${func} failed: ${pending.hash}`);
  console.log(`  ✅ ${func}`);
}

async function main() {
  const deployer = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(DEPLOYER_PK) });
  console.log("Deployer / module address:", MODULE_ADDR);

  // 1. fund deployer
  const res = await fetch(`${FAUCET_URL}/mint?amount=1000000000&address=${MODULE_ADDR}`, { method: "POST" });
  if (!res.ok) throw new Error(`faucet: ${res.status}`);
  await new Promise((r) => setTimeout(r, 1500));
  console.log("  ✅ deployer funded");

  // 2. publish package
  execSync(
    `aptos move publish --url ${NODE_URL} --private-key ${DEPLOYER_PK} --assume-yes --skip-fetch-latest-git-deps --max-gas 2000000 --named-addresses noid=${MODULE_ADDR}`,
    { cwd: APTOS_DIR, stdio: "inherit" },
  );
  console.log("  ✅ package published");

  // 3. register verification keys
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

  // 4. initialize pool with the relayer user commitment
  const relayerWallet = await deriveNoidWallet(deployer);
  console.log("  relayer user commitment:", relayerWallet.userCommitment);
  await exec(deployer, "pool::initialize", [
    relayerWallet.userCommitment,
    deployer.accountAddress.toString(),
    Array.from(Buffer.from(POOL_SEED)),
  ]);

  // 5. register the relayer wallet
  await exec(deployer, "pool::register", [
    MODULE_ADDR,
    relayerWallet.userCommitment,
    Array.from(Buffer.from(relayerWallet.encryption.publicKey.replace(/^0x/, ""), "hex")),
  ]);

  // fresh chain -> reset the persisted tree state used by the tests
  const stateFile = path.join(APTOS_DIR, ".noid-state.json");
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  console.log("  ✅ cleared .noid-state.json");

  console.log("\nDEPLOYMENT DONE");
}

main().catch((e) => { console.error(e); process.exit(1); });
