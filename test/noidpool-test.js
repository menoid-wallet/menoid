const { ethers } = require("hardhat");
const { expect } = require("chai");
const snarkjs = require("snarkjs");

const {
    generatePrivateWallet
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



// global relayer wallet
let relayerWallet;

// global users wallets
const userWallets = [];

// poolId => merkle tree state
const poolStates = {};

const walletStates = {};
const spentNullifiers = new Set();


// contract + signers
let privatePool;

let relayerSigner;

let userSigner;

// tree helper function
async function initializePool(poolId) {

    // already initialized
    if (poolStates[poolId]) {
        return;
    }

    const poseidon =
        await circomlibjs.buildPoseidon();

    const hash = (inputs) => {

        return BigInt(
            poseidon.F.toString(
                poseidon(inputs)
            )
        );
    };

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

        roots: [],

        latestRoot: null,

        leafToIndex: {}
    };

    console.log(`\nPool ${poolId} initialized`);
}

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

    for (const poolId of Object.keys(poolStates)) {

        const poseidon =
            await circomlibjs.buildPoseidon();

        const hash = (inputs) => {

            return BigInt(
                poseidon.F.toString(
                    poseidon(inputs)
                )
            );
        };
        const ZERO_VALUE = BigInt(0);

        poolStates[poolId].tree =
            new IncrementalMerkleTree(
                hash,
                20,
                ZERO_VALUE,
                2
            );

        poolStates[poolId].roots = [];
        poolStates[poolId].latestRoot = null;
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
            ethers.BigNumber
            .from(event.args.nullifier)
            .toString()
        );
    }

    console.log("spent nullifiers",spentNullifiers);

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

        await initializePool(poolId);

        const state =
            poolStates[poolId];

        state.tree.insert(commitment);

        const leafIndex =
            state.tree.leaves.length - 1;

        const root =
            state.tree.root.toString();

        for (const [name, wallet] of Object.entries(walletStates)) {

            try {

                const decrypted =
                    decryptMessage(
                        encryptedNote,
                        wallet.wallet.privateWallet.privateKey
                    );

                const parsed =
                    JSON.parse(decrypted);
                console.log("parsed: ",parsed);

                const poseidon =
                    await circomlibjs.buildPoseidon();

                const expectedNullifier =
                    poseidon.F.toString(
                        poseidon([
                            2,
                            commitment.toString(),
                            parsed.randomness,
                            wallet.wallet.zk.secretKey
                        ])
                    );
                console.log("computed nullifier: ",expectedNullifier);

                if (
                    spentNullifiers.has(
                        expectedNullifier.toString()
                    )
                ) {
                    console.log("nullifier already present");
                    continue;
                }

                wallet.notes.push({

                    poolId,

                    commitment:
                        commitment.toString(),

                    amount:
                        parsed.amount,

                    randomness:
                        parsed.randomness,

                    leafIndex,

                    root
                });

                wallet.balance =
                    wallet.balance.add(
                        parsed.amount
                    );

                console.log(`\n${name} FOUND NOTE`);

                console.log(parsed);

            } catch (_) {

            }
        }
    }

    console.log("\n========== WALLET STATES ==========");

    console.log(walletStates);
}

