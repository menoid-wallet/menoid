const { ethers } = require("hardhat");
const { expect } = require("chai");
const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");

const {
    deriveWallet
} = require("../helpers/wallets");

const {
    encryptMessage,
    decryptMessage
} = require("../helpers/encryption");

const {
    createCommitment
} = require("../helpers/commitments");

const circomlibjs = require("circomlibjs");

const {
    IncrementalMerkleTree
} = require("@zk-kit/incremental-merkle-tree");



// deployment addresses (written by scripts/deploy.js)
const deployments = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, "..", "deployments", "localhost.json"),
        "utf8"
    )
);

// global wallets (real signer + derived noid keys)
// name => { signer, address, spend, encryption, userCommitment }
const wallets = {};

// poolId => merkle tree state
const poolStates = {};

// name => { notes, balance }
const walletStates = {};
const spentNullifiers = new Set();


// contract + signers
let privatePool;

let relayerSigner;

let userSigner;

let user2Signer;

let poseidon;

function hash(inputs) {

    return BigInt(
        poseidon.F.toString(
            poseidon(inputs)
        )
    );
}

function toBytes32(decimal) {

    return ethers.utils.hexZeroPad(
        ethers.BigNumber
            .from(decimal)
            .toHexString(),
        32
    );
}

function toDecimal(value) {

    return ethers.BigNumber
        .from(value)
        .toString();
}

function randomFieldElement() {

    return ethers.BigNumber.from(
        ethers.utils.randomBytes(31)
    ).toString();
}

