/**
 * deploy.ts — Deploy and initialize NoidPool on Sui.
 *
 * Sui's groth16::prepare_verifying_key expects Arkworks CanonicalSerialize
 * COMPRESSED, LITTLE-ENDIAN format for BN254:
 *
 * G1 compressed (32 bytes, LITTLE-ENDIAN):
 *   bytes[0..30] = x-coordinate, least-significant byte first
 *   byte[31]     = x MSB bits | flags in the top 2 bits:
 *       bit7 = YIsNegative  (set when y > Fq - y)
 *       bit6 = PointAtInfinity (0 for normal points)
 *   (there is NO separate "compressed" bit — compression is implied by length)
 *
 * G2 compressed (64 bytes, LITTLE-ENDIAN):
 *   snarkjs JSON: [[xc0, xc1], [yc0, yc1]]  (index 0 = c0, index 1 = c1)
 *   bytes[0..31]  = x.c0 little-endian (no flags)
 *   bytes[32..63] = x.c1 little-endian; flags in byte[63] (top 2 bits)
 *   Fq2 sign uses lex order with c1 the most significant coefficient:
 *       YIsNeg = (yc1 > Fq-yc1) || (yc1 == Fq-yc1 && yc0 > Fq-yc0)
 *
 * Full VK layout:
 *   alpha_g1  32 bytes
 *   beta_g2   64 bytes
 *   gamma_g2  64 bytes
 *   delta_g2  64 bytes
 *   ic_len     8 bytes (u64 LE)
 *   IC[i]     32 bytes each
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromBase64 } from "@mysten/sui/utils";
import * as fs from "fs";
import * as path from "path";

import { deriveNoidWallet } from "../helpers/wallets";

const RPC_URL     = process.env.SUI_RPC_URL    ?? "http://127.0.0.1:9000";
const FAUCET_URL  = process.env.SUI_FAUCET_URL ?? "http://127.0.0.1:9123/gas";
const CIRCUIT_DIR = process.env.CIRCUIT_DIR    ?? path.join(__dirname, "../zk_build");
const DEPLOYER_SK = process.env.DEPLOYER_SECRET_KEY ?? (() => { throw new Error("Set DEPLOYER_SECRET_KEY"); })();

const suiClient = new SuiClient({ url: RPC_URL });
const keypair   = DEPLOYER_SK.startsWith("suiprivkey")
  ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(DEPLOYER_SK).secretKey)
  : Ed25519Keypair.fromSecretKey(fromBase64(DEPLOYER_SK));
const deployer  = keypair.getPublicKey().toSuiAddress();
const IS_LOCAL  = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");

// BN254 BASE-FIELD prime Fq (point coordinates) — NOT the scalar field.
const Fq = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");

/** 32-byte little-endian buffer (byte[0] = LSB, byte[31] = MSB). */
function toLE32(val: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let v = val;
  for (let i = 0; i < 32; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}

function g1Compress(x: string, y: string): Buffer {
  const xn = BigInt(x), yn = BigInt(y);
  const buf = toLE32(xn);
  const yIsNeg = yn > (Fq - yn);                       // Arkworks: y > -y
  buf[31] = (buf[31] & 0x3f) | (yIsNeg ? 0x80 : 0x00); // flags in MSB byte
  return buf;
}

function g2Compress(xarr: string[], yarr: string[]): Buffer {
  const xc0 = BigInt(xarr[0]), xc1 = BigInt(xarr[1]);
  const yc0 = BigInt(yarr[0]), yc1 = BigInt(yarr[1]);
  const negYc1 = yc1 === 0n ? 0n : Fq - yc1;
  const negYc0 = yc0 === 0n ? 0n : Fq - yc0;
  const yIsNeg = yc1 > negYc1 || (yc1 === negYc1 && yc0 > negYc0);
  const c0buf = toLE32(xc0);                  // no flags
  const c1buf = toLE32(xc1);
  c1buf[31] = (c1buf[31] & 0x3f) | (yIsNeg ? 0x80 : 0x00);
  return Buffer.concat([c0buf, c1buf]);       // Arkworks Fq2 order: c0 then c1
}

function encodeVK(vk: any): Buffer {
  const parts: Buffer[] = [];
  parts.push(g1Compress(vk.vk_alpha_1[0], vk.vk_alpha_1[1]));
  parts.push(g2Compress(vk.vk_beta_2[0],  vk.vk_beta_2[1]));
  parts.push(g2Compress(vk.vk_gamma_2[0], vk.vk_gamma_2[1]));
  parts.push(g2Compress(vk.vk_delta_2[0], vk.vk_delta_2[1]));
  const icLenBuf = Buffer.alloc(8);
  icLenBuf.writeBigUInt64LE(BigInt(vk.IC.length), 0);
  parts.push(icLenBuf);
  for (const ic of vk.IC) parts.push(g1Compress(ic[0], ic[1]));
  return Buffer.concat(parts);
}

function loadVkBytes(filename: string): number[] {
  const p = path.join(CIRCUIT_DIR, filename);
  if (!fs.existsSync(p)) { console.error(`Missing: ${p}`); process.exit(1); }
  const vk    = JSON.parse(fs.readFileSync(p, "utf8"));
  const bytes = encodeVK(vk);
  const expected = 32 + 64 * 3 + 8 + vk.IC.length * 32;
  if (bytes.length !== expected) {
    console.error(`  !! ${filename}: ${bytes.length} bytes, expected ${expected}`);
    process.exit(1);
  }
  console.log(`  ${filename}: ${bytes.length} bytes, nPublic=${vk.nPublic}, ${vk.IC.length} IC points`);
  if (vk.nPublic > 8) {
    console.warn(
      `  !! WARNING: ${filename} has nPublic=${vk.nPublic}. Sui's native groth16 ` +
      `verifier rejects > 8 public inputs (prepare_verifying_key abort code 2 = ` +
      `ETooManyPublicInputs). This VK will NOT load as-is.`
    );
  }
  return Array.from(bytes);
}

async function requestFaucet(addr: string) {
  if (!IS_LOCAL) return;
  await fetch(FAUCET_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ FixedAmountRequest: { recipient: addr } }),
  });
  await new Promise(r => setTimeout(r, 1500));
}

