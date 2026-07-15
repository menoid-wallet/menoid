/**
 * Re-register the verification keys on an ALREADY-PUBLISHED package.
 *
 * deploy_testnet.ts publishes a fresh package and registers VKs as part of
 * that, so it cannot roll out a new trusted setup to a live deployment.
 * verifier::reinitialize_vks overwrites the PreparedVerifyingKeys inside the
 * existing shared VerifierConfig, keeping the package / PoolState / config IDs.
 *
 * Needed after the deposit circuit gained its amount range checks: the new
 * setup produces a new deposit VK, and the old one would reject every proof
 * built from the new zkey.
 *
 * Usage:  npx ts-node scripts/update_vks_testnet.ts
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromBase64 } from "@mysten/sui/utils";
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

// ─── VK encoding — must byte-match scripts/deploy_testnet.ts ───────────────
const Fq = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");

function toLE32(val: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let v = val;
  for (let i = 0; i < 32; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}
function g1Compress(x: string, y: string): Buffer {
  const xn = BigInt(x), yn = BigInt(y);
  const buf = toLE32(xn);
  const yIsNeg = yn > (Fq - yn);
  buf[31] = (buf[31] & 0x3f) | (yIsNeg ? 0x80 : 0x00);
  return buf;
}
function g2Compress(xarr: string[], yarr: string[]): Buffer {
  const xc0 = BigInt(xarr[0]), xc1 = BigInt(xarr[1]);
  const yc0 = BigInt(yarr[0]), yc1 = BigInt(yarr[1]);
  const negYc1 = yc1 === 0n ? 0n : Fq - yc1;
  const negYc0 = yc0 === 0n ? 0n : Fq - yc0;
  const yIsNeg = yc1 > negYc1 || (yc1 === negYc1 && yc0 > negYc0);
  const c0buf = toLE32(xc0);
  const c1buf = toLE32(xc1);
  c1buf[31] = (c1buf[31] & 0x3f) | (yIsNeg ? 0x80 : 0x00);
  return Buffer.concat([c0buf, c1buf]);
}
function encodeVK(vk: any): Buffer {
  const parts: Buffer[] = [];
  parts.push(g1Compress(vk.vk_alpha_1[0], vk.vk_alpha_1[1]));
  parts.push(g2Compress(vk.vk_beta_2[0], vk.vk_beta_2[1]));
  parts.push(g2Compress(vk.vk_gamma_2[0], vk.vk_gamma_2[1]));
  parts.push(g2Compress(vk.vk_delta_2[0], vk.vk_delta_2[1]));
  const icLenBuf = Buffer.alloc(8);
  icLenBuf.writeBigUInt64LE(BigInt(vk.IC.length), 0);
  parts.push(icLenBuf);
  for (const ic of vk.IC) parts.push(g1Compress(ic[0], ic[1]));
  return Buffer.concat(parts);
}
function loadVkBytes(circuitDir: string, filename: string): number[] {
  const p = path.join(circuitDir, filename);
  if (!fs.existsSync(p)) throw new Error(`Missing VK file: ${p}`);
  return Array.from(encodeVK(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  loadEnv();

  const rpcUrl = process.env.SUI_RPC_URL || "https://rpc-testnet.suiscan.xyz:443";
  const circuitDir = process.env.CIRCUIT_DIR
    ? path.resolve(process.env.CIRCUIT_DIR)
    : path.join(__dirname, "../zk_build");
  const deployerSk = process.env.DEPLOYER_SECRET_KEY;
  const packageId = process.env.NOID_PACKAGE_ID;
  const configId = process.env.VERIFIER_CONFIG_ID;

  if (!deployerSk) throw new Error("DEPLOYER_SECRET_KEY is not set in noid_sui/.env");
  if (!packageId) throw new Error("NOID_PACKAGE_ID is not set in noid_sui/.env");
  if (!configId) throw new Error("VERIFIER_CONFIG_ID is not set in noid_sui/.env");

  let keypair: Ed25519Keypair;
  if (deployerSk.startsWith("suiprivkey")) {
    keypair = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(deployerSk).secretKey);
  } else {
    keypair = Ed25519Keypair.fromSecretKey(fromBase64(deployerSk));
  }
  const deployer = keypair.getPublicKey().toSuiAddress();

  console.log(`RPC:         ${rpcUrl}`);
  console.log(`Package:     ${packageId}`);
  console.log(`Config:      ${configId}`);
  console.log(`Deployer:    ${deployer}`);
  console.log(`Circuit dir: ${circuitDir}\n`);

  const depVk = JSON.parse(
    fs.readFileSync(path.join(circuitDir, "deposit_verification_key.json"), "utf8")
  );
  if (depVk.nPublic !== 5) {
    throw new Error(`deposit VK has nPublic=${depVk.nPublic}, expected 5`);
  }
  console.log(`deposit VK nPublic=${depVk.nPublic}, IC points=${depVk.IC.length}`);

  const client = new SuiClient({ url: rpcUrl });

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::verifier::reinitialize_vks`,
    arguments: [
      tx.object(configId),
      tx.pure.vector("u8", loadVkBytes(circuitDir, "deposit_verification_key.json")),
      tx.pure.vector("u8", loadVkBytes(circuitDir, "transfer_verification_key.json")),
      tx.pure.vector("u8", loadVkBytes(circuitDir, "withdraw_verification_key.json")),
    ],
  });
  tx.setGasBudget(200_000_000);

  const res = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: res.digest });

  const status = res.effects?.status?.status;
  console.log(`\nreinitialize_vks status=${status}  digest=${res.digest}`);
  if (status !== "success") {
    throw new Error(`reinitialize_vks failed: ${JSON.stringify(res.effects?.status)}`);
  }
  console.log("VKs updated on-chain.");
}

main().catch((e) => {
  console.error("update_vks_testnet failed:", e);
  process.exit(1);
});
