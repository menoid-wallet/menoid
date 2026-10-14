const hre = require("hardhat");
const { ethers } = hre;
const { expect } = require("chai");

const { deployLocalSystem } = require("../helpers/deploy");
const W = require("../helpers/wallets");

// local chains are not mainnet: they use testnet keys
const KEY_NETWORK = "testnet";
const { PoolMirror } = require("../helpers/merkle");
const { scan, viewerFromWallet, viewerFromViewingKey } = require("../helpers/scanner");
const { buildDeposit, buildTransfer, buildWithdraw, prepareInputs, spendInput } = require("../helpers/transactions");
const { prove, verifyOffChain, shutdownProver } = require("../helpers/prover");
const { createNote, tokenField, toBytes32, randomFieldElement } = require("../helpers/commitments");
const { ACTION, encryptNote, tryDecryptNote } = require("../helpers/encryption");
const { BABYJUB_SUBGROUP_ORDER } = require("../helpers/constants");

/**
 * Menoid v1-mainnet pool, end to end on a local chain:
 * deposit -> transfer -> withdraw, with real Groth16 proofs, the attacks each
 * check exists for, and what every kind of viewing key can and cannot see.
 *
 * The tests share state and run in order (balances carry over).
 */
describe("Menoid v1-mainnet: pool", function () {
    let pool, usdc, wnative, chainId, mirror, deployBlock;
    let owner, relayerSigner, aliceSigner, bobSigner, carolSigner;
    let relayer, alice, bob, carol;
    let nativeOutsider;
    const gas = {};

    const USDC = (amount) => BigInt(ethers.utils.parseUnits(amount, 6).toString());
    const ETH = (amount) => BigInt(ethers.utils.parseEther(amount).toString());
    const big = (value) => BigInt(value.toString());

    const resolve = (address) => W.resolveRecipient(pool, address);

    async function sync() {
        await mirror.sync();
        return mirror;
    }

    async function viewOf(wallet, lastEpoch) {
        await sync();
        return scan(mirror, viewerFromWallet(wallet, lastEpoch));
    }

    const balanceOf = (view, token) => (view.balances && view.balances[token]) || 0n;
    const unspentOf = async (wallet, token) => (await viewOf(wallet)).unspent.filter((n) => n.token === token);

    async function expectRejected(promise, message) {
        let error;
        try {
            await promise;
        } catch (e) {
            error = e;
        }
        expect(error, "expected a rejection").to.not.equal(undefined);
        if (message) expect(error.message).to.include(message);
    }

    // the witness calculator prints every failed constraint; expected failures stay quiet
    async function muted(fn) {
        const { log, error } = console;
        console.log = console.error = () => {};
        try {
            return await fn();
        } finally {
            console.log = log;
            console.error = error;
        }
    }

    async function depositToken(signer, recipientAddress, token, amount) {
        const recipient = await resolve(recipientAddress);
        const { note, npk, encryptedNote } = buildDeposit({ token: token.address, amount, recipient });
        await (await token.connect(signer).approve(pool.address, amount)).wait();
        const receipt = await (await pool.connect(signer).deposit(token.address, amount, npk, encryptedNote)).wait();
        return { note, receipt };
    }

    // the relayer is the only on-chain sender of transfers and withdrawals
    async function relay(method, calls) {
        const tx = await pool.connect(relayerSigner)[method](calls);
        return { tx, receipt: await tx.wait() };
    }

    async function transfer({ sender, notes, token, to, amount, fee }) {
        await sync();
        return buildTransfer({
            pool,
            chainId,
            mirror,
            sender,
            notes,
            token,
            recipient: await resolve(to),
            amount,
            relayer: await resolve(relayer.address),
            fee
        });
    }

    async function withdrawal({ sender, notes, token, amount, recipient, unwrapNative = false, fee }) {
        await sync();
        return buildWithdraw({
            pool,
            chainId,
            mirror,
            sender,
            notes,
            token,
            amount,
            recipient,
            unwrapNative,
            relayer: await resolve(relayer.address),
            fee
        });
    }

    before(async function () {
        hre.upgrades.silenceWarnings();   // the linked-Poseidon-libraries notice is expected
        [owner, relayerSigner, aliceSigner, bobSigner, carolSigner] = await ethers.getSigners();

        const system = await deployLocalSystem(hre);
        ({ pool, usdc, deployBlock } = system);
        wnative = system.wrappedNative;
        chainId = (await ethers.provider.getNetwork()).chainId;
        mirror = new PoolMirror(pool, { fromBlock: deployBlock });

        relayer = await W.deriveWallet(relayerSigner, { network: KEY_NETWORK });
        alice = await W.deriveWallet(aliceSigner, { network: KEY_NETWORK });
        bob = await W.deriveWallet(bobSigner, { network: KEY_NETWORK });
        carol = await W.deriveWallet(carolSigner, { network: KEY_NETWORK });
        for (const wallet of [relayer, alice, bob, carol]) {
            await W.registerWallet(pool, wallet);
        }

        for (const signer of [owner, aliceSigner, bobSigner, carolSigner]) {
            await (await usdc.mint(signer.address, USDC("10000"))).wait();
        }
    });

    after(async function () {
        console.log("\n      gas used");
        for (const [name, used] of Object.entries(gas)) {
            console.log(`        ${name.padEnd(30)} ${Number(used).toLocaleString("en-US")}`);
        }
        await shutdownProver();
    });

    // ════════════════════════════════════════════════════════════════════════
    describe("deposit", function () {
        it("builds the note commitment on-chain; only the owner can find the note", async function () {
            const { note, receipt } = await depositToken(aliceSigner, alice.address, usdc, USDC("100"));
            gas["deposit (ERC-20)"] = receipt.gasUsed;

            const created = receipt.events.filter((e) => e.event === "NoteCreated");
            expect(created).to.have.length(1);
            // the contract's PoseidonT5 gives the same commitment as the wallet
            expect(BigInt(created[0].args.commitment)).to.equal(note.commitment);
            expect(created[0].args.leafIndex.toNumber() % 4).to.equal(0);

            const deposited = receipt.events.find((e) => e.event === "Deposited");
            expect(deposited.args.depositor).to.equal(alice.address);
            expect(deposited.args.token).to.equal(usdc.address);
            expect(big(deposited.args.amount)).to.equal(USDC("100"));

            expect(balanceOf(await viewOf(alice), usdc.address)).to.equal(USDC("100"));
            expect((await viewOf(bob)).notes).to.have.length(0);

            const [root, nextIndex] = await pool.treeInfo(0);
            expect(mirror.root(0)).to.equal(BigInt(root));
            expect(nextIndex.toNumber() % 4).to.equal(0);
        });

        it("wraps the native coin into a wrapped-native note", async function () {
            const before = big(await wnative.balanceOf(pool.address));
            const recipient = await resolve(bob.address);
            const { npk, encryptedNote } = buildDeposit({ token: wnative.address, amount: ETH("2"), recipient });

            const receipt = await (
                await pool.connect(bobSigner).depositNative(npk, encryptedNote, { value: ETH("2") })
            ).wait();
            gas["deposit (native, wrapped)"] = receipt.gasUsed;

            expect(big(await wnative.balanceOf(pool.address)) - before).to.equal(ETH("2"));
            expect(big(await ethers.provider.getBalance(pool.address))).to.equal(0n);
            expect(balanceOf(await viewOf(bob), wnative.address)).to.equal(ETH("2"));
        });

        it("lets anyone deposit to someone else's address", async function () {
            await depositToken(bobSigner, alice.address, usdc, USDC("50"));
            expect(balanceOf(await viewOf(alice), usdc.address)).to.equal(USDC("150"));
        });

        it("rejects unaccepted tokens, pauses, caps, zero amounts, duplicates and fee-on-transfer tokens", async function () {
            const carolR = await resolve(carol.address);
            const deposit = (signer, token, amount, built = buildDeposit({ token, amount, recipient: carolR })) =>
                pool.connect(signer).deposit(token, amount, built.npk, built.encryptedNote);

            const other = await (await ethers.getContractFactory("MockERC20")).deploy("Other", "OTH", 18);
            await (await other.mint(carol.address, ETH("1"))).wait();
            await (await other.connect(carolSigner).approve(pool.address, ETH("1"))).wait();
            await expect(deposit(carolSigner, other.address, ETH("1"))).to.be.revertedWith("Token not accepted");

            await (await usdc.connect(carolSigner).approve(pool.address, USDC("100"))).wait();
            await expect(deposit(carolSigner, usdc.address, 0n)).to.be.revertedWith("Zero amount");

            await (await pool.configureToken(usdc.address, true, USDC("10"))).wait();
            await expect(deposit(carolSigner, usdc.address, USDC("11"))).to.be.revertedWith("Deposit above cap");
            await (await pool.configureToken(usdc.address, true, USDC("1000000"))).wait();

            await (await pool.setDepositsPaused(true)).wait();
            await expect(deposit(carolSigner, usdc.address, USDC("1"))).to.be.revertedWith("Deposits paused");
            await (await pool.setDepositsPaused(false)).wait();

            await expect(pool.connect(carolSigner).setDepositsPaused(true)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
            await expect(pool.connect(carolSigner).configureToken(other.address, true, 1)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );

            // the same (token, amount, npk) twice is the same commitment
            const once = buildDeposit({ token: usdc.address, amount: USDC("1"), recipient: carolR });
            await (await deposit(carolSigner, usdc.address, USDC("1"), once)).wait();
            await expect(deposit(carolSigner, usdc.address, USDC("1"), once)).to.be.revertedWith(
                "Commitment already exists"
            );

            await expect(
                pool.connect(carolSigner).deposit(usdc.address, USDC("1"), ethers.constants.HashZero, "0x")
            ).to.be.revertedWith("Invalid note public key");

            // a note must be backed 1:1
            const feeToken = await (await ethers.getContractFactory("MockFeeOnTransferToken")).deploy();
            await (await pool.configureToken(feeToken.address, true, ETH("100"))).wait();
            await (await feeToken.mint(carol.address, ETH("10"))).wait();
            await (await feeToken.connect(carolSigner).approve(pool.address, ETH("10"))).wait();
            await expect(deposit(carolSigner, feeToken.address, ETH("10"))).to.be.revertedWith(
                "Token transfer amount mismatch"
            );

            expect(balanceOf(await viewOf(carol), usdc.address)).to.equal(USDC("1"));
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    describe("transfer", function () {
        it("moves value privately: the token and amounts never appear on-chain", async function () {
            const notes = await unspentOf(alice, usdc.address);
            expect(notes.map((n) => n.amount)).to.have.members([USDC("100"), USDC("50")]);

            const built = await transfer({
                sender: alice,
                notes,
                token: usdc.address,
                to: bob.address,
                amount: USDC("120"),
                fee: USDC("0.1")
            });

            // the relayer's gate before it pays gas: a valid proof, and a fee note it can open
            expect(await verifyOffChain("transfer", built.publicSignals, built.rawProof)).to.equal(true);
            const fee = tryDecryptNote(relayer.viewing.ivk, built.call.ext.encryptedOutputs[2]);
            expect(fee.token).to.equal(usdc.address);
            expect(fee.amount).to.equal(USDC("0.1"));

            // nothing public names the token or any amount
            const publicValues = built.publicSignals.map(String);
            for (const secret of [tokenField(usdc.address), USDC("120"), USDC("29.9"), USDC("0.1"), USDC("150")]) {
                expect(publicValues).to.not.include(secret.toString());
            }

            const poolBalance = big(await usdc.balanceOf(pool.address));
            const { tx, receipt } = await relay("transfer", [built.call]);
            gas["transfer (1 call)"] = receipt.gasUsed;

            expect(tx.from).to.equal(relayer.address);
            expect(tx.data.toLowerCase()).to.not.include(usdc.address.slice(2).toLowerCase());
            expect(receipt.events.filter((e) => e.event === "NullifierSpent")).to.have.length(4);
            const created = receipt.events.filter((e) => e.event === "NoteCreated");
            expect(created).to.have.length(3);
            expect(created[0].args.leafIndex.toNumber() % 4).to.equal(0);
            const record = receipt.events.find((e) => e.event === "OutgoingRecord");
            expect(record.args.firstNullifier).to.equal(built.call.nullifiers[0]);
            expect(big(await usdc.balanceOf(pool.address))).to.equal(poolBalance);

            expect(balanceOf(await viewOf(bob), usdc.address)).to.equal(USDC("120"));
            expect(balanceOf(await viewOf(alice), usdc.address)).to.equal(USDC("29.9"));
            expect(balanceOf(await viewOf(relayer), usdc.address)).to.equal(USDC("0.1"));
        });

        it("binds ciphertexts and records to the proof, accepts recent roots, and spends a note once", async function () {
            const [change] = await unspentOf(alice, usdc.address);
            const built = await transfer({
                sender: alice,
                notes: [change],
                token: usdc.address,
                to: carol.address,
                amount: USDC("10"),
                fee: USDC("0.1")
            });
            const call = built.call;

            // a relayer swaps the receiver's note for one that opens to a useless randomness
            const carolR = await resolve(carol.address);
            const garbage = encryptNote(carolR.viewingPublicKey, {
                token: usdc.address,
                amount: USDC("10"),
                randomness: randomFieldElement()
            });
            const swapped = { ...call, ext: { ...call.ext, encryptedOutputs: [garbage, ...call.ext.encryptedOutputs.slice(1)] } };
            await expect(relay("transfer", [swapped])).to.be.revertedWith("Invalid transfer proof");

            // ...or strips the sender's outgoing record
            const stripped = { ...call, ext: { ...call.ext, outgoingRecord: "0x" } };
            await expect(relay("transfer", [stripped])).to.be.revertedWith("Invalid transfer proof");

            // ...or claims a root the tree never had
            await expect(relay("transfer", [{ ...call, root: toBytes32(randomFieldElement()) }])).to.be.revertedWith(
                "Unknown root"
            );

            // the tree moves on before the relayer submits: the proof's root is still in history
            await depositToken(bobSigner, bob.address, usdc, USDC("5"));
            expect((await pool.treeInfo(0))[0]).to.not.equal(call.root);
            expect(await pool.isKnownRoot(0, call.root)).to.equal(true);
            await relay("transfer", [call]);

            await expect(relay("transfer", [call])).to.be.revertedWith("Nullifier already spent");

            expect(balanceOf(await viewOf(carol), usdc.address)).to.equal(USDC("11"));
            expect(balanceOf(await viewOf(alice), usdc.address)).to.equal(USDC("19.8"));
        });

        it("rejects a proof that lists the same note twice", async function () {
            const [note] = (await unspentOf(bob, usdc.address)).filter((n) => n.amount === USDC("120"));

            // the circuit sums every slot, so this proof is VALID and claims 240 from a 120 note;
            // only the contract's distinct-nullifier check stops it
            const built = await transfer({
                sender: bob,
                notes: [note, note],
                token: usdc.address,
                to: alice.address,
                amount: USDC("200"),
                fee: 0n
            });
            expect(built.call.nullifiers[0]).to.equal(built.call.nullifiers[1]);
            await expect(relay("transfer", [built.call])).to.be.revertedWith("Duplicate nullifier");
        });

        it("settles several spends, of different tokens, in one transaction", async function () {
            const bobNotes = (await viewOf(bob)).unspent;
            const usdcNote = bobNotes.find((n) => n.token === usdc.address && n.amount === USDC("120"));
            const ethNote = bobNotes.find((n) => n.token === wnative.address);

            const first = await transfer({
                sender: bob,
                notes: [usdcNote],
                token: usdc.address,
                to: carol.address,
                amount: USDC("20"),
                fee: USDC("0.1")
            });
            const second = await transfer({
                sender: bob,
                notes: [ethNote],
                token: wnative.address,
                to: alice.address,
                amount: ETH("0.5"),
                fee: ETH("0.001")
            });

            const { receipt } = await relay("transfer", [first.call, second.call]);
            gas["transfer (2 calls)"] = receipt.gasUsed;
            expect(receipt.events.filter((e) => e.event === "NoteCreated")).to.have.length(6);

            const bobView = await viewOf(bob);
            expect(balanceOf(bobView, usdc.address)).to.equal(USDC("104.9"));
            expect(balanceOf(bobView, wnative.address)).to.equal(ETH("1.499"));
            expect(balanceOf(await viewOf(alice), wnative.address)).to.equal(ETH("0.5"));
            expect(balanceOf(await viewOf(carol), usdc.address)).to.equal(USDC("31"));

            const relayerView = await viewOf(relayer);
            // fees from three transfers so far: alice->bob, alice->carol, bob->carol
            expect(balanceOf(relayerView, usdc.address)).to.equal(USDC("0.3"));
            expect(balanceOf(relayerView, wnative.address)).to.equal(ETH("0.001"));
        });

        it("the circuit refuses to create value, switch tokens, or spend without the spending key", async function () {
            await sync();
            const [note] = await unspentOf(carol, usdc.address);
            const relayerR = await resolve(relayer.address);

            const outputs = (token, amounts) => [
                createNote({ token, amount: amounts[0], owner: carol.userCommitment }),
                createNote({ token, amount: amounts[1], owner: carol.userCommitment }),
                createNote({ token, amount: amounts[2], owner: relayerR.userCommitment })
            ];

            async function attempt({ token = usdc.address, amounts, sk }) {
                const prepared = prepareInputs({ mirror, owner: carol, notes: [note], token: usdc.address });
                const input = {
                    ...spendInput({
                        owner: carol,
                        root: prepared.root,
                        slots: prepared.slots,
                        nullifiers: prepared.nullifiers,
                        outputs: outputs(token, amounts),
                        relayer: relayerR,
                        extDataHash: 1n
                    }),
                    token: tokenField(token)
                };
                if (sk !== undefined) input.sk = sk;
                return prove("transfer", input);
            }

            // control: a balanced spend proves
            await attempt({ amounts: [note.amount, 0n, 0n] });

            // one unit more out than in (fails the conservation constraint)
            await muted(() =>
                expectRejected(attempt({ amounts: [note.amount + 1n, 0n, 0n] }), "Assert Failed")
            );

            // a USDC note presented as the wrapped native token (its commitment is not in the tree)
            await muted(() =>
                expectRejected(attempt({ token: wnative.address, amounts: [note.amount, 0n, 0n] }), "Assert Failed")
            );

            // someone holding carol's viewing keys (nk, notes) but not her spending key
            const notCarolsSk = randomFieldElement() % BABYJUB_SUBGROUP_ORDER;
            await muted(() =>
                expectRejected(attempt({ amounts: [note.amount, 0n, 0n], sk: notCarolsSk }), "Assert Failed")
            );
        });

        it("never builds a private transfer to an unregistered address", async function () {
            const notes = await unspentOf(bob, usdc.address);
            await expectRejected(
                transfer({
                    sender: bob,
                    notes,
                    token: usdc.address,
                    to: ethers.Wallet.createRandom().address,
                    amount: USDC("1"),
                    fee: 0n
                }),
                "not registered"
            );
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    describe("withdraw", function () {
        it("releases tokens to any address; the relayer cannot redirect, resize or re-token them", async function () {
            const outsider = ethers.Wallet.createRandom().address;
            const notes = await unspentOf(bob, usdc.address);   // 99.9 + 5
            const built = await withdrawal({
                sender: bob,
                notes,
                token: usdc.address,
                amount: USDC("50"),
                recipient: outsider,
                fee: USDC("0.1")
            });
            const call = built.call;
            expect(await verifyOffChain("withdraw", built.publicSignals, built.rawProof)).to.equal(true);

            await expect(
                relay("withdraw", [{ ...call, ext: { ...call.ext, recipient: relayer.address } }])
            ).to.be.revertedWith("Invalid withdraw proof");
            await expect(relay("withdraw", [{ ...call, amount: USDC("60") }])).to.be.revertedWith(
                "Invalid withdraw proof"
            );
            await expect(relay("withdraw", [{ ...call, token: wnative.address }])).to.be.revertedWith(
                "Invalid withdraw proof"
            );
            await expect(
                relay("withdraw", [{ ...call, ext: { ...call.ext, unwrapNative: true } }])
            ).to.be.revertedWith("Only the wrapped native token can be unwrapped");

            const { receipt } = await relay("withdraw", [call]);
            gas["withdraw (ERC-20)"] = receipt.gasUsed;

            expect(big(await usdc.balanceOf(outsider))).to.equal(USDC("50"));
            const withdrawn = receipt.events.find((e) => e.event === "Withdrawn");
            expect(withdrawn.args.recipient).to.equal(outsider);
            expect(big(withdrawn.args.amount)).to.equal(USDC("50"));
            expect(receipt.events.filter((e) => e.event === "NoteCreated")).to.have.length(2);

            expect(balanceOf(await viewOf(bob), usdc.address)).to.equal(USDC("54.8"));
        });

        it("unwraps the native coin on the way out", async function () {
            nativeOutsider = ethers.Wallet.createRandom().address;
            const notes = await unspentOf(alice, wnative.address);
            const built = await withdrawal({
                sender: alice,
                notes,
                token: wnative.address,
                amount: ETH("0.3"),
                recipient: nativeOutsider,
                unwrapNative: true,
                fee: ETH("0.001")
            });

            const { receipt } = await relay("withdraw", [built.call]);
            gas["withdraw (native, unwrapped)"] = receipt.gasUsed;

            expect(big(await ethers.provider.getBalance(nativeOutsider))).to.equal(ETH("0.3"));
            expect(balanceOf(await viewOf(alice), wnative.address)).to.equal(ETH("0.199"));
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    describe("viewing keys", function () {
        it("a full viewing key shows the true balance and where the money went", async function () {
            const own = await viewOf(alice);

            // shared as a string, opened by someone else
            const shared = W.encodeViewingKey(W.fullViewingKey(alice));
            const { viewingEpoch } = await resolve(alice.address);
            const audit = scan(mirror, viewerFromViewingKey(W.decodeViewingKey(shared), viewingEpoch));

            expect(audit.balances).to.deep.equal(own.balances);
            expect(audit.balances[usdc.address]).to.equal(USDC("19.8"));
            expect(audit.balances[wnative.address]).to.equal(ETH("0.199"));

            const sent = audit.outgoing.map((r) => [r.action, r.counterpartyAddress, r.token, r.amount, r.fee]);
            expect(sent).to.deep.include.members([
                [ACTION.TRANSFER, bob.address, usdc.address, USDC("120"), USDC("0.1")],
                [ACTION.TRANSFER, carol.address, usdc.address, USDC("10"), USDC("0.1")],
                [ACTION.WITHDRAW, nativeOutsider, wnative.address, ETH("0.3"), ETH("0.001")]
            ]);

            // the record is also a receipt: rebuild bob's note from it and find it on-chain
            const toBob = audit.outgoing.find((r) => r.counterpartyAddress === bob.address);
            const paid = createNote({
                token: toBob.token,
                amount: toBob.amount,
                owner: toBob.counterpartyUserCommitment,
                randomness: toBob.counterpartyNoteRandomness
            });
            expect(mirror.notes.some((n) => n.commitment === paid.commitment)).to.equal(true);
        });

        it("an incoming viewing key sees what arrived, but not what was spent or sent", async function () {
            const shared = W.encodeViewingKey(W.incomingViewingKey(alice));
            const view = scan(mirror, viewerFromViewingKey(W.decodeViewingKey(shared), 0));

            expect(view.balances).to.equal(null);
            expect(view.outgoing).to.have.length(0);
            // 100 + 50 deposited, 29.9 and 19.8 change: all received, most of it long spent
            expect(view.received[usdc.address]).to.equal(USDC("199.7"));
            expect(view.received[usdc.address] > USDC("19.8")).to.equal(true);
        });

        it("viewing epochs: a key for one period shows only that period", async function () {
            alice = await W.updateViewingKey(pool, alice);
            expect((await resolve(alice.address)).viewingEpoch).to.equal(1);

            // bob pays alice after the switch: his wallet encrypts to her new key
            const notes = await unspentOf(bob, usdc.address);
            const built = await transfer({
                sender: bob,
                notes,
                token: usdc.address,
                to: alice.address,
                amount: USDC("5"),
                fee: USDC("0.1")
            });
            await relay("transfer", [built.call]);
            await sync();

            const epoch0 = scan(mirror, viewerFromViewingKey(W.epochViewingKey(alice, 0)));
            const epoch1 = scan(mirror, viewerFromViewingKey(W.epochViewingKey(alice, 1)));
            expect(epoch1.notes.map((n) => n.amount)).to.deep.equal([USDC("5")]);
            expect(epoch0.notes.map((n) => n.commitment)).to.not.include(epoch1.notes[0].commitment);

            const everything = scan(mirror, viewerFromViewingKey(W.fullViewingKey(alice), 1));
            expect(everything.balances[usdc.address]).to.equal(USDC("24.8"));

            // epochs only change who can read; one proof spends notes from both
            const both = await unspentOf(alice, usdc.address);
            expect(new Set(both.map((n) => n.epoch))).to.deep.equal(new Set([0, 1]));
            const spend = await transfer({
                sender: alice,
                notes: both,
                token: usdc.address,
                to: carol.address,
                amount: USDC("24"),
                fee: USDC("0.1")
            });
            await relay("transfer", [spend.call]);
            expect(balanceOf(await viewOf(alice), usdc.address)).to.equal(USDC("0.7"));
        });

        it("rotating keys: new notes go to the new identity, old notes stay spendable with the old keys", async function () {
            const oldCarol = carol;
            carol = await W.rotateKeys(pool, oldCarol);
            expect((await resolve(carol.address)).userCommitment).to.equal(carol.userCommitment);

            // a deposit to carol's address now lands on the new identity
            await depositToken(aliceSigner, carol.address, usdc, USDC("7"));
            expect(balanceOf(await viewOf(carol), usdc.address)).to.equal(USDC("7"));

            // the old wallet still owns, and sweeps, everything sent before the rotation
            const oldNotes = await unspentOf(oldCarol, usdc.address);
            const total = oldNotes.reduce((sum, n) => sum + n.amount, 0n);
            expect(total).to.equal(USDC("55"));   // 1 + 10 + 20 + 24

            const sweep = await transfer({
                sender: oldCarol,
                notes: oldNotes,
                token: usdc.address,
                to: carol.address,
                amount: total - USDC("0.1"),
                fee: USDC("0.1")
            });
            await relay("transfer", [sweep.call]);

            expect(balanceOf(await viewOf(oldCarol), usdc.address)).to.equal(0n);
            expect(balanceOf(await viewOf(carol), usdc.address)).to.equal(USDC("61.9"));
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    describe("tree", function () {
        it("keeps the last 100 roots: a root survives 99 more inserts, not 100", async function () {
            const [root] = await pool.treeInfo(0);
            const aliceR = await resolve(alice.address);

            // deposits need no proof, so they are a cheap way to move the tree
            await (await usdc.connect(owner).approve(pool.address, USDC("100"))).wait();
            const insert = async () => {
                const { npk, encryptedNote } = buildDeposit({ token: usdc.address, amount: USDC("0.01"), recipient: aliceR });
                await (await pool.connect(owner).deposit(usdc.address, USDC("0.01"), npk, encryptedNote)).wait();
            };

            for (let i = 0; i < 99; i++) await insert();
            expect(await pool.isKnownRoot(0, root)).to.equal(true);

            await insert();
            expect(await pool.isKnownRoot(0, root)).to.equal(false);

            // and the client still rebuilds exactly the contract's tree
            await sync();
            const [latest, nextIndex] = await pool.treeInfo(0);
            expect(mirror.root(0)).to.equal(BigInt(latest));
            expect(nextIndex.toNumber() % 4).to.equal(0);
        });

        it("rebuilds the same pool from capped eth_getLogs windows (as on Monad), and from a lagging node", async function () {
            await sync();
            const aliceR = await resolve(alice.address);
            const insert = async () => {
                const { npk, encryptedNote } = buildDeposit({ token: usdc.address, amount: USDC("0.01"), recipient: aliceR });
                await (await pool.connect(owner).deposit(usdc.address, USDC("0.01"), npk, encryptedNote)).wait();
            };

            // a public RPC answers at most a few blocks per eth_getLogs request
            const ranges = [];
            const capped = {
                getBlockNumber: () => pool.provider.getBlockNumber(),
                getLogs: (filter) => {
                    ranges.push([filter.fromBlock, filter.toBlock]);
                    return pool.provider.getLogs(filter);
                }
            };
            const paged = new PoolMirror({ ...pool, provider: capped }, { fromBlock: deployBlock, maxBlockRange: 7 });
            await paged.sync();

            // every request within the cap, together covering each block once
            expect(ranges[0][0]).to.equal(deployBlock);
            for (const [from, to] of ranges) expect(to - from + 1 <= 7).to.equal(true);
            for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).to.equal(ranges[i - 1][1] + 1);

            expect(paged.root(0)).to.equal(mirror.root(0));
            expect(paged.notes).to.deep.equal(mirror.notes);
            expect([...paged.nullifiers]).to.deep.equal([...mirror.nullifiers]);
            expect([...paged.outgoing]).to.deep.equal([...mirror.outgoing]);

            // the next sync reads only the blocks added since
            const readUpTo = ranges[ranges.length - 1][1];
            ranges.length = 0;
            await insert();
            await paged.sync();
            await sync();
            expect(ranges[0][0]).to.equal(readUpTo + 1);
            expect(paged.root(0)).to.equal(mirror.root(0));
            expect(paged.notes.length).to.equal(mirror.notes.length);

            // a node two blocks behind: its tree is older, but still one the
            // contract accepts, so proofs built on it stay valid
            await insert();
            await insert();
            const behind = {
                getBlockNumber: async () => (await pool.provider.getBlockNumber()) - 2,
                getLogs: (filter) => pool.provider.getLogs(filter)
            };
            const lagging = await new PoolMirror({ ...pool, provider: behind }, { fromBlock: deployBlock }).sync();
            await sync();
            expect(lagging.root(0)).to.not.equal(mirror.root(0));
            expect(await pool.isKnownRoot(0, toBytes32(lagging.root(0)))).to.equal(true);
        });
    });
});
