import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromBase64 } from "@mysten/sui/utils";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { generatePrivateWallet } from "../helpers/wallets";

// Manual dotenv loading
function loadEnv() {
  const envPath = path.join(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const parts = line.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join("=").trim();
        process.env[key] = val;
      }
    }
  }
}

// BN254 BASE-FIELD prime Fq
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
  parts.push(g2Compress(vk.vk_beta_2[0],  vk.vk_beta_2[1]));
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
  if (!fs.existsSync(p)) { throw new Error(`Missing VK file: ${p}`); }
  const vk = JSON.parse(fs.readFileSync(p, "utf8"));
  const bytes = encodeVK(vk);
  return Array.from(bytes);
}

async function main() {
  loadEnv();
  
  const rpcUrl = process.env.SUI_RPC_URL || "https://fullnode.testnet.sui.io:443";
  const circuitDir = process.env.CIRCUIT_DIR ? path.resolve(process.env.CIRCUIT_DIR) : path.join(__dirname, "../zk_build");
  const deployerSk = process.env.DEPLOYER_SECRET_KEY;
  
  if (!deployerSk) {
    throw new Error("DEPLOYER_SECRET_KEY is not defined in noid_sui/.env");
  }
  
  console.log(`Using Sui RPC: ${rpcUrl}`);
  console.log(`Using Circuit Dir: ${circuitDir}`);
  
  // Load keypair
  let keypair: Ed25519Keypair;
  if (deployerSk.startsWith("suiprivkey")) {
    const decoded = decodeSuiPrivateKey(deployerSk);
    keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
  } else {
    keypair = Ed25519Keypair.fromSecretKey(fromBase64(deployerSk));
  }
  const deployer = keypair.getPublicKey().toSuiAddress();
  console.log(`Deployer Sui address: ${deployer}`);
  
  const suiClient = new SuiClient({ url: rpcUrl });
  
  // 1. Publish package using Sui CLI
  console.log("\n[1/4] Publishing package on Sui Testnet...");
  const publishCmd = "sui client publish --gas-budget 300000000 --json";
  console.log(`Running: ${publishCmd}`);
  
  let publishJson: any;
  try {
    const output = execSync(publishCmd, { cwd: path.join(__dirname, ".."), stdio: "pipe" }).toString();
    publishJson = JSON.parse(output);
  } catch (err: any) {
    console.error("Publish failed:", err.message);
    if (err.stderr) console.error(err.stderr.toString());
    if (err.stdout) console.error(err.stdout.toString());
    process.exit(1);
  }
  
  if (publishJson.effects?.status?.status !== "success") {
    throw new Error(`Publish transaction failed on-chain: ${JSON.stringify(publishJson.effects?.status)}`);
  }
  
  const packageChange = publishJson.objectChanges.find((c: any) => c.type === "published");
  if (!packageChange) {
    throw new Error("Could not find published package ID in transaction output");
  }
  const packageId = packageChange.packageId;
  console.log(`Sui Package Published! ID: ${packageId}`);
  
  // 2. Generate private wallet via signing message
  console.log("\n[2/4] Generating private wallet ZK keypair...");
  const msgBytes = Buffer.from("PriFi private financial dapp");
  const signRes = await keypair.signPersonalMessage(msgBytes);
  const signatureHex = Buffer.from(signRes.signature, "base64").toString("hex");
  
  const relayerWallet = await generatePrivateWallet(signatureHex);
  console.log("Derived ZK Relayer Wallet:");
  console.log(JSON.stringify(relayerWallet, null, 2));
  
  // Helper to execute transactions
  const execTx = async (tx: Transaction): Promise<any> => {
    tx.setSender(deployer);
    tx.setGasBudget(200_000_000);
    const r = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true },
    });
    if (r.effects?.status.status !== "success") {
      throw new Error(`Tx failed: ${JSON.stringify(r.effects?.status)}`);
    }
    await suiClient.waitForTransaction({ digest: r.digest });
    return r;
  };
  
  // 3. Initialize verification keys
  console.log("\n[3/4] Initializing VerifierConfig...");
  const depVk = loadVkBytes(circuitDir, "deposit_verification_key.json");
  const traVk = loadVkBytes(circuitDir, "transfer_verification_key.json");
  const witVk = loadVkBytes(circuitDir, "withdraw_verification_key.json");
  
  const vkTx = new Transaction();
  vkTx.moveCall({
    target: `${packageId}::verifier::initialize_vks`,
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
  console.log(`VerifierConfig Object ID: ${vcId}`);
  
  // 4. Initialize pool state
  console.log("\n[4/4] Initializing PoolState...");
  const poolTx = new Transaction();
  poolTx.moveCall({
    target: `${packageId}::pool::initialize`,
    arguments: [
      poolTx.pure.u256(BigInt(relayerWallet.zk.publicKey)),
      poolTx.pure.address(deployer),
    ],
  });
  const poolResult = await execTx(poolTx);
  const psId = poolResult.objectChanges?.find(
    (c: any) => c.type === "created" && c.objectType?.includes("PoolState")
  )?.objectId;
  console.log(`PoolState Object ID: ${psId}`);
  
  // Write variables back to noid_sui/.env
  const envContent = `DEPLOYER_SECRET_KEY=${deployerSk}
CIRCUIT_DIR=./zk_build
SUI_RPC_URL=${rpcUrl}
SUI_FAUCET_URL=${process.env.SUI_FAUCET_URL || "https://faucet.testnet.sui.io/gas"}
NOID_PACKAGE_ID=${packageId}
POOL_STATE_ID=${psId}
VERIFIER_CONFIG_ID=${vcId}
`;
  fs.writeFileSync(path.join(__dirname, "../.env"), envContent);
  console.log("\nSuccessfully updated noid_sui/.env with package and object IDs!");
}

main().catch(err => {
  console.error("Deployment script failed:", err);
  process.exit(1);
});