describe("PriFi Wallet Architecture", function () {
    

    it("Should generate deterministic private wallets and zk keys", async function () {

        const signers = await ethers.getSigners();

        // relayer
        relayerSigner = signers[0];

        // user
        userSigner = signers[1];



        const relayerSignature =
            await relayerSigner.signMessage(
                "PriFi private financial dapp"
            );

        relayerWallet =
            await generatePrivateWallet(
                relayerSignature
            );

        console.log("\n========== RELAYER ==========");
        console.log(relayerWallet);



        // users
        const users = signers.slice(1, 6);

        for (let i = 0; i < users.length; i++) {

            const signer = users[i];

            const signature =
                await signer.signMessage(
                    "PriFi private financial dapp"
                );

            const wallet =
                await generatePrivateWallet(
                    signature
                );

            userWallets.push(wallet);

            console.log(`\n========== USER ${i + 1} ==========`);

            console.log(wallet);
        }

        console.log("\n========== ALL USERS ==========");
        console.log(userWallets);



        // attach deployed contract
        privatePool =
            await ethers.getContractAt(
                "NoidPool",
                "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6"
            );
        console.log(
            "Pool Address:",
            privatePool.address
        );

        const code =
            await ethers.provider.getCode(
                privatePool.address
            );

        console.log(
            "Code Length:",
            code.length
        );

        console.log(code);
    });


    it("Should encrypt and decrypt notes between users and relayer", async function () {

        // random user
        const user = userWallets[2];

        // sample note
        const note = {

            amount: "100",

            randomness:
                ethers.BigNumber.from(
                    ethers.utils.randomBytes(31)
                ).toString(),

            zkPublicKey:
                user.zk.publicKey
        };

        // serialize note
        const plaintext =
            JSON.stringify(note);

        console.log("\n========== ORIGINAL NOTE ==========");
        console.log(plaintext);




        // USER -> RELAYER

        const encryptedToRelayer =
            encryptMessage(
                plaintext,
                relayerWallet.privateWallet.publicKey
            );

        console.log("\n========== ENCRYPTED TO RELAYER ==========");
        console.log(encryptedToRelayer);

        const decryptedByRelayer =
            decryptMessage(
                encryptedToRelayer,
                relayerWallet.privateWallet.privateKey
            );

        console.log("\n========== RELAYER DECRYPTED ==========");
        console.log(decryptedByRelayer);





        // RELAYER -> USER

        const encryptedToUser =
            encryptMessage(
                plaintext,
                user.privateWallet.publicKey
            );

        console.log("\n========== ENCRYPTED TO USER ==========");
        console.log(encryptedToUser);

        const decryptedByUser =
            decryptMessage(
                encryptedToUser,
                user.privateWallet.privateKey
            );

        console.log("\n========== USER DECRYPTED ==========");
        console.log(decryptedByUser);
    });


    it("Should verify deposit proof directly", async function () {

        const depositVerifier =
        await ethers.getContractAt(
            "DepositVerifier",
            "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
        );
        const code =
            await ethers.provider.getCode(
                depositVerifier.address
            );
        console.log("deposit verifier length:",code.length);
        // -------------------------
        // VALUES
        // -------------------------

        const depositAmount =
            ethers.utils.parseEther("1");

        const fee =
            ethers.utils.parseEther("0.01");

        const userAmount =
            depositAmount.sub(fee);



        // -------------------------
        // RANDOMNESS
        // -------------------------

        const r1 =
            ethers.BigNumber.from(
                ethers.utils.randomBytes(31)
            ).toString();

        const r2 =
            ethers.BigNumber.from(
                ethers.utils.randomBytes(31)
            ).toString();





        // -------------------------
        // USER + RELAYER
        // -------------------------

        const user =
            userWallets[0];



        // -------------------------
        // COMMITMENTS
        // -------------------------

        const commitment1 =
            await createCommitment(
                userAmount.toString(),
                r1,
                user.zk.publicKey
            );



        const commitment2 =
            await createCommitment(
                fee.toString(),
                r2,
                relayerWallet.zk.publicKey
            );



        console.log("\n========== COMMITMENTS ==========");

        console.log(commitment1);

        console.log(commitment2);



        // -------------------------
        // CIRCOM INPUT
        // -------------------------

        const input = {

            depositAmount:
                depositAmount.toString(),

            pk2:
                relayerWallet.zk.publicKey,

            c1:
                commitment1.decimal,

            c2:
                commitment2.decimal,

            a1:
                userAmount.toString(),

            r1:
                r1,

            pk1:
                user.zk.publicKey,

            a2:
                fee.toString(),

            r2:
                r2
        };



        console.log("\n========== CIRCOM INPUT ==========");

        console.log(input);



        // -------------------------
        // GENERATE PROOF
        // -------------------------

        const { proof, publicSignals } =
            await snarkjs.groth16.fullProve(

                input,

                "build/deposit_proof_js/deposit_proof.wasm",

                "build/deposit_proof_final.zkey"
            );



        console.log("\n========== PUBLIC SIGNALS ==========");

        console.log(publicSignals);



        // -------------------------
        // FORMAT PROOF
        // -------------------------

        const calldata =
            await snarkjs.groth16.exportSolidityCallData(
                proof,
                publicSignals
            );



        const argv =
            calldata
                .replace(/["[\]\s]/g, "")
                .split(",");



        const a = [
            argv[0],
            argv[1]
        ];



        const b = [
            [argv[2], argv[3]],
            [argv[4], argv[5]]
        ];



        const c = [
            argv[6],
            argv[7]
        ];



        console.log("\n========== PROOF ==========");

        console.log("a:", a);

        console.log("b:", b);

        console.log("c:", c);


        const vKey = require("../build/deposit_verification_key.json");

        const offchainVerified =
            await snarkjs.groth16.verify(
                vKey,
                publicSignals,
                proof
            );

        console.log(
            "\n========== OFFCHAIN VERIFIED =========="
        );

        console.log(offchainVerified);
        

        // -------------------------
        // VERIFY DIRECTLY
        // -------------------------

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


    it("Should deposit ", async function () {

        const user =
            userWallets[0];



        // -------------------------
        // VALUES
        // -------------------------

        const depositAmount =
            ethers.utils.parseEther("10");

        const fee =
            ethers.utils.parseEther("0.01");

        const userAmount =
            depositAmount.sub(fee);



        // -------------------------
        // RANDOMNESS
        // -------------------------

        const r1 =
            ethers.BigNumber.from(
                ethers.utils.randomBytes(31)
            ).toString();

        const r2 =
            ethers.BigNumber.from(
                ethers.utils.randomBytes(31)
            ).toString();



        // -------------------------
        // COMMITMENTS
        // -------------------------

        const commitment1 =
            await createCommitment(
                userAmount.toString(),
                r1,
                user.zk.publicKey
            );

        const commitment2 =
            await createCommitment(
                fee.toString(),
                r2,
                relayerWallet.zk.publicKey
            );



        console.log("\n========== COMMITMENTS ==========");

        console.log(commitment1);

        console.log(commitment2);




        // -------------------------
        // ENCRYPTED NOTES
        // -------------------------

        const note1 =
            JSON.stringify({

                amount:
                    userAmount.toString(),

                randomness:
                    r1
            });

        const note2 =
            JSON.stringify({

                amount:
                    fee.toString(),

                randomness:
                    r2
            });



        const encryptedNote1 =
            encryptMessage(
                note1,
                user.privateWallet.publicKey
            );

        const encryptedNote2 =
            encryptMessage(
                note2,
                relayerWallet.privateWallet.publicKey
            );



        console.log("\n========== ENCRYPTED NOTES ==========");

        console.log(encryptedNote1);

        console.log(encryptedNote2);




        // -------------------------
        // CIRCOM INPUT
        // -------------------------

        const input = {

            depositAmount:
                depositAmount.toString(),

            c1:
                commitment1.decimal,

            c2:
                commitment2.decimal,

            a1:
                userAmount.toString(),

            r1:
                r1,

            pk1:
                user.zk.publicKey,

            a2:
                fee.toString(),

            r2:
                r2,

            pk2:
                relayerWallet.zk.publicKey
        };



        console.log("\n========== CIRCOM INPUT ==========");

        console.log(input);




        // -------------------------
        // GENERATE PROOF
        // -------------------------

        const { proof, publicSignals } =
            await snarkjs.groth16.fullProve(

                input,

                "build/deposit_proof_js/deposit_proof.wasm",

                "build/deposit_proof_final.zkey"
            );



        console.log("\n========== PUBLIC SIGNALS ==========");

        console.log(publicSignals);




        // -------------------------
        // FORMAT CALLDATA
        // -------------------------

        const calldata =
            await snarkjs.groth16.exportSolidityCallData(
                proof,
                publicSignals
            );



        const argv =
            calldata
                .replace(/["[\]\s]/g, "")
                .split(",");



        const a = [
            argv[0],
            argv[1]
        ];



        const b = [
            [argv[2], argv[3]],
            [argv[4], argv[5]]
        ]



        const c = [
            argv[6],
            argv[7]
        ];



        console.log("\n========== PROOF ==========");

        console.log("a:", a);

        console.log("b:", b);

        console.log("c:", c);




        // -------------------------
        // BALANCES BEFORE
        // -------------------------

        const userBalanceBefore =
            await ethers.provider.getBalance(
                userSigner.address
            );



        const relayerBalanceBefore =
            await ethers.provider.getBalance(
                relayerSigner.address
            );



        console.log("\n========== BALANCES BEFORE ==========");

        console.log(
            "User:",
            ethers.utils.formatEther(
                userBalanceBefore
            )
        );

        console.log(
            "Relayer:",
            ethers.utils.formatEther(
                relayerBalanceBefore
            )
        );




        // -------------------------
        // DEPOSIT
        // -------------------------

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
                        value:
                            depositAmount
                    }
                );



        const receipt =
            await tx.wait();




        // -------------------------
        // EVENTS
        // -------------------------

        console.log("\n========== EVENTS ==========");
        console.log("type of",
                typeof privatePool.deposit
            );


        console.log( "receipt: " , receipt);
        console.log("recipt logs: ",receipt.logs);
        for (const event of receipt.events) {

            console.log("\nEVENT:");

            console.log(event.event);

            console.log(event.args);
        }




        // -------------------------
        // BALANCES AFTER
        // -------------------------

        const userBalanceAfter =
            await ethers.provider.getBalance(
                userSigner.address
            );



        const relayerBalanceAfter =
            await ethers.provider.getBalance(
                relayerSigner.address
            );



        console.log("\n========== BALANCES AFTER ==========");

        console.log(
            "User:",
            ethers.utils.formatEther(
                userBalanceAfter
            )
        );

        console.log(
            "Relayer:",
            ethers.utils.formatEther(
                relayerBalanceAfter
            )
        );




        // -------------------------
        // USER DECRYPTION
        // -------------------------

        const userDecrypted =
            decryptMessage(
                encryptedNote1,
                user.privateWallet.privateKey
            );



        console.log("\n========== USER DECRYPTED ==========");

        console.log(userDecrypted);




        // -------------------------
        // RELAYER DECRYPTION
        // -------------------------

        const relayerDecrypted =
            decryptMessage(
                encryptedNote2,
                relayerWallet.privateWallet.privateKey
            );



        console.log("\n========== RELAYER DECRYPTED ==========");

        console.log(relayerDecrypted);
    });

    it("Should rebuild merkle trees from emitted events", async function () {

        console.log("\n========== FETCHING EVENTS ==========");



        // fetch all NoteCreated events
        const events =
            await privatePool.queryFilter(
                privatePool.filters.NoteCreated()
            );



        console.log(
            "Total NoteCreated Events:",
            events.length
        );



        // rebuild trees from history
        for (const event of events) {

            const poolId =
                event.args.poolId.toString();

            const commitment =
                BigInt(
                    event.args.commitment.toString()
                );



            console.log("\n========== NOTE ==========");

            console.log(
                "PoolId:",
                poolId
            );

            console.log(
                "Commitment:",
                commitment.toString()
            );



            // initialize tree
            await initializePool(poolId);



            const state =
                poolStates[poolId];



            // insert commitment
            state.tree.insert(commitment);



            // latest root
            const root =
                state.tree.root.toString();

            state.latestRoot =
                root;

            state.roots.push(root);



            // leaf index
            const leafIndex =
                state.tree.leaves.length - 1;

            state.leafToIndex[
                commitment.toString()
            ] = leafIndex;



            console.log(
                "Leaf Index:",
                leafIndex
            );

            console.log(
                "Latest Root:",
                root
            );
        }



        console.log("\n========== FINAL POOL STATES ==========");

        console.log(poolStates);
    });

    it("Should transfer privately between users", async function () {

    const sender =
        userWallets[0];

    const receiver =
        userWallets[1];

    // wallet states
    walletStates["user1"] = {
        wallet: sender,
        notes: [],
        balance: ethers.BigNumber.from(0)
    };

    walletStates["user2"] = {
        wallet: receiver,
        notes: [],
        balance: ethers.BigNumber.from(0)
    };

    walletStates["relayer"] = {
        wallet: relayerWallet,
        notes: [],
        balance: ethers.BigNumber.from(0)
    };

    // rebuild state from ALL events
    await rebuildWalletState();

    // sender note
    const inputNote =
        walletStates["user1"].notes[0];

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

    console.log("\n========== MERKLE PROOF ==========");

    console.log(proof);

    // transfer amounts
    const transferAmount =
        ethers.utils.parseEther("0.4");

    const fee =
        ethers.utils.parseEther("0.01");

    const inputAmount =
        ethers.BigNumber.from(
            inputNote.amount
        );

    const change =
        inputAmount
            .sub(transferAmount)
            .sub(fee);

    // randomness
    const rReceiver =
        ethers.BigNumber.from(
            ethers.utils.randomBytes(31)
        ).toString();

    const rChange =
        ethers.BigNumber.from(
            ethers.utils.randomBytes(31)
        ).toString();

    const rRelayer =
        ethers.BigNumber.from(
            ethers.utils.randomBytes(31)
        ).toString();

    // commitments
    const receiverCommitment =
        await createCommitment(
            transferAmount.toString(),
            rReceiver,
            receiver.zk.publicKey
        );

    const changeCommitment =
        await createCommitment(
            change.toString(),
            rChange,
            sender.zk.publicKey
        );

    const relayerCommitment =
        await createCommitment(
            fee.toString(),
            rRelayer,
            relayerWallet.zk.publicKey
        );

    console.log("\n========== OUTPUT COMMITMENTS ==========");

    console.log(receiverCommitment);

    console.log(changeCommitment);

    console.log(relayerCommitment);

    // poseidon
    const poseidon =
        await circomlibjs.buildPoseidon();

    // nullifier
    const nullifier =
        poseidon.F.toString(
            poseidon([
                2,
                inputNote.commitment,
                inputNote.randomness,
                sender.zk.secretKey
            ])
        );

    console.log("\n========== NULLIFIER ==========");

    console.log(nullifier);

    // encrypted notes
    const encryptedNote1 =
        encryptMessage(
            JSON.stringify({
                amount:
                    transferAmount.toString(),
                randomness:
                    rReceiver
            }),
            receiver.privateWallet.publicKey
        );

    const encryptedNote2 =
        encryptMessage(
            JSON.stringify({
                amount:
                    change.toString(),
                randomness:
                    rChange
            }),
            sender.privateWallet.publicKey
        );

    const encryptedNote3 =
        encryptMessage(
            JSON.stringify({
                amount:
                    fee.toString(),
                randomness:
                    rRelayer
            }),
            relayerWallet.privateWallet.publicKey
        );

    // circom input
    const input = {

        sk:
            sender.zk.secretKey,

        pk:
            sender.zk.publicKey,

        relayer:
            relayerWallet.zk.publicKey,

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
            receiver.zk.publicKey,
            sender.zk.publicKey,
            relayerWallet.zk.publicKey
        ]
    };

    console.log("\n========== TRANSFER INPUT ==========");

    console.log(input);

    // proof
    const { proof: zkProof, publicSignals } =
        await snarkjs.groth16.fullProve(

            input,

            "build/transfer_proof_js/transfer_proof.wasm",

            "build/transfer_proof_final.zkey"
        );

    console.log("\n========== PUBLIC SIGNALS ==========");

    console.log(publicSignals);

    const calldata =
        await snarkjs.groth16.exportSolidityCallData(
            zkProof,
            publicSignals
        );

    const argv =
        calldata
            .replace(/["[\]\s]/g, "")
            .split(",");

    const a = [
        argv[0],
        argv[1]
    ];

    const b = [
        [argv[2], argv[3]],
        [argv[4], argv[5]]
    ];

    const c = [
        argv[6],
        argv[7]
    ];

    console.log("\n========== TRANSFER PROOF ==========");

    console.log(a);
    console.log(b);
    console.log(c);

    // relayer decrypt fee
    const relayerDecrypted =
        decryptMessage(
            encryptedNote3,
            relayerWallet.privateWallet.privateKey
        );

    console.log("\n========== RELAYER FEE NOTE ==========");

    console.log(relayerDecrypted);

    const rootHex =
        ethers.utils.hexZeroPad(
            ethers.BigNumber
                .from(proof.root.toString())
                .toHexString(),
            32
        );

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
                        [0,0,0,0],

                    nullifiers: [
                        ethers.utils.hexZeroPad(
                            ethers.BigNumber
                                .from(nullifier)
                                .toHexString(),
                            32
                        ),
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

    const receipt =
        await tx.wait();

    console.log("\n========== TRANSFER RECEIPT ==========");

    console.log(receipt);

    // recompute ALL states
    await rebuildWalletState();
    });

    it("Should withdraw privately", async function () {

        const sender =
            userWallets[0];

        // rebuild latest state
        await rebuildWalletState();

        // pick first unspent note
        const inputNote =
            walletStates["user1"].notes[0];

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

        console.log("\n========== MERKLE PROOF ==========");

        console.log(proof);

        // amounts
        const withdrawAmount =
            ethers.utils.parseEther("0.4");

        const fee =
            ethers.utils.parseEther("0.01");

        const inputAmount =
            ethers.BigNumber.from(
                inputNote.amount
            );

        const change =
            inputAmount
                .sub(withdrawAmount)
                .sub(fee);

        // randomness
        const rChange =
            ethers.BigNumber.from(
                ethers.utils.randomBytes(31)
            ).toString();

        const rRelayer =
            ethers.BigNumber.from(
                ethers.utils.randomBytes(31)
            ).toString();

        // commitments

        // change note back to sender
        const changeCommitment =
            await createCommitment(
                change.toString(),
                rChange,
                sender.zk.publicKey
            );

        // relayer fee note
        const relayerCommitment =
            await createCommitment(
                fee.toString(),
                rRelayer,
                relayerWallet.zk.publicKey
            );

        console.log("\n========== OUTPUT COMMITMENTS ==========");

        console.log(changeCommitment);

        console.log(relayerCommitment);

        // poseidon
        const poseidon =
            await circomlibjs.buildPoseidon();

        // nullifier
        const nullifier =
            poseidon.F.toString(
                poseidon([
                    2,
                    inputNote.commitment,
                    inputNote.randomness,
                    sender.zk.secretKey
                ])
            );

        console.log("\n========== NULLIFIER ==========");

        console.log(nullifier);

        // encrypted notes

        // change note
        const encryptedNote1 =
            encryptMessage(
                JSON.stringify({
                    amount:
                        change.toString(),
                    randomness:
                        rChange
                }),
                sender.privateWallet.publicKey
            );

        // relayer note
        const encryptedNote2 =
            encryptMessage(
                JSON.stringify({
                    amount:
                        fee.toString(),
                    randomness:
                        rRelayer
                }),
                relayerWallet.privateWallet.publicKey
            );

        // circom input
        const input = {

            pk:
                sender.zk.publicKey,

            sk:
                sender.zk.secretKey,

            receiver:
                ethers.BigNumber
                    .from(userSigner.address)
                    .toString(),
            
            changeReceiver:
                sender.zk.publicKey,

            relayer:
                relayerWallet.zk.publicKey,

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
                sender.zk.publicKey,
                relayerWallet.zk.publicKey
            ]
        };

        console.log("\n========== WITHDRAW INPUT ==========");

        console.log(input);

        // generate proof
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

        // calldata
        const calldata =
            await snarkjs.groth16.exportSolidityCallData(
                zkProof,
                publicSignals
            );

        const argv =
            calldata
                .replace(/["[\]\s]/g, "")
                .split(",");

        const a = [
            argv[0],
            argv[1]
        ];

        const b = [
            [argv[2], argv[3]],
            [argv[4], argv[5]]
        ];

        const c = [
            argv[6],
            argv[7]
        ];

        console.log("\n========== WITHDRAW PROOF ==========");

        console.log(a);
        console.log(b);
        console.log(c);

        // root hex
        const rootHex =
            ethers.utils.hexZeroPad(
                ethers.BigNumber
                    .from(state.tree.root.toString())
                    .toHexString(),
                32
            );

        // balances before
        const before =
            await ethers.provider.getBalance(
                userSigner.address
            );

        console.log("\n========== BALANCE BEFORE ==========");

        console.log(
            ethers.utils.formatEther(before)
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
                                [0,0,0,0],

                            nullifiers: [
                                ethers.utils.hexZeroPad(
                                    ethers.BigNumber
                                        .from(nullifier)
                                        .toHexString(),
                                    32
                                ),
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

        const receipt =
            await tx.wait();

        console.log("\n========== WITHDRAW RECEIPT ==========");

        console.log(receipt);

        // balances after
        const after =
            await ethers.provider.getBalance(
                userSigner.address
            );

        console.log("\n========== BALANCE AFTER ==========");

        console.log(
            ethers.utils.formatEther(after)
        );

        // rebuild latest state
        await rebuildWalletState();
    });


    it("Should create private Noid Smart Account", async function () {

        const sender =
            userWallets[0];

        // attach manager
        const noidAccountManager =
            await ethers.getContractAt(
                "NoidAccountManager",
                "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318"
            );

        // rebuild wallet state
        await rebuildWalletState();

        // use first available sender note
        const inputNote =
            walletStates["user1"].notes[0];

        console.log("\n========== CREATE ACCOUNT INPUT NOTE ==========");

        console.log(inputNote);

        // pool state
        const state =
            poolStates[inputNote.poolId];

        // merkle proof
        const merkleProof =
            state.tree.createProof(
                inputNote.leafIndex
            );

        console.log("\n========== MERKLE PROOF ==========");

        console.log(merkleProof);

        // -----------------------------------
        // ACCOUNT COMMITMENT
        // -----------------------------------

        const poseidon =
            await circomlibjs.buildPoseidon();

        // account randomness
        const rAccount =
            ethers.BigNumber.from(
                ethers.utils.randomBytes(31)
            ).toString();

        // cmx = Poseidon(4, zkPubKey, r)
        const cmx =
            poseidon.F.toString(
                poseidon([
                    4,
                    sender.zk.publicKey,
                    rAccount
                ])
            );

        console.log("\n========== ACCOUNT COMMITMENT ==========");

        console.log(cmx);

        // -----------------------------------
        // VALUES
        // -----------------------------------

        const fee =
            ethers.utils.parseEther("0.01");

        const inputAmount =
            ethers.BigNumber.from(
                inputNote.amount
            );

        const change =
            inputAmount.sub(fee);

        // -----------------------------------
        // RANDOMNESS
        // -----------------------------------

        const rChange =
            ethers.BigNumber.from(
                ethers.utils.randomBytes(31)
            ).toString();

        const rRelayer =
            ethers.BigNumber.from(
                ethers.utils.randomBytes(31)
            ).toString();

        // -----------------------------------
        // OUTPUT COMMITMENTS
        // -----------------------------------

        const changeCommitment =
            await createCommitment(
                change.toString(),
                rChange,
                sender.zk.publicKey
            );

        const relayerCommitment =
            await createCommitment(
                fee.toString(),
                rRelayer,
                relayerWallet.zk.publicKey
            );

        console.log("\n========== OUTPUT COMMITMENTS ==========");

        console.log(changeCommitment);

        console.log(relayerCommitment);

        // -----------------------------------
        // NULLIFIER
        // -----------------------------------

        const nullifier =
            poseidon.F.toString(
                poseidon([
                    2,
                    inputNote.commitment,
                    inputNote.randomness,
                    sender.zk.secretKey
                ])
            );

        console.log("\n========== NULLIFIER ==========");

        console.log(nullifier);

        // -----------------------------------
        // ENCRYPTED NOTES
        // -----------------------------------

        const encryptedNote1 =
            encryptMessage(
                JSON.stringify({
                    amount:
                        change.toString(),
                    randomness:
                        rChange
                }),
                sender.privateWallet.publicKey
            );

        const encryptedNote2 =
            encryptMessage(
                JSON.stringify({
                    amount:
                        fee.toString(),
                    randomness:
                        rRelayer
                }),
                relayerWallet.privateWallet.publicKey
            );

        // encrypted account note
        const encryptedAccountNote =
            encryptMessage(
                JSON.stringify({
                    randomness:
                        rAccount,
                    zkPublicKey:
                        sender.zk.publicKey
                }),
                sender.privateWallet.publicKey
            );

        // -----------------------------------
        // CIRCOM INPUT
        // -----------------------------------

        const input = {

            sk:
                sender.zk.secretKey,

            pk:
                sender.zk.publicKey,

            relayer:
                relayerWallet.zk.publicKey,

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
                merkleProof.siblings.map(
                    x => x[0].toString()
                ),
                Array(20).fill(0),
                Array(20).fill(0),
                Array(20).fill(0)
            ],

            pathIndices: [
                merkleProof.pathIndices,
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

            out_enabled:
                [1,1],

            c_outs: [
                changeCommitment.decimal,
                relayerCommitment.decimal
            ],

            a_outs: [
                change.toString(),
                fee.toString()
            ],

            r_outs: [
                rChange,
                rRelayer
            ],

            receivers: [
                sender.zk.publicKey,
                relayerWallet.zk.publicKey
            ],

            cmx_noirAccount:
                cmx,

            r_noirAccount:
                rAccount
        };

        console.log("\n========== CREATE ACCOUNT INPUT ==========");

        console.log(input);

        // -----------------------------------
        // GENERATE PROOF
        // -----------------------------------

        const {
            proof: zkProof,
            publicSignals
        } =
            await snarkjs.groth16.fullProve(

                input,

                "build/create_noid_account_js/create_noid_account.wasm",

                "build/create_noid_account_final.zkey"
            );

        console.log("\n========== PUBLIC SIGNALS ==========");

        console.log(publicSignals);

        // -----------------------------------
        // FORMAT CALLDATA
        // -----------------------------------

        const calldata =
            await snarkjs.groth16.exportSolidityCallData(
                zkProof,
                publicSignals
            );

        const argv =
            calldata
                .replace(/["[\]\s]/g, "")
                .split(",");

        const a = [
            argv[0],
            argv[1]
        ];

        const b = [
            [argv[2], argv[3]],
            [argv[4], argv[5]]
        ];

        const c = [
            argv[6],
            argv[7]
        ];

        // -----------------------------------
        // ROOT HEX
        // -----------------------------------

        const rootHex =
            ethers.utils.hexZeroPad(
                ethers.BigNumber
                    .from(state.tree.root.toString())
                    .toHexString(),
                32
            );

        // -----------------------------------
        // EXECUTE CREATE ACCOUNT
        // -----------------------------------

        const tx =
            await noidAccountManager
                .connect(relayerSigner)
                .createNoidAccount(
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
                                [0,0,0,0],

                            nullifiers: [
                                ethers.utils.hexZeroPad(
                                    ethers.BigNumber
                                        .from(nullifier)
                                        .toHexString(),
                                    32
                                ),
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
                        encryptedNote2
                    }],
                    ethers.utils.hexZeroPad(
                        ethers.BigNumber
                            .from(cmx)
                            .toHexString(),
                        32
                    ),
                    encryptedAccountNote
                );

        const receipt =
            await tx.wait();

        console.log("\n========== CREATE ACCOUNT RECEIPT ==========");

        console.log(receipt);

        // -----------------------------------
        // VERIFY ACCOUNT EXISTS
        // -----------------------------------

        const deployedAccount =
            await privatePool.NoidAccounts(
                ethers.utils.hexZeroPad(
                    ethers.BigNumber
                        .from(cmx)
                        .toHexString(),
                    32
                )
            );

        console.log("\n========== DEPLOYED ACCOUNT ==========");

        console.log(deployedAccount);

        expect(
            deployedAccount
        ).to.not.equal(
            ethers.constants.AddressZero
        );

        // rebuild state
        await rebuildWalletState();
    });


});