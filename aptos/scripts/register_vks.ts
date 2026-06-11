/**
 * scripts/register_vks.ts
 *
 * Reads the three snarkjs verification_key.json files produced during the
 * trusted setup and calls verifier::initialize_vks on-chain.
 *
 * Run ONCE after publishing the Move package:
 *   npx ts-node scripts/register_vks.ts
 *
 * Environment variables:
 *   APTOS_NODE_URL      default http://127.0.0.1:8080
 *   APTOS_FAUCET_URL    default http://127.0.0.1:8081
 *   NOID_MODULE_ADDR    the @noid address (deployer address)
 *   DEPLOYER_PRIVATE_KEY  hex private key of the deployer account
 */

import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
} from "@aptos-labs/ts-sdk";
import * as fs from "fs";
import * as path from "path";

const NODE_URL    = process.env.APTOS_NODE_URL    ?? "https://fullnode.devnet.aptoslabs.com/v1";
const FAUCET_URL  = process.env.APTOS_FAUCET_URL  ?? "https://faucet.devnet.aptoslabs.com";
const MODULE_ADDR = process.env.NOID_MODULE_ADDR  ?? (() => { throw new Error("Set NOID_MODULE_ADDR env var"); })();
const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY ?? (() => { throw new Error("Set DEPLOYER_PRIVATE_KEY env var"); })();

const BUILD_DIR = path.join(__dirname, "../zk_build");

const aptos = new Aptos(
  new AptosConfig({
    network: Network.DEVNET,
    fullnode: NODE_URL,
    faucet:   FAUCET_URL,
  })
);

// ─── G1 / G2 serialisation helpers ────────────────────────────────────────

// bn254_algebra (FormatG1Uncompr, FormatG2Uncompr) expects LITTLE-ENDIAN.
// Match the square.move pattern exactly.

function writeLE(buf: Uint8Array, value: bigint, offset: number, len: number) {
  let v = value;
  for (let i = offset; i < offset + len; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** snarkjs vkey.IC[i] (or vk_alpha_1) → 64-byte LE G1 */
function g1ToBytes(point: string[]): Uint8Array {
  const buf = new Uint8Array(64);
  writeLE(buf, BigInt(point[0]), 0,  32);
  writeLE(buf, BigInt(point[1]), 32, 32);
  return buf;
}

/** snarkjs vkey.vk_beta_2 / gamma_2 / delta_2 → 128-byte LE G2
 *  snarkjs format: [[x0,x1],[y0,y1]]
 */
function g2ToBytes(point: string[][]): Uint8Array {
  const buf = new Uint8Array(128);
  writeLE(buf, BigInt(point[0][0]), 0,  32);  // x0
  writeLE(buf, BigInt(point[0][1]), 32, 32);  // x1
  writeLE(buf, BigInt(point[1][0]), 64, 32);  // y0
  writeLE(buf, BigInt(point[1][1]), 96, 32);  // y1
  return buf;
}

/** Concatenate all IC points into one byte blob */
function icToBytes(ic: string[][]): Uint8Array {
  const parts = ic.map((pt) => g1ToBytes(pt));
  const total = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    total.set(p, offset);
    offset += p.length;
  }
  return total;
}

function toMoveArg(b: Uint8Array): number[] {
  return Array.from(b);
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const deployer = Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(DEPLOYER_PK),
  });

  console.log(`Deployer: ${deployer.accountAddress}`);

  // Load verification keys
  const depVK  = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, "deposit_verification_key.json"),  "utf8"));
  const traVK  = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, "transfer_verification_key.json"), "utf8"));
  const witVK  = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, "withdraw_verification_key.json"), "utf8"));

  const tx = await aptos.transaction.build.simple({
    sender: deployer.accountAddress,
    data: {
      function: `${MODULE_ADDR}::verifier::initialize_vks`,
      typeArguments: [],
      functionArguments: [
        // Deposit VK
        toMoveArg(g1ToBytes(depVK.vk_alpha_1)),
        toMoveArg(g2ToBytes(depVK.vk_beta_2)),
        toMoveArg(g2ToBytes(depVK.vk_gamma_2)),
        toMoveArg(g2ToBytes(depVK.vk_delta_2)),
        toMoveArg(icToBytes(depVK.IC)),
        // Transfer VK
        toMoveArg(g1ToBytes(traVK.vk_alpha_1)),
        toMoveArg(g2ToBytes(traVK.vk_beta_2)),
        toMoveArg(g2ToBytes(traVK.vk_gamma_2)),
        toMoveArg(g2ToBytes(traVK.vk_delta_2)),
        toMoveArg(icToBytes(traVK.IC)),
        // Withdraw VK
        toMoveArg(g1ToBytes(witVK.vk_alpha_1)),
        toMoveArg(g2ToBytes(witVK.vk_beta_2)),
        toMoveArg(g2ToBytes(witVK.vk_gamma_2)),
        toMoveArg(g2ToBytes(witVK.vk_delta_2)),
        toMoveArg(icToBytes(witVK.IC)),
      ],
    },
  });

  const signed = await aptos.transaction.sign({ signer: deployer, transaction: tx });
  const result = await aptos.transaction.submit.simple({
    senderAuthenticator: signed,
    transaction: tx,
  });
  const receipt = await aptos.waitForTransaction({ transactionHash: result.hash });

  console.log("VKs registered. Tx hash:", result.hash);
  console.log("Success:", receipt.success);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// DEPLOYER_PRIVATE_KEY=0xf4bd6656c446f96a4a69a13853092d842f0c9eb5653d93834913a9cb3e0fe08f npx ts-node scripts/register_vks.ts
// Deployer: 0x9deb75e9b498d575df2adf0c3a47c2d284a4b366a8a5ebd574e63472bbb3cd87
// VKs registered. Tx hash: 0x99011ace0c8dbcc038d5cfc42648fb54f85238bb3b3c1d732ecc22faba8e8f73
// Success: true