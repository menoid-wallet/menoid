const hre = require("hardhat");
const { ethers } = hre;
const { expect } = require("chai");

const { deployNoidPool, deployV3PoolAdapter } = require("../../helpers/deploy");
const W = require("../../helpers/wallets");
const { PoolMirror } = require("../../helpers/merkle");
const { scan, viewerFromWallet } = require("../../helpers/scanner");
const { buildDeposit, buildSwap, buildWithdraw } = require("../../helpers/transactions");
const { shutdownProver } = require("../../helpers/prover");
const { findBestRoute, withSlippage, UNISWAP_V3, V3_FORKS } = require("../../helpers/uniswap");

/**
 * Private MEMECOIN swaps against MONAD MAINNET state, on a local fork:
 * Capricorn — nad.fun's DEX, a Uniswap V3 fork whose pools call back
 * capricornCLSwapCallback — reached through Menoid's V3PoolAdapter, with the
 * real CHOG/WMON pool's liquidity. Nothing is sent to Monad itself.
 *
 *   MONAD_FORK_URL=https://rpc.monad.xyz npx hardhat test test/fork/monad-capricorn.fork.js
 *
 * Skipped unless MONAD_FORK_URL is set.
 */
const MONAD = UNISWAP_V3.monad;
const CAPRICORN = V3_FORKS.capricorn;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const CHOG = "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777";   // Chog (nad.fun)

(process.env.MONAD_FORK_URL ? describe : describe.skip)("Monad mainnet fork: private memecoin swaps on Capricorn", function () {
    let pool, chog, chainId, mirror, deployBlock, adapter;
    let relayerSigner, aliceSigner, relayer, alice;
    const log = (line) => console.log("        " + line);
    const big = (v) => BigInt(v.toString());

    const route = (tokenIn, tokenOut, amountIn) =>
        findBestRoute({ factory: CAPRICORN.factory, quoter: adapter, provider: ethers.provider, tokenIn, tokenOut, amountIn, connectors: [MONAD.wrappedNative, USDC] });

    async function privateSwap(tokenIn, tokenOut, amountIn, fee) {
        const quote = await route(tokenIn, tokenOut, amountIn);
        await mirror.sync();
        const notes = scan(mirror, viewerFromWallet(alice)).unspent.filter((n) => n.token === ethers.utils.getAddress(tokenIn));
        const { timestamp } = await ethers.provider.getBlock("latest");
        const built = await buildSwap({
            pool, chainId, mirror, sender: alice, notes, tokenIn, amountIn, tokenOut,
            minAmountOut: withSlippage(quote.amountOut, 100),
            adapter: adapter.address,
            routeData: quote.path,
            deadline: timestamp + 600,
            relayer: await W.resolveRecipient(pool, relayer.address),
            fee
        });
        const receipt = await (await pool.connect(relayerSigner).swap([built.call])).wait();
        const swapped = receipt.events.find((e) => e.event === "Swapped");
        return { quote, amountOut: big(swapped.args.amountOut), receipt, minAmountOut: big(built.call.ext.minAmountOut) };
    }

    before(async function () {
        hre.upgrades.silenceWarnings();   // the linked-Poseidon-libraries notice is expected
        [, relayerSigner, aliceSigner] = await ethers.getSigners();
        chainId = (await ethers.provider.getNetwork()).chainId;
        log(`forked Monad at block ${await ethers.provider.getBlockNumber()}`);

        const core = await deployNoidPool(hre, { wrappedNative: MONAD.wrappedNative, log });
        ({ pool, deployBlock } = core);
        await (await pool.configureToken(MONAD.wrappedNative, true, ethers.utils.parseEther("1000000"))).wait();
        await (await pool.configureToken(CHOG, true, ethers.utils.parseEther("1000000000"))).wait();
        adapter = await deployV3PoolAdapter(hre, { pool, factory: CAPRICORN.factory, label: "Capricorn adapter", log });

        chog = new ethers.Contract(CHOG, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
        mirror = new PoolMirror(pool, { fromBlock: deployBlock });
        relayer = await W.deriveWallet(relayerSigner, { network: "testnet" });
        alice = await W.deriveWallet(aliceSigner, { network: "testnet" });
        await W.registerWallet(pool, relayer);
        await W.registerWallet(pool, alice);

        const recipient = await W.resolveRecipient(pool, alice.address);
        const deposit = buildDeposit({ token: MONAD.wrappedNative, amount: ethers.utils.parseEther("500"), recipient });
        await (await pool.connect(aliceSigner).depositNative(deposit.npk, deposit.encryptedNote, { value: ethers.utils.parseEther("500") })).wait();
    });

    after(async function () {
        await shutdownProver();
    });

    it("swaps MON for CHOG privately through Capricorn's own pool, and leaves nothing in the adapter", async function () {
        const s = await privateSwap(MONAD.wrappedNative, CHOG, ethers.utils.parseEther("100"), ethers.utils.parseEther("1"));
        log(`100 MON -> ${ethers.utils.formatEther(s.amountOut.toString())} CHOG on Capricorn (fee tier ${s.quote.fees.join(" > ")}, gas ${s.receipt.gasUsed})`);
        expect(s.amountOut >= s.minAmountOut).to.equal(true);
        expect(s.amountOut).to.equal(BigInt(s.quote.amountOut));   // nothing traded in between
        expect(big(await chog.balanceOf(pool.address))).to.equal(s.amountOut);
        expect(big(await chog.balanceOf(adapter.address))).to.equal(0n);
        await mirror.sync();
        expect(scan(mirror, viewerFromWallet(alice)).balances[CHOG]).to.equal(s.amountOut);
    });

    it("swaps CHOG back to MON (the other direction through the same pool)", async function () {
        await mirror.sync();
        const held = scan(mirror, viewerFromWallet(alice)).balances[CHOG];
        const fee = held / 100n;
        const s = await privateSwap(CHOG, MONAD.wrappedNative, held / 2n, fee);
        log(`${ethers.utils.formatEther((held / 2n).toString())} CHOG -> ${ethers.utils.formatEther(s.amountOut.toString())} MON`);
        expect(s.amountOut >= s.minAmountOut).to.equal(true);
        expect(big(await chog.balanceOf(adapter.address))).to.equal(0n);
    });

    it("the bought CHOG is an ordinary note: withdraw it to a fresh address", async function () {
        await mirror.sync();
        const note = scan(mirror, viewerFromWallet(alice)).unspent.find((n) => n.token === CHOG);
        const fee = note.amount / 100n;
        const outsider = ethers.Wallet.createRandom().address;
        const withdrawal = await buildWithdraw({
            pool, chainId, mirror, sender: alice, notes: [note], token: CHOG,
            amount: note.amount - fee, recipient: outsider,
            relayer: await W.resolveRecipient(pool, relayer.address), fee
        });
        await (await pool.connect(relayerSigner).withdraw([withdrawal.call])).wait();
        expect(big(await chog.balanceOf(outsider))).to.equal(note.amount - fee);
        log(`withdrew ${ethers.utils.formatEther((note.amount - fee).toString())} real CHOG to a fresh address`);
    });
});
