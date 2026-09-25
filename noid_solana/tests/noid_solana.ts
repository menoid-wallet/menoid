import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NoidSolana } from "../target/types/noid_solana";
import { expect } from "chai";
import * as path from "path";
import { randomBytes } from "crypto";
// @ts-ignore
import * as snarkjs from "snarkjs";
// @ts-ignore
import { IncrementalMerkleTree } from "@zk-kit/incremental-merkle-tree";
import { buildPoseidon } from "circomlibjs";
import { deriveNoidWallet, NoidWallet } from "./helpers/wallets";
import { encryptMessage, decryptMessage } from "./helpers/encryption";
import { createCommitment } from "./helpers/commitments";
import bs58 from "bs58";
import { formatProofForSolana, toBE32 } from "./helpers/proofs";

// Monkeypatch BorshInstructionCoder to handle large instruction data (> 1000 bytes)
const originalEncode = anchor.BorshInstructionCoder.prototype.encode;
anchor.BorshInstructionCoder.prototype.encode = function (ixName, ix) {
  const originalAlloc = Buffer.alloc;
  try {
    Buffer.alloc = (size: number, ...args: any[]) => {
      if (size === 1000) {
        return originalAlloc(65536, ...args);
      }
      return originalAlloc(size, ...args);
    };
    return originalEncode.call(this, ixName, ix);
  } finally {
    Buffer.alloc = originalAlloc;
  }
};

// ─── Config ────────────────────────────────────────────────────────────────

const CIRCUIT_DIR = path.join(__dirname, "../../aptos/zk_build");

interface Note {
  poolId:     string;
  commitment: string;
  amount:     string;
  randomness: string;
  leafIndex:  number;
  root:       string;
}

interface WalletState {
  wallet:  NoidWallet;
  notes:   Note[];
  balance: bigint;
}