async function execTx(tx: Transaction): Promise<any> {
  tx.setSender(deployer);
  tx.setGasBudget(500_000_000);
  const r = await suiClient.signAndExecuteTransaction({
    signer: keypair, transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (r.effects?.status.status !== "success") {
    throw new Error(`Tx failed: ${JSON.stringify(r.effects?.status)}`);
  }
  await suiClient.waitForTransaction({ digest: r.digest });
  return r;
}

async function main() {
  console.log("=".repeat(60));
  console.log("  NoidPool — Sui Deploy Script");
  console.log("=".repeat(60));
  console.log(`  Deployer: ${deployer}`);
  console.log(`  RPC:      ${RPC_URL}`);
  console.log(`  Circuits: ${CIRCUIT_DIR}`);

  const bal = await suiClient.getBalance({ owner: deployer });
  if (BigInt(bal.totalBalance) < 500_000_000n) {
    console.log("  Requesting faucet...");
    await requestFaucet(deployer);
  }

  const PACKAGE_ID = process.env.NOID_PACKAGE_ID;
  if (!PACKAGE_ID) {
    console.log("\n  NOID_PACKAGE_ID not set.");
    console.log("  Publish first:  sui client publish --gas-budget 200000000");
    console.log("  Then:           export NOID_PACKAGE_ID=0x...");
    return;
  }
  console.log(`\n[1/3] Package: ${PACKAGE_ID}`);

  console.log("\n[2/3] Initializing VerifierConfig...");
  const depVk = loadVkBytes("deposit_verification_key.json");
  const traVk = loadVkBytes("transfer_verification_key.json");
  const witVk = loadVkBytes("withdraw_verification_key.json");

  const vkTx = new Transaction();
  vkTx.moveCall({
    target: `${PACKAGE_ID}::verifier::initialize_vks`,
    arguments: [
      vkTx.pure.vector("u8", depVk),
      vkTx.pure.vector("u8", traVk),
      vkTx.pure.vector("u8", witVk),
    ],
  });
  const vkResult = await execTx(vkTx);
  const vcId = vkResult.objectChanges?.find(
    (c: any) => c.type === "created" && c.objectType?.includes("VerifierConfig")
  )?.objectId;
  console.log(`  VerifierConfig: ${vcId}`);

  console.log("\n[3/4] Initializing PoolState...");
  // relayer keys are derived from the REAL deployer wallet's signature
  const relayerWallet = await deriveNoidWallet(keypair);
  console.log(`  Relayer user commitment: ${relayerWallet.userCommitment}`);
  const poolTx = new Transaction();
  poolTx.moveCall({
    target: `${PACKAGE_ID}::pool::initialize`,
    arguments: [
      poolTx.pure.u256(BigInt(relayerWallet.userCommitment)),
      poolTx.pure.address(deployer),
    ],
  });
  const poolResult = await execTx(poolTx);
  const psId = poolResult.objectChanges?.find(
    (c: any) => c.type === "created" && c.objectType?.includes("PoolState")
  )?.objectId;
  console.log(`  PoolState: ${psId}`);

  console.log("\n[4/4] Registering the relayer wallet...");
  const regTx = new Transaction();
  regTx.moveCall({
    target: `${PACKAGE_ID}::pool::register`,
    arguments: [
      regTx.object(psId),
      regTx.pure.u256(BigInt(relayerWallet.userCommitment)),
    ],
  });
  await execTx(regTx);
  console.log("  Relayer registered");

  console.log("\n" + "=".repeat(60));
  console.log("  SET THESE ENV VARS:");
  console.log("=".repeat(60));
  console.log(`export NOID_PACKAGE_ID=${PACKAGE_ID}`);
  console.log(`export POOL_STATE_ID=${psId}`);
  console.log(`export VERIFIER_CONFIG_ID=${vcId}`);
  console.log(`export DEPLOYER_SECRET_KEY=${DEPLOYER_SK}`);
  console.log("=".repeat(60));
}

main().catch(e => { console.error(e); process.exit(1); });