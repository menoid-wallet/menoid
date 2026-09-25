import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
} from "@aptos-labs/ts-sdk";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { deriveNoidWallet } from "../helpers/wallets";

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

// ─── G1 / G2 serialisation helpers ────────────────────────────────────────
function writeLE(buf: Uint8Array, value: bigint, offset: number, len: number) {
  let v = value;
  for (let i = offset; i < offset + len; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

// G1/G2 formats matching Aptos Move.
function g1ToBytes(point: string[]): Uint8Array {
  const buf = new Uint8Array(64);
  writeLE(buf, BigInt(point[0]), 0,  32);
  writeLE(buf, BigInt(point[1]), 32, 32);
  return buf;
}

function g2ToBytes(point: string[][]): Uint8Array {
  const buf = new Uint8Array(128);
  writeLE(buf, BigInt(point[0][0]), 0,  32);  // x0
  writeLE(buf, BigInt(point[0][1]), 32, 32);  // x1
  writeLE(buf, BigInt(point[1][0]), 64, 32);  // y0
  writeLE(buf, BigInt(point[1][1]), 96, 32);  // y1
  return buf;
}

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

// The PoolState resource lives on the deployer account and the pool's funds
// live in a resource account derived from this seed. Bumping the seed is what
// makes a redeploy start from an EMPTY tree instead of colliding with the
// previous pool's resource account.
// v4: the encryption public key is now registered on-chain alongside the
//     user commitment, so a sender resolves a receiver from the chain alone.
const POOL_SEED = "noid-pool-seed-v4";

async function main() {
  loadEnv();
  
  const nodeUrl = process.env.APTOS_NODE_URL || "https://fullnode.testnet.aptoslabs.com/v1";
  const faucetUrl = process.env.APTOS_FAUCET_URL || "https://faucet.testnet.aptoslabs.com";
  const moduleAddr = process.env.NOID_MODULE_ADDR;
  const deployerPkHex = process.env.DEPLOYER_PRIVATE_KEY;
  const circuitDir = process.env.CIRCUIT_DIR ? path.resolve(process.env.CIRCUIT_DIR) : path.join(__dirname, "../zk_build");
  
  if (!moduleAddr || !deployerPkHex) {
    throw new Error("NOID_MODULE_ADDR and DEPLOYER_PRIVATE_KEY must be defined in aptos/.env");
  }
  
  console.log(`Using Aptos Node: ${nodeUrl}`);
  console.log(`Using Circuit Dir: ${circuitDir}`);
  
  const isLocal = nodeUrl.includes("127.0.0.1") || nodeUrl.includes("localhost");
  const network = isLocal ? Network.LOCAL : Network.TESTNET;
  // Initialize Aptos client
  const aptos = new Aptos(
    new AptosConfig({
      network,
      fullnode: nodeUrl,
      faucet: faucetUrl,
    })
  );
  
  // Load account
  const deployerPrivateKey = new Ed25519PrivateKey(deployerPkHex);
  const deployer = Account.fromPrivateKey({ privateKey: deployerPrivateKey });
  console.log(`Deployer address: ${deployer.accountAddress.toString()}`);
  
  // 1. Derive the relayer noid keys from the REAL deployer wallet.
  //    The relayer signs "menoid_Wallet"; its user commitment is
  //    Poseidon(address mod p, spendPk.x, spendPk.y) — same convention on all chains.
  console.log("\nDeriving relayer noid keys...");
  const relayerWallet = await deriveNoidWallet(deployer);
  console.log("Relayer noid wallet:");
  console.log(JSON.stringify({
    address: relayerWallet.address,
    spendPublicKey: relayerWallet.spend.publicKey,
    encryptionPublicKey: relayerWallet.encryption.publicKey,
    userCommitment: relayerWallet.userCommitment,
  }, null, 2));
  
  // Helper to execute and wait for transactions
  const execTx = async (funcName: string, args: any[]): Promise<void> => {
    const tx = await aptos.transaction.build.simple({
      sender: deployer.accountAddress,
      data: {
        function: `${moduleAddr}::${funcName}` as `${string}::${string}::${string}`,
        typeArguments: [],
        functionArguments: args,
      },
    });
    const signed = await aptos.transaction.sign({ signer: deployer, transaction: tx });
    const result = await aptos.transaction.submit.simple({
      senderAuthenticator: signed,
      transaction: tx,
    });
    const receipt = await aptos.waitForTransaction({ transactionHash: result.hash });
    console.log(`Tx success: ${receipt.success}, Hash: ${result.hash}`);
    if (!receipt.success) {
      throw new Error(`Tx failed on-chain: ${result.hash}`);
    }
  };
  
  // Check if pool is already initialized
  let alreadyInitialized = false;
  try {
    const [resAddr] = await aptos.view({
      payload: {
        function: `${moduleAddr}::pool::pool_resource_addr`,
        typeArguments: [],
        functionArguments: [deployer.accountAddress.toString()],
      },
    });
    console.log(`Pool resource account already exists: ${resAddr}`);
    alreadyInitialized = true;
  } catch (err) {
    console.log("Pool not yet initialized.");
  }
  
  if (!alreadyInitialized) {
    // 2. Publish package using Aptos CLI
    console.log("\n[1/4] Publishing package on Aptos Testnet...");
    const publishCmd = "echo 'Skipping publish step'";
    console.log(`Running: ${publishCmd}`);
    
    try {
      execSync(publishCmd, { cwd: path.join(__dirname, ".."), stdio: "inherit" });
    } catch (err: any) {
      console.error("Publish failed:", err.message);
      process.exit(1);
    }
    
    // 3. Register verification keys
    console.log("\n[2/4] Registering VKs...");
    const depVK = JSON.parse(fs.readFileSync(path.join(circuitDir, "deposit_verification_key.json"), "utf8"));
    const traVK = JSON.parse(fs.readFileSync(path.join(circuitDir, "transfer_verification_key.json"), "utf8"));
    const witVK = JSON.parse(fs.readFileSync(path.join(circuitDir, "withdraw_verification_key.json"), "utf8"));
    const nrVK  = JSON.parse(fs.readFileSync(path.join(circuitDir, "new_root_verification_key.json"), "utf8"));
    
    const vkArgs = [
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
      // New Root VK
      toMoveArg(g1ToBytes(nrVK.vk_alpha_1)),
      toMoveArg(g2ToBytes(nrVK.vk_beta_2)),
      toMoveArg(g2ToBytes(nrVK.vk_gamma_2)),
      toMoveArg(g2ToBytes(nrVK.vk_delta_2)),
      toMoveArg(icToBytes(nrVK.IC)),
    ];
    
    await execTx("verifier::initialize_vks", vkArgs);
    console.log("VKs successfully registered!");
    
    // 4. Initialize pool state
    console.log("\n[3/4] Initializing Pool State...");
    const poolArgs = [
      BigInt(relayerWallet.userCommitment),
      deployer.accountAddress.toString(),
      toMoveArg(Buffer.from(POOL_SEED)),
    ];
    
    await execTx("pool::initialize", poolArgs);
    console.log("Pool successfully initialized!");
  } else {
    // 2. Call set_relayer
    console.log("\nUpdating Relayer State on-chain...");
    const poolArgs = [
      deployer.accountAddress.toString(), // pool_addr
      BigInt(relayerWallet.userCommitment), // relayer user commitment
      deployer.accountAddress.toString(), // relayer_address
    ];
    await execTx("pool::set_relayer", poolArgs);
    console.log("Pool relayer successfully updated!");
  }

  // 5. Register the relayer wallet (one-time; failure means already registered)
  console.log("\n[4/4] Registering relayer wallet...");
  try {
    await execTx("pool::register", [
      deployer.accountAddress.toString(),
      BigInt(relayerWallet.userCommitment),
      Array.from(Buffer.from(relayerWallet.encryption.publicKey.replace(/^0x/, ""), "hex")),
    ]);
    console.log("Relayer registered!");
  } catch (err: any) {
    console.log("Relayer registration skipped (already registered)");
  }
  const [onchainUC] = await aptos.view({
    payload: {
      function: `${moduleAddr}::pool::registered_commitment`,
      typeArguments: [],
      functionArguments: [deployer.accountAddress.toString(), deployer.accountAddress.toString()],
    },
  });
  if (BigInt(onchainUC as string) !== BigInt(relayerWallet.userCommitment)) {
    throw new Error(`On-chain relayer registration mismatch: ${onchainUC}`);
  }
  console.log("Relayer registration verified on-chain.");
}

main().catch((err) => {
  console.error("Deployment script failed:", err);
  process.exit(1);
});