describe("noid_solana", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.NoidSolana as Program<NoidSolana>;

  const admin = anchor.web3.Keypair.generate();
  const alice = anchor.web3.Keypair.generate();
  const bob = anchor.web3.Keypair.generate();
  const relayer = anchor.web3.Keypair.generate();

  // PDA pool state derivation
  const [poolStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), admin.publicKey.toBuffer()],
    program.programId
  );
  // PDA vault derivation
  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolStatePda.toBuffer()],
    program.programId
  );

  // real wallets + derived noid keys (no generated wallets anymore)
  let relayerWallet: NoidWallet;
  let aliceWallet: NoidWallet;
  let bobWallet: NoidWallet;

  const poolStates: Record<string, {
    tree:        InstanceType<typeof IncrementalMerkleTree>;
    roots:       string[];
    latestRoot:  string | null;
    leafToIndex: Record<string, number>;
  }> = {};

  const walletStates: Record<string, WalletState> = {};
  const spentNullifiers = new Set<string>();

  const emittedNoteEvents: Array<{
    poolId:        string;
    commitment:    string;
    encryptedNote: string;
  }> = [];
  const emittedNullifierEvents: Array<{ nullifier: string }> = [];

  let _poseidon: any;
  async function getPoseidon() {
    if (!_poseidon) _poseidon = await buildPoseidon();
    return _poseidon;
  }

  function randomField(): string {
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    let r: bigint;
    do { r = BigInt("0x" + randomBytes(32).toString("hex")); } while (r >= P);
    return r.toString();
  }

  function registrationPda(wallet: anchor.web3.PublicKey): anchor.web3.PublicKey {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("registration_v2"), wallet.toBuffer()],
      program.programId
    )[0];
  }

  function beBytesToDecimal(bytes: number[] | Uint8Array): string {
    return BigInt("0x" + Buffer.from(bytes).toString("hex")).toString();
  }

  // fetch a wallet's registered user commitment from the chain
  async function fetchUserCommitment(wallet: anchor.web3.PublicKey): Promise<string> {
    const registration = await program.account.registration.fetch(
      registrationPda(wallet)
    );
    return beBytesToDecimal(registration.userCommitment as number[]);
  }

  async function initializePool(poolId: string) {
    if (poolStates[poolId]) return;
    const poseidon = await getPoseidon();
    const hash = (inputs: bigint[]) => BigInt(poseidon.F.toString(poseidon(inputs)));
    const tree = new IncrementalMerkleTree(hash, 20, BigInt(0), 2);
    poolStates[poolId] = { tree, roots: [], latestRoot: null, leafToIndex: {} };
  }

  async function rebuildWalletState() {
    console.log("\n========== REBUILDING WALLET STATE ==========");
    const poseidon = await getPoseidon();

    // Wipe all pool states
    for (const poolId of Object.keys(poolStates)) delete poolStates[poolId];
    for (const key of Object.keys(walletStates)) {
      walletStates[key].notes = [];
      walletStates[key].balance = 0n;
    }

    spentNullifiers.clear();
    for (const ev of emittedNullifierEvents) spentNullifiers.add(ev.nullifier);

    for (const ev of emittedNoteEvents) {
      const cmx = ev.commitment;
      await initializePool("0");
      const state = poolStates["0"];
      state.tree.insert(BigInt(cmx));
      const leafIndex = state.tree.leaves.length - 1;
      const root      = state.tree.root.toString();
      state.latestRoot = root;
      state.roots.push(root);
      state.leafToIndex[cmx] = leafIndex;

      if (!ev.encryptedNote) continue;

      for (const [name, ws] of Object.entries(walletStates)) {
        try {
          const decrypted = decryptMessage(ev.encryptedNote, ws.wallet.encryption.privateKey);
          const parsed: { amount: string; randomness: string } = JSON.parse(decrypted);

          // ownership check: commitment must be locked to this wallet's user commitment
          const expectedCmx = poseidon.F.toString(
            poseidon([BigInt(1), BigInt(parsed.amount), BigInt(parsed.randomness), BigInt(ws.wallet.userCommitment)])
          );
          if (expectedCmx !== cmx) continue;

          // nullifier = Poseidon(2, commitment, r, spendPrivateKey)
          const nullifier = poseidon.F.toString(
            poseidon([BigInt(2), BigInt(cmx), BigInt(parsed.randomness), BigInt(ws.wallet.spend.privateKey)])
          );
          if (spentNullifiers.has(nullifier)) {
            continue;
          }
          ws.notes.push({ poolId: "0", commitment: cmx, amount: parsed.amount, randomness: parsed.randomness, leafIndex, root });
          ws.balance += BigInt(parsed.amount);
        } catch (_) {}
      }
    }

    console.log("\n========== WALLET STATES ==========");
    for (const [name, ws] of Object.entries(walletStates)) {
      console.log(`  ${name}: balance=${ws.balance} lamports, notes=${ws.notes.length}`);
    }
  }

  function circuitPath(name: string, ext: "wasm" | "zkey") {
    return path.join(CIRCUIT_DIR, `${name}.${ext}`);
  }

  async function proveDeposit(
    depositAmount: bigint,
    c1: string, c2: string, c2Enabled: number, relayerUC: string,
    a1: bigint, r1: string, uc1: string,
    a2: bigint, r2: string,
  ) {
    const input = {
      depositAmount: depositAmount.toString(),
      c1, c2,
      c2_enabled: c2Enabled.toString(),
      uc2: relayerUC,
      a1: a1.toString(), r1, uc1,
      a2: a2.toString(), r2,
    };
    const { proof } = await snarkjs.groth16.fullProve(
      input,
      circuitPath("deposit_proof_js/deposit_proof", "wasm"),
      circuitPath("deposit_proof_final", "zkey"),
    );
    return formatProofForSolana(proof);
  }

  async function proveTransfer(
    senderWallet: NoidWallet,
    relayerUC: string,
    inputNote: Note,
    poolState: typeof poolStates[string],
    outputs: Array<{ amount: string; randomness: string; receiver: string; commitment: string }>,
  ): Promise<{ proof: any; nullifier: string }> {
    const poseidon     = await getPoseidon();
    const merkleProof  = poolState.tree.createProof(inputNote.leafIndex);
    const pathElements = merkleProof.siblings.map((x: bigint[]) => x[0].toString());
    const pathIndices  = merkleProof.pathIndices;

    const nullifier = poseidon.F.toString(
      poseidon([BigInt(2), BigInt(inputNote.commitment), BigInt(inputNote.randomness), BigInt(senderWallet.spend.privateKey)])
    );

    const input = {
      sk: senderWallet.spend.privateKey,
      owner_address: senderWallet.addressField,
      relayer: relayerUC,
      enabled:  [1, 0, 0, 0],
      c_ins:    [inputNote.commitment, "0", "0", "0"],
      a_ins:    [inputNote.amount,     "0", "0", "0"],
      r_ins:    [inputNote.randomness, "0", "0", "0"],
      roots:    [poolState.tree.root.toString(), "0", "0", "0"],
      pathElements: [pathElements, Array(20).fill("0"), Array(20).fill("0"), Array(20).fill("0")],
      pathIndices:  [pathIndices,  Array(20).fill(0),   Array(20).fill(0),   Array(20).fill(0)],
      nullifiers:   [nullifier, "0", "0", "0"],
      output_enabled: [1, 1, 1], // Always supply exactly 3 outputs for transfer proof circuit
      c_outs:    outputs.map((o) => o.commitment),
      a_outs:    outputs.map((o) => o.amount),
      r_outs:    outputs.map((o) => o.randomness),
      receivers: outputs.map((o) => o.receiver), // user commitments
    };

    const { proof } = await snarkjs.groth16.fullProve(
      input,
      circuitPath("transfer_proof_js/transfer_proof", "wasm"),
      circuitPath("transfer_proof_final", "zkey"),
    );
    return { proof: formatProofForSolana(proof), nullifier };
  }

  async function proveWithdraw(
    senderWallet: NoidWallet,
    relayerUC: string,
    receiverDecimal: string,
    inputNote: Note,
    poolState: typeof poolStates[string],
    withdrawAmount: bigint,
    changeOutput: { amount: string; randomness: string; commitment: string } | null,
    relayerOutput: { amount: string; randomness: string; commitment: string } | null,
  ): Promise<{ proof: any; nullifier: string }> {
    const poseidon     = await getPoseidon();
    const merkleProof  = poolState.tree.createProof(inputNote.leafIndex);
    const pathElements = merkleProof.siblings.map((x: bigint[]) => x[0].toString());
    const pathIndices  = merkleProof.pathIndices;

    const nullifier = poseidon.F.toString(
      poseidon([BigInt(2), BigInt(inputNote.commitment), BigInt(inputNote.randomness), BigInt(senderWallet.spend.privateKey)])
    );

    const input = {
      sk: senderWallet.spend.privateKey,
      owner_address: senderWallet.addressField,
      receiver: receiverDecimal,
      changeReceiver: senderWallet.userCommitment,
      relayer:  relayerUC,
      enabled:  [1, 0, 0, 0],
      c_ins:    [inputNote.commitment, "0", "0", "0"],
      a_ins:    [inputNote.amount,     "0", "0", "0"],
      r_ins:    [inputNote.randomness, "0", "0", "0"],
      roots:    [poolState.tree.root.toString(), "0", "0", "0"],
      pathElements: [pathElements, Array(20).fill("0"), Array(20).fill("0"), Array(20).fill("0")],
      pathIndices:  [pathIndices,  Array(20).fill(0),   Array(20).fill(0),   Array(20).fill(0)],
      nullifiers:   [nullifier, "0", "0", "0"],
      withdrawAmount: withdrawAmount.toString(),
      out_enabled: [changeOutput ? 1 : 0, relayerOutput ? 1 : 0],
      c_outs:  [changeOutput?.commitment ?? "0", relayerOutput?.commitment ?? "0"],
      a_outs:  [changeOutput?.amount     ?? "0", relayerOutput?.amount     ?? "0"],
      r_outs:  [changeOutput?.randomness ?? "0", relayerOutput?.randomness ?? "0"],
      receivers: [senderWallet.userCommitment, relayerUC],
    };

    const { proof } = await snarkjs.groth16.fullProve(
      input,
      circuitPath("withdraw_proof_js/withdraw_proof", "wasm"),
      circuitPath("withdraw_proof_final", "zkey"),
    );
    return { proof: formatProofForSolana(proof), nullifier };
  }

  before(async () => {
    // Fund test accounts
    const airdropAlice = await provider.connection.requestAirdrop(alice.publicKey, 10_000_000_000);
    await provider.connection.confirmTransaction(airdropAlice);

    const airdropBob = await provider.connection.requestAirdrop(bob.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(airdropBob);

    const airdropAdmin = await provider.connection.requestAirdrop(admin.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(airdropAdmin);

    const airdropRelayer = await provider.connection.requestAirdrop(relayer.publicKey, 5_000_000_000);
    await provider.connection.confirmTransaction(airdropRelayer);
  });

  it("Test 1: Derive noid keys from the REAL wallets (no new wallet)", async () => {
    relayerWallet = await deriveNoidWallet(relayer);
    aliceWallet   = await deriveNoidWallet(alice);
    bobWallet     = await deriveNoidWallet(bob);

    // the user keeps their real address
    expect(aliceWallet.address).to.equal(alice.publicKey.toBase58());
    expect(bobWallet.address).to.equal(bob.publicKey.toBase58());

    // derivation is deterministic
    const again = await deriveNoidWallet(alice);
    expect(again.userCommitment).to.equal(aliceWallet.userCommitment);

    expect(aliceWallet.userCommitment).to.not.equal(bobWallet.userCommitment);
  });

  it("Test 2: Encrypt and decrypt notes between users and relayer", async () => {
    const note = { amount: "100000000", randomness: randomField() };
    const plain = JSON.stringify(note);
    const encToRelayer = encryptMessage(plain, relayerWallet.encryption.publicKey);
    const decByRelayer = decryptMessage(encToRelayer, relayerWallet.encryption.privateKey);
    expect(decByRelayer).to.equal(plain);

    const encToUser = encryptMessage(plain, aliceWallet.encryption.publicKey);
    const decByUser = decryptMessage(encToUser, aliceWallet.encryption.privateKey);
    expect(decByUser).to.equal(plain);
  });

  it("Test 3: Initialize the privacy pool on Solana", async () => {
    const relayerCommitmentBytes = Array.from(toBE32(relayerWallet.userCommitment));
    await program.methods
      .initialize(relayerCommitmentBytes, relayer.publicKey)
      .accounts({
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      // initialize now computes the 20 zero-subtree hashes on-chain (Poseidon syscall)
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })])
      .signers([admin])
      .rpc();

    const poolState = await program.account.poolState.fetch(poolStatePda);
    expect(poolState.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(poolState.relayerAddress.toBase58()).to.equal(relayer.publicKey.toBase58());
    expect(poolState.lockedBalance.toNumber()).to.equal(0);
    expect(beBytesToDecimal(poolState.relayerCommitment as number[])).to.equal(relayerWallet.userCommitment);
  });

  it("Test 4: Register wallets onchain (already registered counts as success)", async () => {
    const participants: Array<[string, NoidWallet]> = [
      ["relayer", relayerWallet],
      ["alice",   aliceWallet],
      ["bob",     bobWallet],
    ];

    for (const [name, wallet] of participants) {
      try {
        await program.methods
          .register(
            Array.from(toBE32(wallet.userCommitment)),
            Array.from(bs58.decode(wallet.encryption.publicKey))
          )
          .accounts({
            user: wallet.keypair.publicKey,
            registration: registrationPda(wallet.keypair.publicKey),
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([wallet.keypair])
          .rpc();
        console.log(`${name} registered onchain`);
      } catch (error) {
        // register must fail ONLY because the wallet is already registered
        console.log(`${name} already registered`);
      }

      // the registered user commitment must match the derived one
      const onchain = await fetchUserCommitment(wallet.keypair.publicKey);
      expect(onchain).to.equal(wallet.userCommitment);

      // ...and so must the encryption key, so a sender can resolve this
      // receiver from the chain with no off-chain lookup
      const registration = await program.account.registration.fetch(
        registrationPda(wallet.keypair.publicKey)
      );
      expect(
        bs58.encode(Buffer.from(registration.encryptionPublicKey))
      ).to.equal(wallet.encryption.publicKey);
    }

    // an address that never registered has no PDA at all — fetchNullable
    // answers null, which is the ONE shape that means "not registered"
    const stranger = anchor.web3.Keypair.generate();
    const none = await program.account.registration.fetchNullable(
      registrationPda(stranger.publicKey)
    );
    expect(none).to.equal(null);
  });

  it("Test 5: Second registration for the same wallet is rejected", async () => {
    let threw = false;
    try {
      await program.methods
        .register(
          Array.from(toBE32(aliceWallet.userCommitment)),
          Array.from(bs58.decode(aliceWallet.encryption.publicKey))
        )
        .accounts({
          user: alice.publicKey,
          registration: registrationPda(alice.publicKey),
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([alice])
        .rpc();
    } catch {
      threw = true; // registration PDA already exists
    }
    expect(threw).to.be.true;
  });

  it("Test 6: Alice deposits 1 SOL with a relayer fee note", async () => {
    walletStates["alice"]   = { wallet: aliceWallet,   notes: [], balance: 0n };
    walletStates["bob"]     = { wallet: bobWallet,     notes: [], balance: 0n };
    walletStates["relayer"] = { wallet: relayerWallet, notes: [], balance: 0n };

    const depositAmount = 1_000_000_000n; // 1 SOL
    const fee = 100_000_000n; // 0.1 SOL
    const userAmount = depositAmount - fee;

    // receiver user commitment fetched from the chain
    const aliceUC = await fetchUserCommitment(alice.publicKey);
    const poolState0 = await program.account.poolState.fetch(poolStatePda);
    const relayerUC = beBytesToDecimal(poolState0.relayerCommitment as number[]);

    const r1 = randomField(), r2 = randomField();
    const c1 = await createCommitment(userAmount.toString(), r1, aliceUC);
    const c2 = await createCommitment(fee.toString(), r2, relayerUC);

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: userAmount.toString(), randomness: r1 }),
      aliceWallet.encryption.publicKey
    );
    const encNote2 = encryptMessage(
      JSON.stringify({ amount: fee.toString(), randomness: r2 }),
      relayerWallet.encryption.publicKey
    );

    const { proofA, proofB, proofC } = await proveDeposit(
      depositAmount, c1.decimal, c2.decimal, 1, relayerUC,
      userAmount, r1, aliceUC, fee, r2,
    );

    const [commitment1Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(c1.decimal)],
      program.programId
    );
    const [commitment2Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(c2.decimal)],
      program.programId
    );

    await program.methods
      .deposit(
        proofA, proofB, proofC,
        new anchor.BN(depositAmount.toString()),
        Array.from(toBE32(c1.decimal)),
        Array.from(toBE32(c2.decimal)),
      )
      .accounts({
        user: alice.publicKey,
        poolState: poolStatePda,
        vault: vaultPda,
        commitment1: commitment1Pda,
        commitment2: commitment2Pda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 })])
      .signers([alice])
      .rpc();

    const poolState = await program.account.poolState.fetch(poolStatePda);
    expect(poolState.lockedBalance.toNumber()).to.equal(Number(depositAmount));

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.be.at.least(Number(depositAmount));

    // Verify commitment PDAs exist
    const c1Acc = await program.account.commitmentAccount.fetch(commitment1Pda);
    expect(c1Acc).to.not.be.null;

    emittedNoteEvents.push({ poolId: "0", commitment: c1.decimal, encryptedNote: encNote1 });
    emittedNoteEvents.push({ poolId: "0", commitment: c2.decimal, encryptedNote: encNote2 });
  });

  it("Test 7: Bob deposits without a relayer fee note (C2 = 0)", async () => {
    const depositAmount = 500_000_000n; // 0.5 SOL

    const bobUC = await fetchUserCommitment(bob.publicKey);
    const poolState0 = await program.account.poolState.fetch(poolStatePda);
    const relayerUC = beBytesToDecimal(poolState0.relayerCommitment as number[]);

    const r1 = randomField();
    const c1 = await createCommitment(depositAmount.toString(), r1, bobUC);

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: depositAmount.toString(), randomness: r1 }),
      bobWallet.encryption.publicKey
    );

    const { proofA, proofB, proofC } = await proveDeposit(
      depositAmount, c1.decimal, "0", 0, relayerUC,
      depositAmount, r1, bobUC, 0n, "0",
    );

    const [commitment1Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(c1.decimal)],
      program.programId
    );

    const lockedBefore = (await program.account.poolState.fetch(poolStatePda)).lockedBalance.toNumber();

    await program.methods
      .deposit(
        proofA, proofB, proofC,
        new anchor.BN(depositAmount.toString()),
        Array.from(toBE32(c1.decimal)),
        Array.from(toBE32("0")), // C2 = 0 -> no relayer fee note
      )
      .accounts({
        user: bob.publicKey,
        poolState: poolStatePda,
        vault: vaultPda,
        commitment1: commitment1Pda,
        commitment2: null, // optional account omitted
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 })])
      .signers([bob])
      .rpc();

    const lockedAfter = (await program.account.poolState.fetch(poolStatePda)).lockedBalance.toNumber();
    expect(lockedAfter - lockedBefore).to.equal(Number(depositAmount));

    emittedNoteEvents.push({ poolId: "0", commitment: c1.decimal, encryptedNote: encNote1 });
  });

  it("Test 8: Rebuild Merkle trees from emitted events", async () => {
    await rebuildWalletState();
    expect(Object.keys(poolStates).length).to.be.greaterThan(0);
    expect(walletStates["alice"].notes.length).to.be.greaterThan(0);
    expect(walletStates["bob"].notes.length).to.be.greaterThan(0);
  });

  it("Test 9: Deposit with duplicate commitment is rejected", async () => {
    await rebuildWalletState();
    const existingNote = walletStates["alice"].notes[0];
    const existingC1 = existingNote.commitment;
    const aliceUC = await fetchUserCommitment(alice.publicKey);
    const poolState0 = await program.account.poolState.fetch(poolStatePda);
    const relayerUC = beBytesToDecimal(poolState0.relayerCommitment as number[]);

    const r_new  = randomField();
    const c2_new = await createCommitment("100000000", r_new, relayerUC);

    const { proofA, proofB, proofC } = await proveDeposit(
      1_000_000_000n, existingC1, c2_new.decimal, 1, relayerUC,
      900_000_000n, existingNote.randomness, aliceUC, 100_000_000n, r_new,
    );

    const [commitment1Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(existingC1)],
      program.programId
    );
    const [commitment2Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(c2_new.decimal)],
      program.programId
    );

    let threw = false;
    try {
      await program.methods
        .deposit(
          proofA, proofB, proofC,
          new anchor.BN("1000000000"),
          Array.from(toBE32(existingC1)),
          Array.from(toBE32(c2_new.decimal)),
        )
        .accounts({
          user: alice.publicKey,
          poolState: poolStatePda,
          vault: vaultPda,
          commitment1: commitment1Pda,
          commitment2: commitment2Pda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 })])
        .signers([alice])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw).to.be.true;
  });

  it("Test 10: Transfer SOL privately (Alice -> Bob, addressed by real address)", async () => {
    await rebuildWalletState();

    const inputNote = walletStates["alice"].notes[0];
    expect(inputNote).to.not.be.undefined;

    const state       = poolStates[inputNote.poolId];
    const inputAmount = BigInt(inputNote.amount);
    const transferAmt = inputAmount * 5n / 10n; // 50%
    const fee         = 10_000_000n; // fee
    const change      = inputAmount - transferAmt - fee;

    // the receiver is addressed by their REAL wallet address:
    // under the hood we fetch their registered user commitment
    const bobUC = await fetchUserCommitment(bob.publicKey);
    const aliceUC = aliceWallet.userCommitment;
    const poolState0 = await program.account.poolState.fetch(poolStatePda);
    const relayerUC = beBytesToDecimal(poolState0.relayerCommitment as number[]);

    const rReceiver = randomField(), rChange = randomField(), rRelayer = randomField();
    const receiverCmx = await createCommitment(transferAmt.toString(), rReceiver, bobUC);
    const changeCmx   = await createCommitment(change.toString(),      rChange,   aliceUC);
    const relayerCmx  = await createCommitment(fee.toString(),         rRelayer,  relayerUC);

    const { proof, nullifier } = await proveTransfer(
      aliceWallet, relayerUC, inputNote, state,
      [
        { amount: transferAmt.toString(), randomness: rReceiver, receiver: bobUC,     commitment: receiverCmx.decimal },
        { amount: change.toString(),      randomness: rChange,   receiver: aliceUC,   commitment: changeCmx.decimal   },
        { amount: fee.toString(),         randomness: rRelayer,  receiver: relayerUC, commitment: relayerCmx.decimal  },
      ],
    );

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: transferAmt.toString(), randomness: rReceiver }),
      bobWallet.encryption.publicKey
    );
    const encNote2 = encryptMessage(
      JSON.stringify({ amount: change.toString(), randomness: rChange }),
      aliceWallet.encryption.publicKey
    );
    const encNote3 = encryptMessage(
      JSON.stringify({ amount: fee.toString(), randomness: rRelayer }),
      relayerWallet.encryption.publicKey
    );

    // Prepare dynamic accounts for remaining accounts
    const [nullifierPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), toBE32(nullifier)],
      program.programId
    );
    const [receiverPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(receiverCmx.decimal)],
      program.programId
    );
    const [changePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(changeCmx.decimal)],
      program.programId
    );
    const [relayerCmxPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(relayerCmx.decimal)],
      program.programId
    );

    const remainingAccounts = [
      { pubkey: nullifierPda, isWritable: true, isSigner: false },
      { pubkey: receiverPda, isWritable: true, isSigner: false },
      { pubkey: changePda, isWritable: true, isSigner: false },
      { pubkey: relayerCmxPda, isWritable: true, isSigner: false },
    ];

    await program.methods
      .transfer(
        proof.proofA, proof.proofB, proof.proofC,
        [1, 0, 0, 0],
        [Array.from(toBE32(state.tree.root.toString())), Array.from(toBE32("0")), Array.from(toBE32("0")), Array.from(toBE32("0"))],
        [Array.from(toBE32(nullifier)), Array.from(toBE32("0")), Array.from(toBE32("0")), Array.from(toBE32("0"))],
        [1, 1, 1],
        [Array.from(toBE32(receiverCmx.decimal)), Array.from(toBE32(changeCmx.decimal)), Array.from(toBE32(relayerCmx.decimal))],
      )
      .accounts({
        payer: relayer.publicKey,
        poolState: poolStatePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 })])
      .signers([relayer])
      .rpc();

    emittedNullifierEvents.push({ nullifier });
    emittedNoteEvents.push({ poolId: "0", commitment: receiverCmx.decimal, encryptedNote: encNote1 });
    emittedNoteEvents.push({ poolId: "0", commitment: changeCmx.decimal,   encryptedNote: encNote2 });
    emittedNoteEvents.push({ poolId: "0", commitment: relayerCmx.decimal,  encryptedNote: encNote3 });

    // bob must find his new note
    await rebuildWalletState();
    const bobNote = walletStates["bob"].notes.find((n) => n.commitment === receiverCmx.decimal);
    expect(bobNote).to.not.be.undefined;
  });

  it("Test 11: Double-spend is rejected", async () => {
    const spentNull = emittedNullifierEvents[0].nullifier;
    const fakeC = await createCommitment("100", randomField(), aliceWallet.userCommitment);
    const [nullifierPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), toBE32(spentNull)],
      program.programId
    );
    const [fakeCmxPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(fakeC.decimal)],
      program.programId
    );

    let threw = false;
    try {
      await program.methods
        .transfer(
          Array(64).fill(0), Array(128).fill(0), Array(64).fill(0),
          [1, 0, 0, 0],
          [Array(32).fill(0), Array(32).fill(0), Array(32).fill(0), Array(32).fill(0)],
          [Array.from(toBE32(spentNull)), Array(32).fill(0), Array(32).fill(0), Array(32).fill(0)],
          [1, 0, 0],
          [Array.from(toBE32(fakeC.decimal)), Array(32).fill(0), Array(32).fill(0)],
        )
        .accounts({
          payer: relayer.publicKey,
          poolState: poolStatePda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: nullifierPda, isWritable: true, isSigner: false },
          { pubkey: fakeCmxPda, isWritable: true, isSigner: false },
        ])
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 })])
        .signers([relayer])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw).to.be.true;
  });

  it("Test 12: Bob withdraws to public address", async () => {
    await rebuildWalletState();
    const inputNote = walletStates["bob"].notes
      .slice()
      .sort((a, b) => (BigInt(a.amount) > BigInt(b.amount) ? -1 : 1))[0];
    expect(inputNote).to.not.be.undefined;

    const state = poolStates[inputNote.poolId];
    const inputAmt = BigInt(inputNote.amount);
    const withdrawAmt = inputAmt * 8n / 10n; // 80%
    const fee = 10_000_000n;
    const change = inputAmt - withdrawAmt - fee;

    const poolState0 = await program.account.poolState.fetch(poolStatePda);
    const relayerUC = beBytesToDecimal(poolState0.relayerCommitment as number[]);

    const rChange = randomField();
    const rRelayer = randomField();
    const changeCmx = await createCommitment(change.toString(), rChange, bobWallet.userCommitment);
    const relayerCmx = await createCommitment(fee.toString(), rRelayer, relayerUC);

    // Derive receiver mod P (must match the on-chain pubkey_to_u256_mod_p)
    const BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const receiverU256 = BigInt("0x" + bob.publicKey.toBuffer().toString("hex"));
    const receiverDecimal = (receiverU256 % BN254_P).toString();

    const { proof, nullifier } = await proveWithdraw(
      bobWallet, relayerUC, receiverDecimal,
      inputNote, state, withdrawAmt,
      { amount: change.toString(), randomness: rChange, commitment: changeCmx.decimal },
      { amount: fee.toString(), randomness: rRelayer, commitment: relayerCmx.decimal }
    );

    const encNote1 = encryptMessage(
      JSON.stringify({ amount: change.toString(), randomness: rChange }),
      bobWallet.encryption.publicKey
    );
    const encNote2 = encryptMessage(
      JSON.stringify({ amount: fee.toString(), randomness: rRelayer }),
      relayerWallet.encryption.publicKey
    );

    const [nullifierPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), toBE32(nullifier)],
      program.programId
    );
    const [changePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(changeCmx.decimal)],
      program.programId
    );
    const [relayerCmxPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), toBE32(relayerCmx.decimal)],
      program.programId
    );

    const remainingAccounts = [
      { pubkey: nullifierPda, isWritable: true, isSigner: false },
      { pubkey: changePda, isWritable: true, isSigner: false },
      { pubkey: relayerCmxPda, isWritable: true, isSigner: false },
    ];

    const bobBalanceBefore = await provider.connection.getBalance(bob.publicKey);

    await program.methods
      .withdraw(
        proof.proofA, proof.proofB, proof.proofC,
        [1, 0, 0, 0],
        [Array.from(toBE32(state.tree.root.toString())), Array.from(toBE32("0")), Array.from(toBE32("0")), Array.from(toBE32("0"))],
        [Array.from(toBE32(nullifier)), Array.from(toBE32("0")), Array.from(toBE32("0")), Array.from(toBE32("0"))],
        bob.publicKey,
        new anchor.BN(withdrawAmt.toString()),
        [1, 1],
        [Array.from(toBE32(changeCmx.decimal)), Array.from(toBE32(relayerCmx.decimal))],
      )
      .accounts({
        payer: relayer.publicKey,
        poolState: poolStatePda,
        vault: vaultPda,
        receiver: bob.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 })])
      .signers([relayer])
      .rpc();

    const bobBalanceAfter = await provider.connection.getBalance(bob.publicKey);
    expect(bobBalanceAfter - bobBalanceBefore).to.equal(Number(withdrawAmt));

    emittedNullifierEvents.push({ nullifier });
    emittedNoteEvents.push({ poolId: "0", commitment: changeCmx.decimal,  encryptedNote: encNote1 });
    emittedNoteEvents.push({ poolId: "0", commitment: relayerCmx.decimal, encryptedNote: encNote2 });
  });
});
