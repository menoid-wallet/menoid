import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import bs58 from "bs58";
// @ts-ignore
import nacl from "tweetnacl";
import { generatePrivateWallet } from "../tests/helpers/wallets";
import { toBE32 } from "../tests/helpers/proofs";

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

async function main() {
  loadEnv();
  
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not defined in noid_solana/.env");
  }
  
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  console.log(`Using RPC: ${rpcUrl}`);
  
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const deployerKeypair = anchor.web3.Keypair.fromSecretKey(bs58.decode(deployerKey));
  console.log(`Deployer address: ${deployerKeypair.publicKey.toBase58()}`);
  
  const wallet = new anchor.Wallet(deployerKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  
  // 1. Generate ZK wallet with new seed (PRIVATE_KEY + "Menoid wallet")
  const relayerWallet = await generatePrivateWallet(deployerKey + "Menoid wallet");
  console.log("\n========== DERIVED RELAYER WALLET ==========");
  console.log(JSON.stringify(relayerWallet, null, 2));
  console.log("============================================\n");
  
  // 2. Load program IDL
  const idlPath = path.join(__dirname, "../target/idl/noid_solana.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL file not found at ${idlPath}. Please run anchor build first.`);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = new anchor.web3.PublicKey("3wxDTqw42qqftiAcTZ6kLeNtepuSmB1mR1skrEcwD9SC");
  const program = new anchor.Program(idl, provider) as any;
  
  // 3. Derive PDA pool state
  const [poolStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), deployerKeypair.publicKey.toBuffer()],
    programId
  );
  console.log(`Pool State PDA: ${poolStatePda.toBase58()}`);
  
  // Check if already initialized
  let alreadyInitialized = false;
  try {
    const poolState = await program.account.poolState.fetch(poolStatePda);
    console.log(`Pool State already exists! Admin: ${poolState.admin.toBase58()}, Relayer: ${poolState.relayerAddress.toBase58()}`);
    alreadyInitialized = true;
  } catch (err) {
    console.log("Pool State does not exist. Initializing pool state...");
  }
  
  const relayerZkPubkeyBytes = Array.from(toBE32(relayerWallet.zk.publicKey));
  
  if (!alreadyInitialized) {
    const tx = await program.methods
      .initialize(relayerZkPubkeyBytes, deployerKeypair.publicKey)
      .accounts({
        admin: deployerKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([deployerKeypair])
      .rpc();
      
    console.log(`Initialization transaction successful! Tx signature: ${tx}`);
  } else {
    console.log("Updating relayer configuration via set_relayer...");
    const tx = await program.methods
      .setRelayer(relayerZkPubkeyBytes, deployerKeypair.publicKey)
      .accounts({
        admin: deployerKeypair.publicKey,
      })
      .signers([deployerKeypair])
      .rpc();
      
    console.log(`set_relayer transaction successful! Tx signature: ${tx}`);
  }
  
  // Fetch and print final state
  const poolState = await program.account.poolState.fetch(poolStatePda);
  console.log("\n========== FINAL ON-CHAIN POOL STATE ==========");
  console.log(`Admin: ${poolState.admin.toBase58()}`);
  console.log(`Relayer: ${poolState.relayerAddress.toBase58()}`);
  console.log(`Relayer ZK Pubkey (decimal): ${BigInt("0x" + Buffer.from(poolState.relayerZkPubkey).toString("hex")).toString(10)}`);
  console.log(`Locked Balance: ${poolState.lockedBalance.toString()} lamports`);
  console.log("===============================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
