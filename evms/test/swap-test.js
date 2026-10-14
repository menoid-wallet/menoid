const hre = require("hardhat");
const { ethers } = hre;
const { expect } = require("chai");

const { deployLocalSystem, deployUniswapV3Adapter, deployContract } = require("../helpers/deploy");
const W = require("../helpers/wallets");
const { PoolMirror } = require("../helpers/merkle");
const { scan, viewerFromWallet, viewerFromViewingKey } = require("../helpers/scanner");
const { buildDeposit, buildTransfer, buildWithdraw, buildSwap } = require("../helpers/transactions");
const { verifyOffChain, shutdownProver } = require("../helpers/prover");
const { noteCommitment, toBytes32, randomFieldElement } = require("../helpers/commitments");
const { ACTION, encryptNote, tryDecryptNote } = require("../helpers/encryption");
const { findBestRoute, withSlippage, encodePath } = require("../helpers/uniswap");

/**
 * Private swaps on a local chain against the REAL Uniswap V3 contracts
 * (official npm bytecode, see helpers/uniswap-local.js).
 *
 * The route is chosen by Menoid's router helper, the trade is executed by the
 * pool through the whitelisted UniswapV3Adapter, and the bought note is
 * finished on-chain once its amount is known. The tests share state and run
 * in order.
 */
