/**
 * Re-register the verification keys on an ALREADY-INITIALIZED deployment.
 *
 * deploy_testnet.ts only registers VKs on the fresh-init path, so it cannot
 * roll out a new trusted setup to a live pool. This calls
 * verifier::reinitialize_vks, which overwrites the VKs in place.
 *
 * Needed after the deposit circuit gained its amount range checks: the new
 * setup produces a new deposit VK, and the old one would reject every proof
 * built from the new zkey.
 *
 * Usage:  npx ts-node scripts/update_vks_testnet.ts
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

function loadEnv() {
  const envPath = path.join(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
}

// ─── G1 / G2 serialisation (must match sources/verifier.move) ──────────────
function writeLE(buf: Uint8Array, value: bigint, offset: number, len: number) {
  let v = value;
  for (let i = offset; i < offset + len; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}
function g1ToBytes(point: string[]): Uint8Array {
  const buf = new Uint8Array(64);
  writeLE(buf, BigInt(point[0]), 0, 32);
  writeLE(buf, BigInt(point[1]), 32, 32);
  return buf;
}
function g2ToBytes(point: string[][]): Uint8Array {
  const buf = new Uint8Array(128);
  writeLE(buf, BigInt(point[0][0]), 0, 32);
  writeLE(buf, BigInt(point[0][1]), 32, 32);
  writeLE(buf, BigInt(point[1][0]), 64, 32);
  writeLE(buf, BigInt(point[1][1]), 96, 32);
  return buf;
}
function icToBytes(ic: string[][]): Uint8Array {
  const parts = ic.map(g1ToBytes);
  const total = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { total.set(p, o); o += p.length; }
  return total;
}
const toMoveArg = (b: Uint8Array): number[] => Array.from(b);

async function main() {
  loadEnv();

  const nodeUrl = process.env.APTOS_NODE_URL || "https://fullnode.testnet.aptoslabs.com/v1";
  const moduleAddr = process.env.NOID_MODULE_ADDR;
  const deployerPkHex = process.env.DEPLOYER_PRIVATE_KEY;
  const circuitDir = process.env.CIRCUIT_DIR
    ? path.resolve(process.env.CIRCUIT_DIR)
    : path.join(__dirname, "../zk_build");

  if (!moduleAddr || !deployerPkHex) {
    throw new Error("NOID_MODULE_ADDR and DEPLOYER_PRIVATE_KEY must be set in aptos/.env");
  }

  const isLocal = nodeUrl.includes("127.0.0.1") || nodeUrl.includes("localhost");
  const aptos = new Aptos(
    new AptosConfig({
      network: isLocal ? Network.LOCAL : Network.TESTNET,
      fullnode: nodeUrl,
      faucet: process.env.APTOS_FAUCET_URL,
    })
  );

  const deployer = Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(deployerPkHex),
  });

  console.log(`Node:        ${nodeUrl}`);
  console.log(`Module addr: ${moduleAddr}`);
  console.log(`Admin:       ${deployer.accountAddress.toString()}`);
  console.log(`Circuit dir: ${circuitDir}\n`);

  const load = (f: string) =>
    JSON.parse(fs.readFileSync(path.join(circuitDir, f), "utf8"));

  const depVK = load("deposit_verification_key.json");
  const traVK = load("transfer_verification_key.json");
  const witVK = load("withdraw_verification_key.json");
  const nrVK = load("new_root_verification_key.json");

  // guard: the deposit circuit takes 5 public signals; a mismatch here means
  // the wrong artifacts are being pushed.
  if (depVK.nPublic !== 5) {
    throw new Error(`deposit VK has nPublic=${depVK.nPublic}, expected 5`);
  }
  console.log(`deposit VK nPublic=${depVK.nPublic}, IC points=${depVK.IC.length}`);

  const vkArgs = [
    toMoveArg(g1ToBytes(depVK.vk_alpha_1)), toMoveArg(g2ToBytes(depVK.vk_beta_2)),
    toMoveArg(g2ToBytes(depVK.vk_gamma_2)), toMoveArg(g2ToBytes(depVK.vk_delta_2)),
    toMoveArg(icToBytes(depVK.IC)),
    toMoveArg(g1ToBytes(traVK.vk_alpha_1)), toMoveArg(g2ToBytes(traVK.vk_beta_2)),
    toMoveArg(g2ToBytes(traVK.vk_gamma_2)), toMoveArg(g2ToBytes(traVK.vk_delta_2)),
    toMoveArg(icToBytes(traVK.IC)),
    toMoveArg(g1ToBytes(witVK.vk_alpha_1)), toMoveArg(g2ToBytes(witVK.vk_beta_2)),
    toMoveArg(g2ToBytes(witVK.vk_gamma_2)), toMoveArg(g2ToBytes(witVK.vk_delta_2)),
    toMoveArg(icToBytes(witVK.IC)),
    toMoveArg(g1ToBytes(nrVK.vk_alpha_1)), toMoveArg(g2ToBytes(nrVK.vk_beta_2)),
    toMoveArg(g2ToBytes(nrVK.vk_gamma_2)), toMoveArg(g2ToBytes(nrVK.vk_delta_2)),
    toMoveArg(icToBytes(nrVK.IC)),
  ];

  const tx = await aptos.transaction.build.simple({
    sender: deployer.accountAddress,
    data: {
      function: `${moduleAddr}::verifier::reinitialize_vks` as `${string}::${string}::${string}`,
      typeArguments: [],
      functionArguments: vkArgs,
    },
  });
  const signed = await aptos.transaction.sign({ signer: deployer, transaction: tx });
  const res = await aptos.transaction.submit.simple({
    senderAuthenticator: signed,
    transaction: tx,
  });
  const receipt = await aptos.waitForTransaction({ transactionHash: res.hash });

  console.log(`\nreinitialize_vks success=${receipt.success}  hash=${res.hash}`);
  if (!receipt.success) throw new Error("reinitialize_vks failed on-chain");

  console.log("VKs updated on-chain.");
}

main().catch((e) => {
  console.error("update_vks_testnet failed:", e);
  process.exit(1);
});
