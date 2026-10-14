const hre = require("hardhat");
const { ethers, upgrades } = hre;
const { expect } = require("chai");

const { deployLocalSystem, upgradeNoidPool, PROXY_OPTIONS } = require("../helpers/deploy");
const W = require("../helpers/wallets");
const { PoolMirror } = require("../helpers/merkle");
const { scan, viewerFromWallet, viewerFromViewingKey } = require("../helpers/scanner");
const { buildDeposit, buildTransfer, buildWithdraw, buildSwap } = require("../helpers/transactions");
const { shutdownProver } = require("../helpers/prover");
const { findBestRoute, withSlippage } = require("../helpers/uniswap");

/**
 * The pool behind its UUPS proxy: every call goes through one permanent
 * address, and an upgrade replaces the code while keeping every note,
 * nullifier, registration and token balance.
 */
describe("Menoid v1-mainnet: proxy & upgrades", function () {
    let system, pool, usdc, wnative, uniswap, chainId, mirror;
    let owner, relayerSigner, aliceSigner, bobSigner, strangerSigner;
    let relayer, alice, bob;

    const USDC = (amount) => BigInt(ethers.utils.parseUnits(amount, 6).toString());
    const ETH = (amount) => BigInt(ethers.utils.parseEther(amount).toString());
    const big = (value) => BigInt(value.toString());
    const resolve = (address) => W.resolveRecipient(pool, address);
    const balanceOf = (view, token) => (view.balances && view.balances[token]) || 0n;

    async function viewOf(wallet) {
        await mirror.sync();
        return scan(mirror, viewerFromWallet(wallet));
    }

    async function relay(method, calls) {
        return (await pool.connect(relayerSigner)[method](calls)).wait();
    }

    async function expectRejected(promise, message) {
        let error;
        try {
            await promise;
        } catch (e) {
            error = e;
        }
        expect(error, "expected a rejection").to.not.equal(undefined);
        if (message) expect(error.message).to.match(message);
    }

    // a snapshot of everything an upgrade must not touch
    async function poolState() {
        const [root, nextIndex] = await pool.treeInfo(0);
        return {
            owner: await pool.owner(),
            treeCount: (await pool.treeCount()).toString(),
            root,
            nextIndex: nextIndex.toString(),
            alice: await pool.registrationOf(alice.address),
            usdcConfig: await pool.tokenConfig(usdc.address),
            adapterAllowed: await pool.swapAdapters(uniswap.adapter.address),
            poolUsdc: (await usdc.balanceOf(pool.address)).toString(),
            poolWnative: (await wnative.balanceOf(pool.address)).toString(),
            transferVerifier: await pool.transferVerifier(),
            withdrawVerifier: await pool.withdrawVerifier(),
            wrappedNative: await pool.wrappedNative()
        };
    }

    before(async function () {
        upgrades.silenceWarnings();   // the linked-Poseidon-libraries notice is expected
        [owner, relayerSigner, aliceSigner, bobSigner, strangerSigner] = await ethers.getSigners();

        system = await deployLocalSystem(hre, { uniswap: true });
        ({ pool, usdc, uniswap } = system);
        wnative = system.wrappedNative;
        chainId = (await ethers.provider.getNetwork()).chainId;
        mirror = new PoolMirror(pool, { fromBlock: system.deployBlock });

        relayer = await W.deriveWallet(relayerSigner);
        alice = await W.deriveWallet(aliceSigner);
        bob = await W.deriveWallet(bobSigner);
        for (const wallet of [relayer, alice, bob]) await W.registerWallet(pool, wallet);
    });

    after(async function () {
        await shutdownProver();
    });

    it("sends every call through an ERC-1967 proxy to the NoidPool implementation", async function () {
        const implementation = await upgrades.erc1967.getImplementationAddress(pool.address);
        expect(implementation).to.equal(system.implementation);
        expect(implementation).to.not.equal(pool.address);
        expect(await ethers.provider.getCode(implementation)).to.not.equal("0x");

        expect(await pool.version()).to.equal("1.0.0");
        expect(await pool.owner()).to.equal(owner.address);

        // nobody can initialize the proxy twice, or the bare implementation at all
        await expect(pool.connect(strangerSigner).initialize(strangerSigner.address)).to.be.revertedWith(
            "Initializable: contract is already initialized"
        );
        const bare = pool.attach(implementation);
        await expect(bare.connect(strangerSigner).initialize(strangerSigner.address)).to.be.revertedWith(
            "Initializable: contract is already initialized"
        );
    });

    it("lets only the owner upgrade", async function () {
        const factory = await ethers.getContractFactory("NoidPoolV2Mock", { libraries: system.libraries });
        const v2 = await factory.deploy(...system.constructorArgs);
        await v2.deployed();

        await expect(pool.connect(strangerSigner).upgradeTo(v2.address)).to.be.revertedWith(
            "Ownable: caller is not the owner"
        );
    });

    it("keeps every note, nullifier, registration and balance through an upgrade; old notes stay spendable", async function () {
        // ── life on v1: deposit, a private transfer, and a private swap ──
        await (await usdc.mint(alice.address, USDC("1000"))).wait();
        const recipient = await resolve(alice.address);
        const usdcDeposit = buildDeposit({ token: usdc.address, amount: USDC("200"), recipient });
        await (await usdc.connect(aliceSigner).approve(pool.address, USDC("200"))).wait();
        await (await pool.connect(aliceSigner).deposit(usdc.address, USDC("200"), usdcDeposit.npk, usdcDeposit.encryptedNote)).wait();
        const nativeDeposit = buildDeposit({ token: wnative.address, amount: ETH("50"), recipient });
        await (await pool.connect(aliceSigner).depositNative(nativeDeposit.npk, nativeDeposit.encryptedNote, { value: ETH("50") })).wait();

        await mirror.sync();
        const relayerR = await resolve(relayer.address);
        const [usdcNote] = (await viewOf(alice)).unspent.filter((n) => n.token === usdc.address);
        const toBob = await buildTransfer({
            pool, chainId, mirror, sender: alice, notes: [usdcNote], token: usdc.address,
            recipient: await resolve(bob.address), amount: USDC("50"), relayer: relayerR, fee: USDC("0.1")
        });
        await relay("transfer", [toBob.call]);

        const before = await poolState();
        const spentBefore = toBob.nullifiers[0];
        const aliceBefore = await viewOf(alice);
        const bobBefore = await viewOf(bob);

        // ── upgrade, with the plugin checking the storage layout ──
        const { pool: upgraded, implementation } = await upgradeNoidPool(hre, {
            pool,
            contractName: "NoidPoolV2Mock",
            libraries: system.libraries,
            constructorArgs: system.constructorArgs
        });
        expect(upgraded.address).to.equal(pool.address);          // same address for everyone
        expect(implementation).to.not.equal(system.implementation);
        pool = upgraded;
        expect(await pool.version()).to.equal("2.0.0");

        // nothing moved
        expect(await poolState()).to.deep.equal(before);
        expect(await pool.nullifierSpent(ethers.utils.hexZeroPad(ethers.BigNumber.from(spentBefore).toHexString(), 32))).to.equal(true);
        expect((await viewOf(alice)).balances).to.deep.equal(aliceBefore.balances);
        expect((await viewOf(bob)).balances).to.deep.equal(bobBefore.balances);

        // the new version's addition works, and is owner-only like the rest
        await (await pool.setNewFeatureValue(42)).wait();
        expect(await pool.newFeatureValue()).to.equal(42);
        await expect(pool.connect(strangerSigner).setNewFeatureValue(1)).to.be.revertedWith("Ownable: caller is not the owner");

        // ── notes created on v1 are spent on v2, the same way ──
        await mirror.sync();
        const [bobNote] = (await viewOf(bob)).unspent;
        const bobPays = await buildTransfer({
            pool, chainId, mirror, sender: bob, notes: [bobNote], token: usdc.address,
            recipient: await resolve(alice.address), amount: USDC("20"), relayer: relayerR, fee: USDC("0.1")
        });
        await relay("transfer", [bobPays.call]);

        const outsider = ethers.Wallet.createRandom().address;
        const [nativeNote] = (await viewOf(alice)).unspent.filter((n) => n.token === wnative.address);
        const out = await buildWithdraw({
            pool, chainId, mirror, sender: alice, notes: [nativeNote], token: wnative.address,
            amount: ETH("10"), recipient: outsider, unwrapNative: true, relayer: relayerR, fee: ETH("0.01")
        });
        await relay("withdraw", [out.call]);
        expect(big(await ethers.provider.getBalance(outsider))).to.equal(ETH("10"));

        const aliceUsdc = (await viewOf(alice)).unspent.filter((n) => n.token === usdc.address);
        const route = await findBestRoute({
            factory: uniswap.factory, quoter: uniswap.quoter, tokenIn: usdc.address, tokenOut: wnative.address, amountIn: USDC("100")
        });
        const { timestamp } = await ethers.provider.getBlock("latest");
        const swap = await buildSwap({
            pool, chainId, mirror, sender: alice, notes: aliceUsdc, tokenIn: usdc.address, amountIn: USDC("100"),
            tokenOut: wnative.address, minAmountOut: withSlippage(route.amountOut, 50), adapter: uniswap.adapter.address,
            routeData: route.path, deadline: timestamp + 600, relayer: relayerR, fee: USDC("0.1")
        });
        const receipt = await relay("swap", [swap.call]);
        const amountOut = big(receipt.events.find((e) => e.event === "Swapped").args.amountOut);

        // ── a full viewing key reads across the upgrade without noticing it ──
        const { viewingEpoch } = await resolve(alice.address);
        await mirror.sync();
        const audit = scan(mirror, viewerFromViewingKey(W.fullViewingKey(alice), viewingEpoch));
        expect(audit.balances).to.deep.equal((await viewOf(alice)).balances);
        expect(balanceOf(audit, usdc.address)).to.equal(
            USDC("200") - USDC("50") - USDC("0.1") + USDC("20") - USDC("100") - USDC("0.1")
        );
        expect(balanceOf(audit, wnative.address)).to.equal(ETH("50") - ETH("10") - ETH("0.01") + amountOut);
    });

    it("refuses an upgrade whose storage layout would corrupt the pool", async function () {
        const bad = await ethers.getContractFactory("NoidPoolBadLayoutMock", { libraries: system.libraries });
        await expectRejected(
            upgrades.validateUpgrade(pool.address, bad, { ...PROXY_OPTIONS, constructorArgs: system.constructorArgs }),
            /layout|storage|Inserted|incompatible/i
        );
        await expectRejected(
            upgrades.upgradeProxy(pool.address, bad, { ...PROXY_OPTIONS, constructorArgs: system.constructorArgs }),
            /layout|storage|Inserted|incompatible/i
        );
        expect(await pool.version()).to.equal("2.0.0");   // still the good version
    });

    it("hands upgrade rights to a new owner (e.g. a multisig), or freezes the code for good", async function () {
        const factory = await ethers.getContractFactory("NoidPoolV2Mock", { libraries: system.libraries });
        const next = await factory.deploy(...system.constructorArgs);
        await next.deployed();

        await (await pool.transferOwnership(strangerSigner.address)).wait();
        await expect(pool.connect(owner).upgradeTo(next.address)).to.be.revertedWith("Ownable: caller is not the owner");
        await (await pool.connect(strangerSigner).upgradeTo(next.address)).wait();
        expect(await upgrades.erc1967.getImplementationAddress(pool.address)).to.equal(next.address);

        // renouncing ownership means nobody can ever upgrade again
        await (await pool.connect(strangerSigner).renounceOwnership()).wait();
        await expect(pool.connect(strangerSigner).upgradeTo(system.implementation)).to.be.revertedWith(
            "Ownable: caller is not the owner"
        );
    });
});