// format snarkjs proof for solidity call
async function formatProof(proof, publicSignals) {

    const calldata =
        await snarkjs.groth16.exportSolidityCallData(
            proof,
            publicSignals
        );

    const argv =
        calldata
            .replace(/["[\]\s]/g, "")
            .split(",");

    return {
        a: [argv[0], argv[1]],
        b: [
            [argv[2], argv[3]],
            [argv[4], argv[5]]
        ],
        c: [argv[6], argv[7]]
    };
}

// tree helper function
function initializePool(poolId) {

    // already initialized
    if (poolStates[poolId]) {
        return;
    }

    const ZERO_VALUE = BigInt(0);

    const tree =
        new IncrementalMerkleTree(
            hash,
            20,
            ZERO_VALUE,
            2
        );

    poolStates[poolId] = {

        tree,

        leafToIndex: {}
    };

    console.log(`\nPool ${poolId} initialized`);
}

// rebuild trees + wallet notes from emitted events
async function rebuildWalletState() {

    console.log("\n========== REBUILDING WALLET STATE ==========");

    const events =
        await privatePool.queryFilter(
            privatePool.filters.NoteCreated()
        );

    const nullifierEvents =
        await privatePool.queryFilter(
            privatePool.filters.NullifierSpent()
        );

    // reset trees
    for (const poolId of Object.keys(poolStates)) {

        const ZERO_VALUE = BigInt(0);

        poolStates[poolId].tree =
            new IncrementalMerkleTree(
                hash,
                20,
                ZERO_VALUE,
                2
            );

        poolStates[poolId].leafToIndex = {};
    }

    // clear states
    for (const key of Object.keys(walletStates)) {

        walletStates[key].notes = [];
        walletStates[key].balance =
            ethers.BigNumber.from(0);
    }

    spentNullifiers.clear();

    // spent nullifiers
    for (const event of nullifierEvents) {

        spentNullifiers.add(
            toDecimal(event.args.nullifier)
        );
    }

    // rebuild trees
    for (const event of events) {

        const poolId =
            event.args.poolId.toString();

        const commitment =
            BigInt(
                event.args.commitment.toString()
            );

        const encryptedNote =
            event.args.encryptedNote;

        initializePool(poolId);

        const state =
            poolStates[poolId];

        state.tree.insert(commitment);

        const leafIndex =
            state.tree.leaves.length - 1;

        state.leafToIndex[
            commitment.toString()
        ] = leafIndex;

        for (const [name, wallet] of Object.entries(wallets)) {

            try {

                const decrypted =
                    decryptMessage(
                        encryptedNote,
                        wallet.encryption.privateKey
                    );

                const parsed =
                    JSON.parse(decrypted);

                // ownership check:
                // commitment must equal Poseidon(1, amount, r, userCommitment)
                const expectedCommitment =
                    poseidon.F.toString(
                        poseidon([
                            1,
                            parsed.amount,
                            parsed.randomness,
                            wallet.userCommitment.decimal
                        ])
                    );

                if (expectedCommitment !== commitment.toString()) {
                    continue;
                }

                // nullifier = Poseidon(2, commitment, r, spendPrivateKey)
                const expectedNullifier =
                    poseidon.F.toString(
                        poseidon([
                            2,
                            commitment.toString(),
                            parsed.randomness,
                            wallet.spend.privateKey
                        ])
                    );

                if (
                    spentNullifiers.has(
                        expectedNullifier.toString()
                    )
                ) {
                    continue;
                }

                walletStates[name].notes.push({

                    poolId,

                    commitment:
                        commitment.toString(),

                    amount:
                        parsed.amount,

                    randomness:
                        parsed.randomness,

                    leafIndex
                });

                walletStates[name].balance =
                    walletStates[name].balance.add(
                        parsed.amount
                    );

                console.log(`${name} FOUND NOTE: ${parsed.amount}`);

            } catch (_) {

            }
        }
    }

    console.log("\n========== WALLET BALANCES ==========");

    for (const [name, state] of Object.entries(walletStates)) {
        console.log(
            `${name}: ${ethers.utils.formatEther(state.balance)} (${state.notes.length} notes)`
        );
    }
}

// pick the biggest unspent note of a wallet
function pickNote(name, minAmount) {

    const notes =
        walletStates[name].notes
            .slice()
            .sort((n1, n2) => {

                const a = ethers.BigNumber.from(n1.amount);
                const b = ethers.BigNumber.from(n2.amount);

                return a.gt(b) ? -1 : 1;
            });

    const note = notes[0];

    expect(
        note,
        `${name} has no notes`
    ).to.not.equal(undefined);

    expect(
        ethers.BigNumber.from(note.amount).gte(minAmount),
        `${name}'s biggest note is too small`
    ).to.equal(true);

    return note;
}


describe("Menoid user-commitment architecture", function () {


    it("Should derive noid keys and attach contracts", async function () {

        poseidon =
            await circomlibjs.buildPoseidon();

        const signers = await ethers.getSigners();

        // relayer
        relayerSigner = signers[0];

        // users
        userSigner = signers[1];
        user2Signer = signers[2];



        // derive wallets from the REAL wallet signatures
        // (no new wallet is generated - the user keeps their address)
        wallets["relayer"] =
            await deriveWallet(relayerSigner);

        wallets["user1"] =
            await deriveWallet(userSigner);

        wallets["user2"] =
            await deriveWallet(user2Signer);

        for (const [name, wallet] of Object.entries(wallets)) {

            walletStates[name] = {
                notes: [],
                balance: ethers.BigNumber.from(0)
            };

            console.log(`\n========== ${name.toUpperCase()} ==========`);

            console.log({
                address: wallet.address,
                spendPublicKey: wallet.spend.publicKey,
                userCommitment: wallet.userCommitment
            });
        }



        // attach deployed contract
        privatePool =
            await ethers.getContractAt(
                "NoidPool",
                deployments.noidPool
            );

        console.log(
            "\nPool Address:",
            privatePool.address
        );

        const code =
            await ethers.provider.getCode(
                privatePool.address
            );

        expect(code.length).to.be.greaterThan(2);
    });


    it("Should register wallets onchain (already registered counts as success)", async function () {

        for (const [name, wallet] of Object.entries(wallets)) {

            try {

                const tx =
                    await privatePool
                        .connect(wallet.signer)
                        .register(wallet.userCommitment.bytes32);

                await tx.wait();

                console.log(`${name} registered onchain`);

            } catch (error) {

                // register must fail ONLY because the wallet is already registered
                expect(
                    error.message
                ).to.include("Already registered");

                console.log(`${name} already registered`);
            }

            // the registered user commitment must match the derived one
            const onchain =
                await privatePool.registered(wallet.address);

            expect(onchain).to.equal(
                wallet.userCommitment.bytes32
            );
        }
    });


    it("Should reject a second registration for the same wallet", async function () {

        let reverted = false;

        try {

            const tx =
                await privatePool
                    .connect(userSigner)
                    .register(wallets["user1"].userCommitment.bytes32);

            await tx.wait();

        } catch (error) {

            reverted = true;

            expect(
                error.message
            ).to.include("Already registered");
        }

        expect(reverted).to.equal(true);
    });


    // Regression: the deposit circuit must bound its amounts.
    //
    // depositAmount === a1 + fee is a field equation. Without a range check on
    // a1/a2 it is satisfiable by wrapping around the BN254 prime: deposit 1 wei,
    // set a1 = 2^128 - 1 (which still passes the RangeCheck(128) that
    // transfer/withdraw apply, so the note stays spendable) and solve
    // a2 = (1 - a1) mod p. That mints a note of arbitrary value from dust and
    // lets the pool be drained. Witness generation must fail on a2's range check.
    it("Should reject a deposit proof that wraps the field to mint value", async function () {

        const p =
            21888242871839275222246405745257275088548364400416034343698204186575808495617n;

        const depositAmount = 1n;

        // largest value that still passes RangeCheck(128) downstream
        const a1 = (1n << 128n) - 1n;

        // the a2 that balances the field equation - huge, must be rejected
        const a2 = (depositAmount - a1 + p) % p;

        const r1 = randomFieldElement();
        const r2 = randomFieldElement();

        const uc1 =
            toDecimal(
                await privatePool.registered(wallets["user1"].address)
            );

        const uc2 =
            toDecimal(
                await privatePool.relayerCommitment()
            );

        const commitment1 =
            await createCommitment(a1.toString(), r1, uc1);

        const commitment2 =
            await createCommitment(a2.toString(), r2, uc2);

        const input = {
            depositAmount: depositAmount.toString(),
            c1: commitment1.decimal,
            c2: commitment2.decimal,
            c2_enabled: "1",
            uc2: uc2,
            a1: a1.toString(),
            r1: r1,
            uc1: uc1,
            a2: a2.toString(),
            r2: r2
        };

        let rejected = false;

        try {

            await snarkjs.groth16.fullProve(
                input,
                "build/deposit_proof_js/deposit_proof.wasm",
                "build/deposit_proof_final.zkey"
            );

        } catch (error) {

            rejected = true;

            // the range check on a2 is what stops it
            expect(error.message).to.include("Assert Failed");
        }

        expect(
            rejected,
            "field-wrapping deposit proof was generated - range checks are missing"
        ).to.equal(true);

        console.log("\n========== INFLATION PROOF REJECTED ==========");
    });


    it("Should verify deposit proof directly", async function () {

        const depositVerifier =
            await ethers.getContractAt(
                "DepositVerifier",
                deployments.depositVerifier
            );

        const user = wallets["user1"];

        // receiver user commitment is fetched from the chain
        const uc1 =
            toDecimal(
                await privatePool.registered(user.address)
            );

        const uc2 =
            toDecimal(
                await privatePool.relayerCommitment()
            );

        const depositAmount =
            ethers.utils.parseEther("1");

        const fee =
            ethers.utils.parseEther("0.01");

        const userAmount =
            depositAmount.sub(fee);

        const r1 = randomFieldElement();
        const r2 = randomFieldElement();

        const commitment1 =
            await createCommitment(
                userAmount.toString(),
                r1,
                uc1
            );

        const commitment2 =
            await createCommitment(
                fee.toString(),
                r2,
                uc2
            );

        const input = {

            depositAmount:
                depositAmount.toString(),

            c1:
                commitment1.decimal,

            c2:
                commitment2.decimal,

            c2_enabled:
                "1",

            uc2:
                uc2,

            a1:
                userAmount.toString(),

            r1:
                r1,

            uc1:
                uc1,

            a2:
                fee.toString(),

            r2:
                r2
        };

        const { proof, publicSignals } =
            await snarkjs.groth16.fullProve(
                input,
                "build/deposit_proof_js/deposit_proof.wasm",
                "build/deposit_proof_final.zkey"
            );

        console.log("\n========== PUBLIC SIGNALS ==========");
        console.log(publicSignals);

        const vKey = require("../build/deposit_verification_key.json");

        const offchainVerified =
            await snarkjs.groth16.verify(
                vKey,
                publicSignals,
                proof
            );

        expect(offchainVerified).to.equal(true);

        const { a, b, c } =
            await formatProof(proof, publicSignals);

        const verified =
            await depositVerifier.verifyProof(
                a,
                b,
                c,
                publicSignals
            );

        console.log("\n========== VERIFIED ==========");
        console.log(verified);

        expect(verified).to.equal(true);
    });


    it("Should deposit with a relayer fee note", async function () {

        const user = wallets["user1"];

        // receiver user commitment fetched from the chain
        const uc1 =
            toDecimal(
                await privatePool.registered(user.address)
            );

        const uc2 =
            toDecimal(
                await privatePool.relayerCommitment()
            );

        const depositAmount =
            ethers.utils.parseEther("10");

        const fee =
            ethers.utils.parseEther("0.01");

        const userAmount =
            depositAmount.sub(fee);

        const r1 = randomFieldElement();
        const r2 = randomFieldElement();

        const commitment1 =
            await createCommitment(
                userAmount.toString(),
                r1,
                uc1
            );

        const commitment2 =
            await createCommitment(
                fee.toString(),
                r2,
                uc2
            );

        console.log("\n========== COMMITMENTS ==========");
        console.log(commitment1);
        console.log(commitment2);

        const encryptedNote1 =
            encryptMessage(
                JSON.stringify({
                    amount: userAmount.toString(),
                    randomness: r1
                }),
                user.encryption.publicKey
            );

        const encryptedNote2 =
            encryptMessage(
                JSON.stringify({
                    amount: fee.toString(),
                    randomness: r2
                }),
                wallets["relayer"].encryption.publicKey
            );

        const input = {

            depositAmount:
                depositAmount.toString(),

            c1:
                commitment1.decimal,

            c2:
                commitment2.decimal,

            c2_enabled:
                "1",

            uc2:
                uc2,

            a1:
                userAmount.toString(),

            r1:
                r1,

            uc1:
                uc1,

            a2:
                fee.toString(),

            r2:
                r2
        };

        const { proof, publicSignals } =
            await snarkjs.groth16.fullProve(
                input,
                "build/deposit_proof_js/deposit_proof.wasm",
                "build/deposit_proof_final.zkey"
            );

        const { a, b, c } =
            await formatProof(proof, publicSignals);

        const tx =
            await privatePool
                .connect(userSigner)
                .deposit(
                    a,
                    b,
                    c,
                    commitment1.bytes32,
                    commitment2.bytes32,
                    encryptedNote1,
                    encryptedNote2,
                    {
                        value: depositAmount
                    }
                );

        const receipt = await tx.wait();

        const noteEvents =
            receipt.events.filter(
                (e) => e.event === "NoteCreated"
            );

        expect(noteEvents.length).to.equal(2);

        console.log("\n========== DEPOSIT DONE ==========");

        // decryption sanity check
        const userDecrypted =
            decryptMessage(
                encryptedNote1,
                user.encryption.privateKey
            );

        console.log("user decrypted:", userDecrypted);

        const relayerDecrypted =
            decryptMessage(
                encryptedNote2,
                wallets["relayer"].encryption.privateKey
            );

        console.log("relayer decrypted:", relayerDecrypted);
    });


    it("Should deposit without a relayer fee note (C2 = 0)", async function () {

        const user = wallets["user2"];

        const uc1 =
            toDecimal(
                await privatePool.registered(user.address)
            );

        const uc2 =
            toDecimal(
                await privatePool.relayerCommitment()
            );

        const depositAmount =
            ethers.utils.parseEther("2");

        const r1 = randomFieldElement();

        const commitment1 =
            await createCommitment(
                depositAmount.toString(),
                r1,
                uc1
            );

        const encryptedNote1 =
            encryptMessage(
                JSON.stringify({
                    amount: depositAmount.toString(),
                    randomness: r1
                }),
                user.encryption.publicKey
            );

        const input = {

            depositAmount:
                depositAmount.toString(),

            c1:
                commitment1.decimal,

            c2:
                "0",

            c2_enabled:
                "0",

            uc2:
                uc2,

            a1:
                depositAmount.toString(),

            r1:
                r1,

            uc1:
                uc1,

            a2:
                "0",

            r2:
                "0"
        };

        const { proof, publicSignals } =
            await snarkjs.groth16.fullProve(
                input,
                "build/deposit_proof_js/deposit_proof.wasm",
                "build/deposit_proof_final.zkey"
            );

        const { a, b, c } =
            await formatProof(proof, publicSignals);

        const tx =
            await privatePool
                .connect(user2Signer)
                .deposit(
                    a,
                    b,
                    c,
                    commitment1.bytes32,
                    ethers.constants.HashZero, // C2 = 0 -> no relayer fee note
                    encryptedNote1,
                    "0x",
                    {
                        value: depositAmount
                    }
                );

        const receipt = await tx.wait();

        const noteEvents =
            receipt.events.filter(
                (e) => e.event === "NoteCreated"
            );

        expect(noteEvents.length).to.equal(1);

        console.log("\n========== FEE-LESS DEPOSIT DONE ==========");
    });


    it("Should transfer privately between users", async function () {

        const sender = wallets["user1"];
        const receiver = wallets["user2"];

        // rebuild state from ALL events
        await rebuildWalletState();

        // transfer amounts
        const transferAmount =
            ethers.utils.parseEther("0.4");

        const fee =
            ethers.utils.parseEther("0.01");

        // sender note
        const inputNote =
            pickNote("user1", transferAmount.add(fee));

        console.log("\n========== INPUT NOTE ==========");
        console.log(inputNote);

        // pool
        const state =
            poolStates[inputNote.poolId];

        // merkle proof
        const proof =
            state.tree.createProof(
                inputNote.leafIndex
            );

        const inputAmount =
            ethers.BigNumber.from(
                inputNote.amount
            );

        const change =
            inputAmount
                .sub(transferAmount)
                .sub(fee);

        // the receiver is addressed by their REAL wallet address:
        // under the hood we fetch their registered user commitment
        const receiverUC =
            toDecimal(
                await privatePool.registered(receiver.address)
            );

        expect(receiverUC).to.not.equal("0");

        const senderUC =
            sender.userCommitment.decimal;

        const relayerUC =
            toDecimal(
                await privatePool.relayerCommitment()
            );

        // randomness
        const rReceiver = randomFieldElement();
        const rChange = randomFieldElement();
        const rRelayer = randomFieldElement();

        // commitments
        const receiverCommitment =
            await createCommitment(
                transferAmount.toString(),
                rReceiver,
                receiverUC
            );

        const changeCommitment =
            await createCommitment(
                change.toString(),
                rChange,
                senderUC
            );

        const relayerCommitment =
            await createCommitment(
                fee.toString(),
                rRelayer,
                relayerUC
            );

        // nullifier = Poseidon(2, commitment, r, spendPrivateKey)
        const nullifier =
            poseidon.F.toString(
                poseidon([
                    2,
                    inputNote.commitment,
                    inputNote.randomness,
                    sender.spend.privateKey
                ])
            );

        // encrypted notes
        const encryptedNote1 =
            encryptMessage(
                JSON.stringify({
                    amount: transferAmount.toString(),
                    randomness: rReceiver
                }),
                receiver.encryption.publicKey
            );

        const encryptedNote2 =
            encryptMessage(
                JSON.stringify({
                    amount: change.toString(),
                    randomness: rChange
                }),
                sender.encryption.publicKey
            );

        const encryptedNote3 =
            encryptMessage(
                JSON.stringify({
                    amount: fee.toString(),
                    randomness: rRelayer
                }),
                wallets["relayer"].encryption.publicKey
            );

        // circom input
        const input = {

            sk:
                sender.spend.privateKey,

            owner_address:
                toDecimal(sender.address),

            relayer:
                relayerUC,

            enabled:
                [1,0,0,0],

            c_ins: [
                inputNote.commitment,
                0,
                0,
                0
            ],

            a_ins: [
                inputNote.amount,
                0,
                0,
                0
            ],

            r_ins: [
                inputNote.randomness,
                0,
                0,
                0
            ],

            roots: [
                state.tree.root.toString(),
                0,
                0,
                0
            ],

            pathElements: [
                proof.siblings.map(
                    x => x[0].toString()
                ),
                Array(20).fill(0),
                Array(20).fill(0),
                Array(20).fill(0)
            ],

            pathIndices: [
                proof.pathIndices,
                Array(20).fill(0),
                Array(20).fill(0),
                Array(20).fill(0)
            ],

            nullifiers: [
                nullifier,
                0,
                0,
                0
            ],

            output_enabled:
                [1,1,1],

            c_outs: [
                receiverCommitment.decimal,
                changeCommitment.decimal,
                relayerCommitment.decimal
            ],

            a_outs: [
                transferAmount.toString(),
                change.toString(),
                fee.toString()
            ],

            r_outs: [
                rReceiver,
                rChange,
                rRelayer
            ],

            receivers: [
                receiverUC,
                senderUC,
                relayerUC
            ]
        };

        const { proof: zkProof, publicSignals } =
            await snarkjs.groth16.fullProve(
                input,
                "build/transfer_proof_js/transfer_proof.wasm",
                "build/transfer_proof_final.zkey"
            );

        console.log("\n========== PUBLIC SIGNALS ==========");
        console.log(publicSignals);

        const { a, b, c } =
            await formatProof(zkProof, publicSignals);

        const rootHex =
            toBytes32(state.tree.root.toString());

        // execute transfer
        const tx =
            await privatePool
                .connect(relayerSigner)
                .transfer([{
                    a,
                    b,
                    c,
                    inputs: {
                        enabled:
                            [1,0,0,0],

                        roots: [
                            rootHex,
                            ethers.constants.HashZero,
                            ethers.constants.HashZero,
                            ethers.constants.HashZero
                        ],

                        poolIds:
                            [inputNote.poolId,0,0,0],

                        nullifiers: [
                            toBytes32(nullifier),
                            ethers.constants.HashZero,
                            ethers.constants.HashZero,
                            ethers.constants.HashZero
                        ]
                    },

                    C1:
                        receiverCommitment.bytes32,

                    C2:
                        changeCommitment.bytes32,

                    C3:
                        relayerCommitment.bytes32,

                    encryptedNote1,
                    encryptedNote2,
                    encryptedNote3
                }]);

        await tx.wait();

        console.log("\n========== TRANSFER DONE ==========");

        // recompute ALL states
        const receiverBalanceBefore =
            walletStates["user2"].balance;

        await rebuildWalletState();

        // receiver must have found the new note
        expect(
            walletStates["user2"].balance.gte(
                receiverBalanceBefore.add(transferAmount)
            )
        ).to.equal(true);
    });


    it("Should withdraw privately", async function () {

        const sender = wallets["user1"];

        // rebuild latest state
        await rebuildWalletState();

        // amounts
        const withdrawAmount =
            ethers.utils.parseEther("0.4");

        const fee =
            ethers.utils.parseEther("0.01");

        // pick note
        const inputNote =
            pickNote("user1", withdrawAmount.add(fee));

        console.log("\n========== WITHDRAW INPUT NOTE ==========");
        console.log(inputNote);

        // pool state
        const state =
            poolStates[inputNote.poolId];

        // merkle proof
        const proof =
            state.tree.createProof(
                inputNote.leafIndex
            );

        const inputAmount =
            ethers.BigNumber.from(
                inputNote.amount
            );

        const change =
            inputAmount
                .sub(withdrawAmount)
                .sub(fee);

        const senderUC =
            sender.userCommitment.decimal;

        const relayerUC =
            toDecimal(
                await privatePool.relayerCommitment()
            );

        // randomness
        const rChange = randomFieldElement();
        const rRelayer = randomFieldElement();

        // change note back to sender
        const changeCommitment =
            await createCommitment(
                change.toString(),
                rChange,
                senderUC
            );

        // relayer fee note
        const relayerCommitment =
            await createCommitment(
                fee.toString(),
                rRelayer,
                relayerUC
            );

        // nullifier
        const nullifier =
            poseidon.F.toString(
                poseidon([
                    2,
                    inputNote.commitment,
                    inputNote.randomness,
                    sender.spend.privateKey
                ])
            );

        // encrypted notes
        const encryptedNote1 =
            encryptMessage(
                JSON.stringify({
                    amount: change.toString(),
                    randomness: rChange
                }),
                sender.encryption.publicKey
            );

        const encryptedNote2 =
            encryptMessage(
                JSON.stringify({
                    amount: fee.toString(),
                    randomness: rRelayer
                }),
                wallets["relayer"].encryption.publicKey
            );

        // circom input
        const input = {

            sk:
                sender.spend.privateKey,

            owner_address:
                toDecimal(sender.address),

            receiver:
                toDecimal(userSigner.address),

            changeReceiver:
                senderUC,

            relayer:
                relayerUC,

            enabled:
                [1,0,0,0],

            c_ins: [
                inputNote.commitment,
                0,
                0,
                0
            ],

            a_ins: [
                inputNote.amount,
                0,
                0,
                0
            ],

            r_ins: [
                inputNote.randomness,
                0,
                0,
                0
            ],

            roots: [
                state.tree.root.toString(),
                0,
                0,
                0
            ],

            pathElements: [
                proof.siblings.map(
                    x => x[0].toString()
                ),
                Array(20).fill(0),
                Array(20).fill(0),
                Array(20).fill(0)
            ],

            pathIndices: [
                proof.pathIndices,
                Array(20).fill(0),
                Array(20).fill(0),
                Array(20).fill(0)
            ],

            nullifiers: [
                nullifier,
                0,
                0,
                0
            ],

            withdrawAmount:
                withdrawAmount.toString(),

            out_enabled:
                [1,1],

            a_outs: [
                change.toString(),
                fee.toString()
            ],

            r_outs: [
                rChange,
                rRelayer
            ],

            c_outs: [
                changeCommitment.decimal,
                relayerCommitment.decimal
            ],

            receivers: [
                senderUC,
                relayerUC
            ]
        };

        const {
            proof: zkProof,
            publicSignals
        } =
            await snarkjs.groth16.fullProve(
                input,
                "build/withdraw_proof_js/withdraw_proof.wasm",
                "build/withdraw_proof_final.zkey"
            );

        console.log("\n========== PUBLIC SIGNALS ==========");
        console.log(publicSignals);

        const { a, b, c } =
            await formatProof(zkProof, publicSignals);

        const rootHex =
            toBytes32(state.tree.root.toString());

        // balances before
        const before =
            await ethers.provider.getBalance(
                userSigner.address
            );

        // withdraw
        const tx =
            await privatePool
                .connect(relayerSigner)
                .withdraw(
                    [{
                        a,
                        b,
                        c,
                        inputs: {
                            enabled:
                                [1,0,0,0],

                            roots: [
                                rootHex,
                                ethers.constants.HashZero,
                                ethers.constants.HashZero,
                                ethers.constants.HashZero
                            ],

                            poolIds:
                                [inputNote.poolId,0,0,0],

                            nullifiers: [
                                toBytes32(nullifier),
                                ethers.constants.HashZero,
                                ethers.constants.HashZero,
                                ethers.constants.HashZero
                            ]
                        },

                        C1:
                            changeCommitment.bytes32,

                        C2:
                            relayerCommitment.bytes32,

                        encryptedNote1,
                        encryptedNote2,

                        withdrawAmount:
                            withdrawAmount
                    }],
                    userSigner.address
                );

        await tx.wait();

        // balances after
        const after =
            await ethers.provider.getBalance(
                userSigner.address
            );

        console.log("\n========== WITHDRAW DONE ==========");

        console.log(
            "balance delta:",
            ethers.utils.formatEther(after.sub(before))
        );

        expect(
            after.sub(before).eq(withdrawAmount)
        ).to.equal(true);

        // rebuild latest state
        await rebuildWalletState();
    });

});
