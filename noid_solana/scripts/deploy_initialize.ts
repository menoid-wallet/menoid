import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import bs58 from "bs58";
import { deriveNoidWallet } from "../tests/helpers/wallets";
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

const PROGRAM_ID = "3wxDTqw42qqftiAcTZ6kLeNtepuSmB1mR1skrEcwD9SC";

// The pool PDA is seeded with the admin pubkey. Because the same program is
// reused across redeploys, we derive a FRESH, deterministic admin keypair from
// the deployer key so each fresh deployment gets a brand-new (empty) pool PDA
// instead of colliding with a previous, populated pool.
// v3: user-commitment architecture (register onchain).
// v4: the note-encryption public key is registered on-chain alongside the user
//     commitment, so a sender resolves a receiver from the chain alone.
const POOL_ADMIN_SEED_TAG = "menoid-solana-pool-admin-v4";

function deriveAdminKeypair(deployerKey: string): anchor.web3.Keypair {
  const seed = crypto.createHash("sha256").update(deployerKey + POOL_ADMIN_SEED_TAG).digest();
  return anchor.web3.Keypair.fromSeed(seed);
}

async function main() {
  loadEnv();

  const deployerKey = process.env.SOLANA_DEPLOYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    throw new Error("SOLANA_DEPLOYER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) is not defined in noid_solana/.env");
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  console.log(`Using RPC: ${rpcUrl}`);

  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const deployerKeypair = anchor.web3.Keypair.fromSecretKey(bs58.decode(deployerKey));
  console.log(`Deployer (relayer) address: ${deployerKeypair.publicKey.toBase58()}`);

  // Pool admin — fresh deterministic keypair so the pool PDA is brand new.
  const adminKeypair = deriveAdminKeypair(deployerKey);
  console.log(`Pool admin address: ${adminKeypair.publicKey.toBase58()}`);

  const wallet = new anchor.Wallet(deployerKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // 1. Derive the relayer noid keys from the REAL deployer wallet.
  //    The relayer signs "menoid_Wallet"; its user commitment is
  //    Poseidon(address mod p, spendPk.x, spendPk.y).
  const relayerWallet = await deriveNoidWallet(deployerKeypair);
  console.log("\n========== RELAYER NOID WALLET ==========");
  console.log(JSON.stringify({
    address: relayerWallet.address,
    spendPublicKey: relayerWallet.spend.publicKey,
    encryptionPublicKey: relayerWallet.encryption.publicKey,
    userCommitment: relayerWallet.userCommitment,
  }, null, 2));
  console.log("=========================================\n");

  // 2. Load program IDL
  const idlPath = path.join(__dirname, "../target/idl/noid_solana.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL file not found at ${idlPath}. Please run anchor build first.`);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = new anchor.web3.PublicKey(PROGRAM_ID);
  const program = new anchor.Program(idl, provider) as any;

  // 3. Derive PDAs (pool state is seeded with the ADMIN pubkey)
  const [poolStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), adminKeypair.publicKey.toBuffer()],
    programId
  );
  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolStatePda.toBuffer()],
    programId
  );
  console.log(`Pool State PDA: ${poolStatePda.toBase58()}`);
  console.log(`Vault PDA:      ${vaultPda.toBase58()}`);

  const relayerCommitmentBytes = Array.from(toBE32(relayerWallet.userCommitment));

  // Check if this (admin) pool is already initialized
  let alreadyInitialized = false;
  try {
    const poolState = await program.account.poolState.fetch(poolStatePda);
    console.log(`Pool State already exists! Admin: ${poolState.admin.toBase58()}`);
    alreadyInitialized = true;
  } catch (err) {
    console.log("Pool State does not exist. Initializing a fresh pool...");
  }

  if (!alreadyInitialized) {
    // Fund the admin so it can pay rent for the pool_state account.
    const adminBal = await connection.getBalance(adminKeypair.publicKey);
    if (adminBal < 50_000_000) {
      console.log("Funding admin from deployer (0.1 SOL for rent)...");
      const fundTx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: deployerKeypair.publicKey,
          toPubkey: adminKeypair.publicKey,
          lamports: 100_000_000,
        })
      );
      await anchor.web3.sendAndConfirmTransaction(connection, fundTx, [deployerKeypair]);
    }

    const tx = await program.methods
      .initialize(relayerCommitmentBytes, deployerKeypair.publicKey)
      .accounts({
        admin: adminKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      // initialize computes the 20 zero-subtree hashes on-chain (Poseidon syscall)
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })])
      .signers([adminKeypair])
      .rpc();

    console.log(`Initialization successful! Tx signature: ${tx}`);
  } else {
    console.log("Updating relayer configuration via set_relayer...");
    const tx = await program.methods
      .setRelayer(relayerCommitmentBytes, deployerKeypair.publicKey)
      .accounts({ admin: adminKeypair.publicKey })
      .signers([adminKeypair])
      .rpc();
    console.log(`set_relayer successful! Tx signature: ${tx}`);
  }

  // 4. Register the relayer wallet (one-time; "already in use" on re-runs is fine)
  const [registrationPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("registration_v2"), deployerKeypair.publicKey.toBuffer()],
    programId
  );
  const relayerEncKeyBytes = Array.from(bs58.decode(relayerWallet.encryption.publicKey));
  try {
    const tx = await program.methods
      .register(relayerCommitmentBytes, relayerEncKeyBytes)
      .accounts({
        user: deployerKeypair.publicKey,
        registration: registrationPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([deployerKeypair])
      .rpc();
    console.log(`Relayer registered! Tx signature: ${tx}`);
  } catch (err: any) {
    console.log("Relayer registration skipped (already registered)");
  }
  const registration = await program.account.registration.fetch(registrationPda);
  const onchainUC = BigInt("0x" + Buffer.from(registration.userCommitment).toString("hex")).toString();
  if (onchainUC !== relayerWallet.userCommitment) {
    throw new Error(`On-chain relayer registration mismatch: ${onchainUC} != ${relayerWallet.userCommitment}`);
  }
  const onchainEnc = bs58.encode(Buffer.from(registration.encryptionPublicKey));
  if (onchainEnc !== relayerWallet.encryption.publicKey) {
    throw new Error(`On-chain relayer encryption key mismatch: ${onchainEnc} != ${relayerWallet.encryption.publicKey}`);
  }

  // Fetch and print final state
  const poolState = await program.account.poolState.fetch(poolStatePda);
  console.log("\n========== FINAL ON-CHAIN POOL STATE ==========");
  console.log(`Program ID:         ${PROGRAM_ID}`);
  console.log(`Pool State PDA:     ${poolStatePda.toBase58()}`);
  console.log(`Vault PDA:          ${vaultPda.toBase58()}`);
  console.log(`Admin:              ${poolState.admin.toBase58()}`);
  console.log(`Relayer Address:    ${poolState.relayerAddress.toBase58()}`);
  console.log(`Relayer Commitment: ${BigInt("0x" + Buffer.from(poolState.relayerCommitment).toString("hex")).toString(10)}`);
  console.log(`Locked Balance:     ${poolState.lockedBalance.toString()} lamports`);
  console.log(`Next Index:         ${poolState.nextIdx.toString()}`);
  console.log("===============================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
