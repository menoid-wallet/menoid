const hre = require("hardhat");
const { ethers } = hre;
const { expect } = require("chai");

const { deployLocalSystem, deployV3PoolAdapter } = require("../helpers/deploy");
const W = require("../helpers/wallets");
const { PoolMirror } = require("../helpers/merkle");
const { scan, viewerFromWallet } = require("../helpers/scanner");
const { buildDeposit, buildSwap } = require("../helpers/transactions");
const { shutdownProver } = require("../helpers/prover");
const { findBestRoute, withSlippage, encodePath } = require("../helpers/uniswap");
const { encodePriceSqrt } = require("../helpers/uniswap-local");

// local chains are not mainnet: they use testnet keys
const KEY_NETWORK = "testnet";

/**
 * V3PoolAdapter against the REAL Uniswap V3 pool code (official npm
 * bytecode) — the code Capricorn forked on Monad. It must quote exactly what
 * Uniswap's QuoterV2 quotes, swap privately straight through the pools (one
 * hop and two), leave nothing behind, and refuse every way of misusing it.
 * The tests share state and run in order.
 */
describe("Menoid v1-mainnet: V3PoolAdapter (swaps straight through V3 pools)", function () {
    let pool, usdc, wnative, tkn, uniswap, chainId, mirror, deployBlock, adapter;
    let owner, relayerSigner, aliceSigner, attackerSigner;
    let relayer, alice;

    const USDC = (amount) => BigInt(ethers.utils.parseUnits(amount, 6).toString());
    const ETH = (amount) => BigInt(ethers.utils.parseEther(amount).toString());
    const big = (value) => BigInt(value.toString());
    const resolve = (address) => W.resolveRecipient(pool, address);

    async function viewOf(wallet) {
        await mirror.sync();
        return scan(mirror, viewerFromWallet(wallet));
    }

    async function noteOf(wallet, token) {
        const notes = (await viewOf(wallet)).unspent.filter((n) => n.token === token);
        return notes.sort((a, b) => (b.amount > a.amount ? 1 : -1))[0];
    }

    // the backend's routing, with this adapter as the venue's quoter
    const route = (tokenIn, tokenOut, amountIn) =>
        findBestRoute({ factory: uniswap.factory, quoter: adapter, tokenIn, tokenOut, amountIn, connectors: [usdc.address, wnative.address] });

    async function privateSwap({ tokenIn, amountIn, tokenOut, fee, quote, minAmountOut }) {
        quote = quote || (await route(tokenIn, tokenOut, amountIn));
        await mirror.sync();
        const notes = [await noteOf(alice, tokenIn)];
        const { timestamp } = await ethers.provider.getBlock("latest");
        const built = await buildSwap({
            pool,
            chainId,
            mirror,
            sender: alice,
            notes,
            tokenIn,
            amountIn,
            tokenOut,
            minAmountOut: minAmountOut ?? withSlippage(quote.amountOut, 50),
            adapter: adapter.address,
            routeData: quote.path,
            deadline: timestamp + 600,
            relayer: await resolve(relayer.address),
            fee
        });
        return { ...built, quote };
    }

    async function expectAdapterEmpty() {
        for (const token of [usdc, wnative, tkn]) {
            expect(big(await token.balanceOf(adapter.address))).to.equal(0n);
        }
    }

    before(async function () {
        hre.upgrades.silenceWarnings();   // the linked-Poseidon-libraries notice is expected
        [owner, relayerSigner, aliceSigner, attackerSigner] = await ethers.getSigners();

        const system = await deployLocalSystem(hre, { uniswap: true });
        ({ pool, usdc, tkn, uniswap, deployBlock } = system);
        wnative = system.wrappedNative;
        chainId = (await ethers.provider.getNetwork()).chainId;
        mirror = new PoolMirror(pool, { fromBlock: deployBlock });
        adapter = await deployV3PoolAdapter(hre, { pool, factory: uniswap.factory.address });

        relayer = await W.deriveWallet(relayerSigner, { network: KEY_NETWORK });
        alice = await W.deriveWallet(aliceSigner, { network: KEY_NETWORK });
        for (const wallet of [relayer, alice]) await W.registerWallet(pool, wallet);

        // alice starts with a private 100 USDC note
        await (await usdc.mint(alice.address, USDC("100"))).wait();
        const { npk, encryptedNote } = buildDeposit({ token: usdc.address, amount: USDC("100"), recipient: await resolve(alice.address) });
        await (await usdc.connect(aliceSigner).approve(pool.address, USDC("100"))).wait();
        await (await pool.connect(aliceSigner).deposit(usdc.address, USDC("100"), npk, encryptedNote)).wait();
    });

    after(async function () {
        await shutdownProver();
    });

    it("quotes exactly what Uniswap's QuoterV2 quotes, one hop and two", async function () {
        const paths = [
            [encodePath([usdc.address, wnative.address], [3000]), USDC("50")],
            [encodePath([wnative.address, usdc.address], [500]), ETH("1000")],
            [encodePath([wnative.address, usdc.address, tkn.address], [3000, 500]), ETH("2000")]
        ];
        for (const [path, amountIn] of paths) {
            const uni = await uniswap.quoter.callStatic.quoteExactInput(path, amountIn);
            const ours = await adapter.callStatic.quoteExactInput(path, amountIn);
            expect(big(ours.amountOut)).to.equal(big(uni.amountOut));
            expect(big(ours.amountOut) > 0n).to.equal(true);
        }
    });

    it("lets the backend route through it like through Uniswap: same best path, same output", async function () {
        const amountIn = USDC("40");
        const viaAdapter = await route(usdc.address, wnative.address, amountIn);
        const viaUniswap = await findBestRoute({ factory: uniswap.factory, quoter: uniswap.quoter, tokenIn: usdc.address, tokenOut: wnative.address, amountIn, connectors: [] });
        expect(viaAdapter.path).to.equal(viaUniswap.path);
        expect(viaAdapter.amountOut).to.equal(viaUniswap.amountOut);
    });

    it("swaps privately straight through the pool: USDC -> WNATIVE, nothing left behind", async function () {
        const amountIn = USDC("40");
        const built = await privateSwap({ tokenIn: usdc.address, amountIn, tokenOut: wnative.address, fee: USDC("0.5") });
        const receipt = await (await pool.connect(relayerSigner).swap([built.call])).wait();
        const swapped = receipt.events.find((e) => e.event === "Swapped");
        const amountOut = big(swapped.args.amountOut);

        expect(swapped.args.adapter).to.equal(adapter.address);
        expect(amountOut).to.equal(big(built.quote.amountOut));   // nobody traded in between: exactly the quote
        expect((await viewOf(alice)).balances[wnative.address]).to.equal(amountOut);
        await expectAdapterEmpty();
        console.log(`        40 USDC -> ${ethers.utils.formatEther(amountOut.toString())} WNATIVE privately (gas ${receipt.gasUsed.toString()})`);
    });

    it("two hops: WNATIVE -> USDC -> TKN, the middle token never stays in the adapter", async function () {
        const note = await noteOf(alice, wnative.address);
        const amountIn = note.amount / 2n;
        const built = await privateSwap({ tokenIn: wnative.address, amountIn, tokenOut: tkn.address, fee: ETH("1") });
        expect(built.quote.fees.length).to.equal(2);
        const receipt = await (await pool.connect(relayerSigner).swap([built.call])).wait();
        const amountOut = big(receipt.events.find((e) => e.event === "Swapped").args.amountOut);

        expect(amountOut).to.equal(big(built.quote.amountOut));
        expect((await viewOf(alice)).balances[tkn.address]).to.equal(amountOut);
        await expectAdapterEmpty();
        console.log(`        two hops -> ${ethers.utils.formatEther(amountOut.toString())} TKN (gas ${receipt.gasUsed.toString()})`);
    });

    it("only the pool can swap, and only the pool being swapped in can collect", async function () {
        // stray tokens sitting in the adapter are still out of reach
        await (await usdc.mint(adapter.address, USDC("5"))).wait();
        const path = encodePath([usdc.address, wnative.address], [3000]);

        await expect(
            adapter.connect(attackerSigner).swap(usdc.address, wnative.address, USDC("5"), 1, attackerSigner.address, path)
        ).to.be.revertedWith("Only the pool");
        await expect(adapter.connect(attackerSigner).uniswapV3SwapCallback(USDC("5"), -1, "0x")).to.be.revertedWith("Not the active pool");
        await expect(adapter.connect(attackerSigner).uniswapV3SwapCallback(-1, USDC("5"), "0x")).to.be.revertedWith("Not the active pool");
        await expect(adapter.connect(attackerSigner).capricornCLSwapCallback(USDC("5"), -1, "0x")).to.be.revertedWith("Not the active pool");

        // a quote moves nothing either
        await (await adapter.connect(attackerSigner).quoteExactInput(path, USDC("5"))).wait();
        expect(big(await usdc.balanceOf(adapter.address))).to.equal(USDC("5"));
    });

    it("refuses partial fills: a hop that cannot take all its input reverts, and its quote says so", async function () {
        // a thin TKN/WNATIVE 1% pool: liquidity only in a narrow range around 1:1
        const [token0, token1] = tkn.address.toLowerCase() < wnative.address.toLowerCase() ? [tkn, wnative] : [wnative, tkn];
        const pm = uniswap.positionManager.connect(owner);
        await (await pm.createAndInitializePoolIfNecessary(token0.address, token1.address, 10000, encodePriceSqrt(1, 1))).wait();
        await (await tkn.mint(owner.address, ETH("1"))).wait();
        await (await wnative.connect(owner).deposit({ value: ETH("1") })).wait();
        await (await token0.connect(owner).approve(pm.address, ETH("1"))).wait();
        await (await token1.connect(owner).approve(pm.address, ETH("1"))).wait();
        const { timestamp } = await ethers.provider.getBlock("latest");
        await (
            await pm.mint({
                token0: token0.address,
                token1: token1.address,
                fee: 10000,
                tickLower: -200,
                tickUpper: 200,
                amount0Desired: ETH("0.01"),
                amount1Desired: ETH("0.01"),
                amount0Min: 0,
                amount1Min: 0,
                recipient: owner.address,
                deadline: timestamp + 600
            })
        ).wait();

        const thin = encodePath([tkn.address, wnative.address], [10000]);
        const tknNote = await noteOf(alice, tkn.address);
        const amountIn = tknNote.amount / 2n;   // far more than the range holds
        await expect(adapter.callStatic.quoteExactInput(thin, amountIn)).to.be.revertedWith("Not enough liquidity");

        const built = await privateSwap({
            tokenIn: tkn.address,
            amountIn,
            tokenOut: wnative.address,
            fee: ETH("0.1"),
            quote: { path: thin, amountOut: 1n },
            minAmountOut: 1n
        });
        await expect(pool.connect(relayerSigner).swap([built.call])).to.be.revertedWith("Partial fill");
        expect(big(await tkn.balanceOf(adapter.address))).to.equal(0n);
    });
});