describe("Menoid v1-mainnet: private swaps (Uniswap V3)", function () {
    let pool, usdc, wnative, tkn, uniswap, chainId, mirror, deployBlock;
    let owner, relayerSigner, aliceSigner, bobSigner, traderSigner;
    let relayer, alice, bob;
    let maliciousAdapter, maliciousCall;
    const gas = {};

    const USDC = (amount) => BigInt(ethers.utils.parseUnits(amount, 6).toString());
    const ETH = (amount) => BigInt(ethers.utils.parseEther(amount).toString());
    const big = (value) => BigInt(value.toString());

    const resolve = (address) => W.resolveRecipient(pool, address);
    const balanceOf = (view, token) => (view.balances && view.balances[token]) || 0n;

    async function sync() {
        await mirror.sync();
        return mirror;
    }

    async function viewOf(wallet) {
        await sync();
        return scan(mirror, viewerFromWallet(wallet));
    }

    // the wallet's largest unspent note of a token
    async function largestNote(wallet, token) {
        const notes = (await viewOf(wallet)).unspent.filter((n) => n.token === token);
        return notes.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))[0];
    }

    async function now() {
        return (await ethers.provider.getBlock("latest")).timestamp;
    }

    async function relay(method, calls) {
        const tx = await pool.connect(relayerSigner)[method](calls);
        return { tx, receipt: await tx.wait() };
    }

    // Menoid's backend: pick the route, quote it, set the minimum
    async function route(tokenIn, tokenOut, amountIn) {
        return findBestRoute({
            factory: uniswap.factory,
            quoter: uniswap.quoter,
            tokenIn,
            tokenOut,
            amountIn,
            connectors: [usdc.address, wnative.address]
        });
    }

    async function privateSwap({
        sender,
        notes,
        tokenIn,
        amountIn,
        tokenOut,
        fee,
        slippageBps = 50,
        adapter = uniswap.adapter.address,
        deadlineIn = 600,
        quote
    }) {
        quote = quote || (await route(tokenIn, tokenOut, amountIn));
        await sync();
        const built = await buildSwap({
            pool,
            chainId,
            mirror,
            sender,
            notes,
            tokenIn,
            amountIn,
            tokenOut,
            minAmountOut: withSlippage(quote.amountOut, slippageBps),
            adapter,
            routeData: quote.path,
            deadline: (await now()) + deadlineIn,
            relayer: await resolve(relayer.address),
            fee
        });
        return { ...built, quote };
    }

    async function expectNotesUnspent(nullifiers) {
        for (const n of nullifiers) {
            expect(await pool.nullifierSpent(toBytes32(n))).to.equal(false);
        }
    }

    before(async function () {
        hre.upgrades.silenceWarnings();   // the linked-Poseidon-libraries notice is expected
        [owner, relayerSigner, aliceSigner, bobSigner, traderSigner] = await ethers.getSigners();

        const system = await deployLocalSystem(hre, { uniswap: true });
        ({ pool, usdc, tkn, uniswap, deployBlock } = system);
        wnative = system.wrappedNative;
        chainId = (await ethers.provider.getNetwork()).chainId;
        mirror = new PoolMirror(pool, { fromBlock: deployBlock });

        relayer = await W.deriveWallet(relayerSigner);
        alice = await W.deriveWallet(aliceSigner);
        bob = await W.deriveWallet(bobSigner);
        for (const wallet of [relayer, alice, bob]) await W.registerWallet(pool, wallet);

        // alice starts with a private 100 USDC note
        await (await usdc.mint(alice.address, USDC("1000"))).wait();
        const recipient = await resolve(alice.address);
        const { npk, encryptedNote } = buildDeposit({ token: usdc.address, amount: USDC("100"), recipient });
        await (await usdc.connect(aliceSigner).approve(pool.address, USDC("100"))).wait();
        await (await pool.connect(aliceSigner).deposit(usdc.address, USDC("100"), npk, encryptedNote)).wait();
    });

    after(async function () {
        console.log("\n      gas used");
        for (const [name, used] of Object.entries(gas)) {
            console.log(`        ${name.padEnd(30)} ${Number(used).toLocaleString("en-US")}`);
        }
        await shutdownProver();
    });

    // ════════════════════════════════════════════════════════════════════════
    describe("routing", function () {
        it("picks the route itself: the cheap pool for small trades, the deep one for big trades, a hop when needed", async function () {
            const small = await route(usdc.address, wnative.address, USDC("1"));
            expect(small.fees).to.deep.equal([500]);      // 0.05% fee wins while price impact is tiny

            const large = await route(usdc.address, wnative.address, USDC("80"));
            expect(large.fees).to.deep.equal([3000]);     // the deep 0.30% pool wins once size matters

            const hop = await route(wnative.address, tkn.address, ETH("200"));
            expect(hop.tokens).to.deep.equal([wnative.address, usdc.address, tkn.address]);   // no direct pool
        });
    });

    // ════════════════════════════════════════════════════════════════════════
    describe("swap", function () {
        it("swaps privately: the pool trades on Uniswap V3, then finishes the bought note", async function () {
            const notes = (await viewOf(alice)).unspent;
            const built = await privateSwap({
                sender: alice,
                notes,
                tokenIn: usdc.address,
                amountIn: USDC("80"),
                tokenOut: wnative.address,
                fee: USDC("0.1")
            });

            // the relayer's gate: a valid proof and a fee note it can open
            expect(await verifyOffChain("withdraw", built.publicSignals, built.rawProof)).to.equal(true);
            const fee = tryDecryptNote(relayer.viewing.ivk, built.call.ext.encryptedOutputs[1]);
            expect(fee.amount).to.equal(USDC("0.1"));

            const poolUsdc = big(await usdc.balanceOf(pool.address));
            const poolWnative = big(await wnative.balanceOf(pool.address));

            const { tx, receipt } = await relay("swap", [built.call]);
            gas["swap (1 hop)"] = receipt.gasUsed;
            expect(tx.from).to.equal(relayer.address);
            expect(tx.data.toLowerCase()).to.not.include(alice.address.slice(2).toLowerCase());

            const swapped = receipt.events.find((e) => e.event === "Swapped");
            const amountOut = big(swapped.args.amountOut);
            expect(swapped.args.tokenIn).to.equal(usdc.address);
            expect(swapped.args.tokenOut).to.equal(wnative.address);
            expect(big(swapped.args.amountIn)).to.equal(USDC("80"));
            expect(swapped.args.adapter).to.equal(uniswap.adapter.address);
            expect(amountOut).to.equal(built.quote.amountOut);   // nobody traded in between
            expect(amountOut >= built.call.ext.minAmountOut).to.equal(true);

            // the pool finished the commitment the user could not: Poseidon(D_CM, tokenOut, amountOut, npkOut)
            const bought = noteCommitment(wnative.address, amountOut, built.boughtNote.npk);
            expect(BigInt(swapped.args.commitment)).to.equal(bought);

            const created = receipt.events.filter((e) => e.event === "NoteCreated");
            expect(created).to.have.length(3);
            expect(created[0].args.leafIndex.toNumber() % 4).to.equal(0);
            expect(BigInt(created[2].args.commitment)).to.equal(bought);

            expect(big(await usdc.balanceOf(pool.address))).to.equal(poolUsdc - USDC("80"));
            expect(big(await wnative.balanceOf(pool.address))).to.equal(poolWnative + amountOut);

            const aliceView = await viewOf(alice);
            expect(balanceOf(aliceView, usdc.address)).to.equal(USDC("19.9"));
            expect(balanceOf(aliceView, wnative.address)).to.equal(amountOut);
            expect(aliceView.unspent.find((n) => n.fromSwap).commitment).to.equal(bought);
            expect(balanceOf(await viewOf(relayer), usdc.address)).to.equal(USDC("0.1"));
        });

        it("spends the bought note like any other note", async function () {
            const boughtNote = await largestNote(alice, wnative.address);
            expect(boughtNote.fromSwap).to.equal(true);

            await sync();
            const built = await buildTransfer({
                pool,
                chainId,
                mirror,
                sender: alice,
                notes: [boughtNote],
                token: wnative.address,
                recipient: await resolve(bob.address),
                amount: ETH("1000"),
                relayer: await resolve(relayer.address),
                fee: ETH("1")
            });
            await relay("transfer", [built.call]);

            expect(balanceOf(await viewOf(bob), wnative.address)).to.equal(ETH("1000"));
            expect(balanceOf(await viewOf(alice), wnative.address)).to.equal(boughtNote.amount - ETH("1001"));
        });

        it("binds the route, adapter, minimum, deadline and bought note to the proof", async function () {
            const secondAdapter = await deployUniswapV3Adapter(hre, { pool, router: uniswap.router.address });

            const note = await largestNote(alice, wnative.address);
            const built = await privateSwap({
                sender: alice,
                notes: [note],
                tokenIn: wnative.address,
                amountIn: ETH("500"),
                tokenOut: usdc.address,
                fee: ETH("1")
            });
            const call = built.call;
            const withExt = (change) => ({ ...call, ext: { ...call.ext, ...change } });
            const relayerR = await resolve(relayer.address);

            // a real alternative: the same pair through the fee tier the router did NOT pick
            const otherFee = built.quote.fees[0] === 500 ? 3000 : 500;
            expect(built.quote.tokens).to.deep.equal([wnative.address, usdc.address]);

            const tampered = {
                "a different route": withExt({ routeData: encodePath([wnative.address, usdc.address], [otherFee]) }),
                "a lower minimum": withExt({ minAmountOut: 1n }),
                "the relayer's own npk": withExt({ npkOut: toBytes32(randomFieldElement()) }),
                "a swapped bought-note ciphertext": withExt({
                    encryptedOutput: encryptNote(relayerR.viewingPublicKey, {
                        token: usdc.address,
                        amount: 0n,
                        randomness: randomFieldElement()
                    })
                }),
                "another whitelisted adapter": withExt({ adapter: secondAdapter.address }),
                "another output token": withExt({ tokenOut: tkn.address }),
                "a later deadline": withExt({ deadline: call.ext.deadline + 1000n }),
                "a larger input": { ...call, amountIn: call.amountIn + 1n }
            };
            for (const [what, bad] of Object.entries(tampered)) {
                await expect(relay("swap", [bad]), what).to.be.revertedWith("Invalid swap proof");
            }

            const { receipt } = await relay("swap", [call]);
            const amountOut = big(receipt.events.find((e) => e.event === "Swapped").args.amountOut);
            expect(amountOut >= call.ext.minAmountOut).to.equal(true);
        });

        it("reverts everything when the price moves past the minimum; a fresh quote then succeeds", async function () {
            const note = (await viewOf(alice)).unspent.find((n) => n.token === usdc.address && n.amount === USDC("19.9"));
            const stale = await privateSwap({
                sender: alice,
                notes: [note],
                tokenIn: usdc.address,
                amountIn: USDC("19"),
                tokenOut: wnative.address,
                fee: USDC("0.1"),
                slippageBps: 10
            });

            // someone moves the same pool before the relayer submits
            await (await usdc.mint(traderSigner.address, USDC("5000"))).wait();
            await (await usdc.connect(traderSigner).approve(uniswap.router.address, USDC("5000"))).wait();
            await (
                await uniswap.router.connect(traderSigner).exactInput({
                    path: stale.quote.path,
                    recipient: traderSigner.address,
                    amountIn: USDC("5000"),
                    amountOutMinimum: 0
                })
            ).wait();

            const poolUsdc = big(await usdc.balanceOf(pool.address));
            await expect(relay("swap", [stale.call])).to.be.revertedWith("Too little received");

            // nothing happened: the note is unspent and the pool untouched
            await expectNotesUnspent(stale.nullifiers);
            expect(big(await usdc.balanceOf(pool.address))).to.equal(poolUsdc);
            expect((await viewOf(alice)).unspent.map((n) => n.commitment)).to.include(note.commitment);

            // re-quote and retry: same note, so the same nullifier, now on a fresh quote
            const fresh = await privateSwap({
                sender: alice,
                notes: [note],
                tokenIn: usdc.address,
                amountIn: USDC("19"),
                tokenOut: wnative.address,
                fee: USDC("0.1"),
                slippageBps: 10
            });
            expect(fresh.nullifiers[0]).to.equal(stale.nullifiers[0]);
            await relay("swap", [fresh.call]);
            expect(await pool.nullifierSpent(toBytes32(note.nullifier))).to.equal(true);
        });

        it("expires: a relayer that waits past the deadline cannot execute it", async function () {
            const note = await largestNote(alice, wnative.address);
            const built = await privateSwap({
                sender: alice,
                notes: [note],
                tokenIn: wnative.address,
                amountIn: ETH("100"),
                tokenOut: usdc.address,
                fee: ETH("1"),
                deadlineIn: 60
            });

            await ethers.provider.send("evm_increaseTime", [120]);
            await ethers.provider.send("evm_mine", []);

            await expect(relay("swap", [built.call])).to.be.revertedWith("Swap expired");
            await expectNotesUnspent(built.nullifiers);
        });

        it("a misbehaving adapter can only make the swap fail", async function () {
            maliciousAdapter = (await deployContract(hre, "MockMaliciousAdapter")).contract;
            await (await pool.setSwapAdapter(maliciousAdapter.address, true)).wait();
            await (await usdc.mint(maliciousAdapter.address, USDC("1000"))).wait();   // what it pays out

            const note = await largestNote(alice, wnative.address);
            const built = await privateSwap({
                sender: alice,
                notes: [note],
                tokenIn: wnative.address,
                amountIn: ETH("100"),
                tokenOut: usdc.address,
                fee: ETH("1"),
                adapter: maliciousAdapter.address
            });
            maliciousCall = built.call;

            // claims a huge output, pays nothing: the pool measures its own balance
            await (await maliciousAdapter.setMode(0)).wait();
            await expect(relay("swap", [maliciousCall])).to.be.revertedWith("Insufficient output");

            // pays the minimum but hands half the input back: exact input or nothing
            await (await maliciousAdapter.setMode(1)).wait();
            await expect(relay("swap", [maliciousCall])).to.be.revertedWith("Input not fully spent");

            // tries to call back into the pool mid-swap
            await (await maliciousAdapter.setMode(2)).wait();
            await (
                await maliciousAdapter.setReentry(pool.address, pool.interface.encodeFunctionData("withdraw", [[]]))
            ).wait();
            await expect(relay("swap", [maliciousCall])).to.be.revertedWith("ReentrancyGuard: reentrant call");

            await expectNotesUnspent(built.nullifiers);
        });

        it("rejects unlisted adapters, unaccepted tokens and paused swaps; only the owner decides", async function () {
            await (await pool.setSwapAdapter(maliciousAdapter.address, false)).wait();
            await expect(relay("swap", [maliciousCall])).to.be.revertedWith("Adapter not allowed");

            await (await pool.setSwapsPaused(true)).wait();
            await expect(relay("swap", [maliciousCall])).to.be.revertedWith("Swaps paused");
            await (await pool.setSwapsPaused(false)).wait();

            await (await pool.configureToken(usdc.address, false, USDC("1000000"))).wait();
            await expect(relay("swap", [maliciousCall])).to.be.revertedWith("Token not accepted");
            await (await pool.configureToken(usdc.address, true, USDC("1000000"))).wait();

            await expect(pool.connect(aliceSigner).setSwapAdapter(aliceSigner.address, true)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
            await expect(pool.connect(aliceSigner).setSwapsPaused(true)).to.be.revertedWith(
                "Ownable: caller is not the owner"
            );
        });

        it("a withdraw proof can never be replayed as a swap", async function () {
            const note = await largestNote(alice, wnative.address);
            await sync();
            const outsider = ethers.Wallet.createRandom().address;
            const withdrawal = await buildWithdraw({
                pool,
                chainId,
                mirror,
                sender: alice,
                notes: [note],
                token: wnative.address,
                amount: ETH("10"),
                recipient: outsider,
                relayer: await resolve(relayer.address),
                fee: ETH("1")
            });
            const w = withdrawal.call;

            // same proof, presented as a swap that sends the 10 WNATIVE to Uniswap instead
            const replay = {
                proof: w.proof,
                treeId: w.treeId,
                root: w.root,
                nullifiers: w.nullifiers,
                outCommitments: w.outCommitments,
                relayer: w.relayer,
                tokenIn: w.token,
                amountIn: w.amount,
                ext: {
                    adapter: uniswap.adapter.address,
                    tokenOut: usdc.address,
                    minAmountOut: 1n,
                    deadline: BigInt((await now()) + 600),
                    npkOut: toBytes32(randomFieldElement()),
                    routeData: encodePath([wnative.address, usdc.address], [3000]),
                    encryptedOutput: "0x",
                    encryptedOutputs: w.ext.encryptedOutputs,
                    outgoingRecord: w.ext.outgoingRecord
                }
            };
            await expect(relay("swap", [replay])).to.be.revertedWith("Invalid swap proof");

            // and it still works as the withdrawal it was made for
            await relay("withdraw", [w]);
            expect(big(await wnative.balanceOf(outsider))).to.equal(ETH("10"));
        });

        it("routes a multi-hop swap through the connector: WNATIVE -> USDC -> TKN", async function () {
            const note = await largestNote(alice, wnative.address);
            const built = await privateSwap({
                sender: alice,
                notes: [note],
                tokenIn: wnative.address,
                amountIn: ETH("200"),
                tokenOut: tkn.address,
                fee: ETH("1")
            });
            expect(built.quote.tokens).to.deep.equal([wnative.address, usdc.address, tkn.address]);

            const { receipt } = await relay("swap", [built.call]);
            gas["swap (2 hops)"] = receipt.gasUsed;
            const amountOut = big(receipt.events.find((e) => e.event === "Swapped").args.amountOut);
            expect(balanceOf(await viewOf(alice), tkn.address)).to.equal(amountOut);
        });

        it("a full viewing key sees every swap: what went in, the minimum accepted, and what came out", async function () {
            await sync();
            const { viewingEpoch } = await resolve(alice.address);
            const audit = scan(mirror, viewerFromViewingKey(W.decodeViewingKey(W.encodeViewingKey(W.fullViewingKey(alice))), viewingEpoch));

            const swaps = audit.outgoing.filter((r) => r.action === ACTION.SWAP);
            expect(swaps.map((r) => [r.token, r.amount, r.tokenOut])).to.deep.include.members([
                [usdc.address, USDC("80"), wnative.address],
                [wnative.address, ETH("500"), usdc.address],
                [usdc.address, USDC("19"), wnative.address],
                [wnative.address, ETH("200"), tkn.address]
            ]);
            for (const record of swaps) expect(record.minAmountOut > 0n).to.equal(true);

            // every bought note, with the amount the pool published
            const bought = audit.notes.filter((n) => n.fromSwap);
            expect(bought).to.have.length(4);
            for (const note of bought) {
                expect(note.amount).to.equal(mirror.swapOutputs.get(note.commitment.toString()).amountOut);
            }
            expect(audit.balances).to.deep.equal((await viewOf(alice)).balances);
        });
    });
});
