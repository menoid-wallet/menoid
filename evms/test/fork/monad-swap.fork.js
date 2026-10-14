const hre = require("hardhat");
const { ethers } = hre;
const { expect } = require("chai");

const { deployNoidPool, deployUniswapV3Adapter } = require("../../helpers/deploy");
const W = require("../../helpers/wallets");
const { PoolMirror } = require("../../helpers/merkle");
const { scan, viewerFromWallet } = require("../../helpers/scanner");
const { buildDeposit, buildSwap, buildWithdraw } = require("../../helpers/transactions");
const { shutdownProver } = require("../../helpers/prover");
const { findBestRoute, withSlippage, UNISWAP_V3 } = require("../../helpers/uniswap");

/**
 * The full private swap against MONAD MAINNET state, on a local fork:
 * real WMON, real Circle USDC, the real Uniswap V3 SwapRouter02 / QuoterV2 and
 * the real MON/USDC pool liquidity. Nothing is sent to Monad itself.
 *
 *   MONAD_FORK_URL=https://rpc.monad.xyz npx hardhat test test/fork/monad-swap.fork.js
 *
 * Skipped unless MONAD_FORK_URL is set.
 */
const MONAD = UNISWAP_V3.monad;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";   // Circle USDC on Monad

(process.env.MONAD_FORK_URL ? describe : describe.skip)("Monad mainnet fork: private swap on the real Uniswap V3", function () {
    let pool, usdc, chainId, mirror, deployBlock, adapter;
    let relayerSigner, aliceSigner, relayer, alice;
    const log = (line) => console.log("        " + line);

    before(async function () {
        hre.upgrades.silenceWarnings();   // the linked-Poseidon-libraries notice is expected
        [, relayerSigner, aliceSigner] = await ethers.getSigners();
        chainId = (await ethers.provider.getNetwork()).chainId;
        log(`forked Monad at block ${await ethers.provider.getBlockNumber()}`);

        const core = await deployNoidPool(hre, { wrappedNative: MONAD.wrappedNative, log });
        ({ pool, deployBlock } = core);
        await (await pool.configureToken(MONAD.wrappedNative, true, ethers.utils.parseEther("1000000"))).wait();
        await (await pool.configureToken(USDC, true, ethers.utils.parseUnits("1000000", 6))).wait();
        adapter = await deployUniswapV3Adapter(hre, { pool, router: MONAD.swapRouter02, log });

        usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
        mirror = new PoolMirror(pool, { fromBlock: deployBlock });

        relayer = await W.deriveWallet(relayerSigner, { network: "mainnet" });
        alice = await W.deriveWallet(aliceSigner, { network: "mainnet" });
        await W.registerWallet(pool, relayer);
        await W.registerWallet(pool, alice);
    });

    after(async function () {
        await shutdownProver();
    });

    it("deposits MON, swaps it privately for USDC on the real MON/USDC pool, then withdraws the USDC", async function () {
        // 1. deposit 5,000 MON (wrapped to WMON inside the pool)
        const recipient = await W.resolveRecipient(pool, alice.address);
        const deposit = buildDeposit({ token: MONAD.wrappedNative, amount: ethers.utils.parseEther("5000"), recipient });
        await (
            await pool.connect(aliceSigner).depositNative(deposit.npk, deposit.encryptedNote, {
                value: ethers.utils.parseEther("5000")
            })
        ).wait();

        // 2. Menoid's backend picks the route on the live pools
        const amountIn = BigInt(ethers.utils.parseEther("4000").toString());
        const route = await findBestRoute({
            factory: MONAD.factory,
            quoter: MONAD.quoterV2,
            provider: ethers.provider,
            tokenIn: MONAD.wrappedNative,
            tokenOut: USDC,
            amountIn
        });
        log(`route: WMON -> USDC, fee tier ${route.fees.join(" > ")}, quote ${ethers.utils.formatUnits(route.amountOut.toString(), 6)} USDC`);

        // 3. private swap, relayed
        await mirror.sync();
        const notes = scan(mirror, viewerFromWallet(alice)).unspent;
        const { timestamp } = await ethers.provider.getBlock("latest");
        const built = await buildSwap({
            pool,
            chainId,
            mirror,
            sender: alice,
            notes,
            tokenIn: MONAD.wrappedNative,
            amountIn,
            tokenOut: USDC,
            minAmountOut: withSlippage(route.amountOut, 100),
            adapter: adapter.address,
            routeData: route.path,
            deadline: timestamp + 600,
            relayer: await W.resolveRecipient(pool, relayer.address),
            fee: ethers.utils.parseEther("1")
        });
        const receipt = await (await pool.connect(relayerSigner).swap([built.call])).wait();
        const swapped = receipt.events.find((e) => e.event === "Swapped");
        const amountOut = BigInt(swapped.args.amountOut.toString());
        log(`swapped 4,000 MON -> ${ethers.utils.formatUnits(amountOut.toString(), 6)} USDC privately (gas ${receipt.gasUsed.toString()})`);

        expect(amountOut >= built.call.ext.minAmountOut).to.equal(true);
        expect(BigInt((await usdc.balanceOf(pool.address)).toString())).to.equal(amountOut);

        await mirror.sync();
        const view = scan(mirror, viewerFromWallet(alice));
        expect(view.balances[USDC]).to.equal(amountOut);
        expect(view.balances[ethers.utils.getAddress(MONAD.wrappedNative)]).to.equal(
            BigInt(ethers.utils.parseEther("999").toString())   // 5,000 - 4,000 - 1 fee
        );

        // 4. the bought USDC note is an ordinary note: withdraw it to a fresh address
        const outsider = ethers.Wallet.createRandom().address;
        const usdcNote = view.unspent.find((n) => n.token === USDC);
        const fee = 10000n;   // 0.01 USDC
        const withdrawal = await buildWithdraw({
            pool,
            chainId,
            mirror,
            sender: alice,
            notes: [usdcNote],
            token: USDC,
            amount: usdcNote.amount - fee,
            recipient: outsider,
            relayer: await W.resolveRecipient(pool, relayer.address),
            fee
        });
        await (await pool.connect(relayerSigner).withdraw([withdrawal.call])).wait();
        expect(BigInt((await usdc.balanceOf(outsider)).toString())).to.equal(usdcNote.amount - fee);
        log(`withdrew ${ethers.utils.formatUnits((usdcNote.amount - fee).toString(), 6)} real USDC to a fresh address`);

        // 5. native MON out: the real WMON pays the pool's PROXY with a 2,300-gas
        //    transfer, which the proxy must forward to the implementation in time
        await mirror.sync();
        const monNote = scan(mirror, viewerFromWallet(alice)).unspent.find(
            (n) => n.token === ethers.utils.getAddress(MONAD.wrappedNative)
        );
        const monOut = ethers.Wallet.createRandom().address;
        const unwrap = await buildWithdraw({
            pool,
            chainId,
            mirror,
            sender: alice,
            notes: [monNote],
            token: MONAD.wrappedNative,
            amount: ethers.utils.parseEther("500"),
            recipient: monOut,
            unwrapNative: true,
            relayer: await W.resolveRecipient(pool, relayer.address),
            fee: ethers.utils.parseEther("1")
        });
        await (await pool.connect(relayerSigner).withdraw([unwrap.call])).wait();
        expect((await ethers.provider.getBalance(monOut)).toString()).to.equal(ethers.utils.parseEther("500").toString());
        log("withdrew 500 native MON (unwrapped from the real WMON) through the proxy");
    });

    it("runs behind a UUPS proxy on the fork too", async function () {
        const implementation = await hre.upgrades.erc1967.getImplementationAddress(pool.address);
        expect(implementation).to.not.equal(pool.address);
        expect(await pool.version()).to.equal("1.0.0");
    });
});
