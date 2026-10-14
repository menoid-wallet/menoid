const poseidonDeployments = require("poseidon-solidity");

const { deployLocalUniswapV3, addFullRangeLiquidity } = require("./uniswap-local");

/**
 * Deployment shared by scripts/deploy.js and the tests.
 *
 * Poseidon libraries: poseidon-solidity publishes canonical CREATE2
 * addresses. If the library already exists there (e.g. Base mainnet) it is
 * reused; if the deterministic deployment proxy exists (Monad, Polygon) it is
 * deployed through the proxy to the same address; otherwise (a local node) it
 * is deployed normally.
 */

async function deployPoseidonLibrary(hre, name) {
    const { ethers } = hre;
    const canonical = poseidonDeployments[name];

    if ((await ethers.provider.getCode(canonical.address)) !== "0x") {
        return { address: canonical.address, how: "existing canonical deployment" };
    }

    const [deployer] = await ethers.getSigners();
    if ((await ethers.provider.getCode(canonical.proxyAddress)) !== "0x") {
        const tx = await deployer.sendTransaction({ to: canonical.proxyAddress, data: canonical.data });
        const receipt = await tx.wait();
        return { address: canonical.address, how: "canonical via CREATE2 proxy", gasUsed: receipt.gasUsed };
    }

    const library = await (await ethers.getContractFactory(name)).deploy();
    const receipt = await library.deployTransaction.wait();
    return { address: library.address, how: "plain deployment", gasUsed: receipt.gasUsed };
}

async function deployContract(hre, name, args = [], options = {}) {
    const factory = await hre.ethers.getContractFactory(name, options);
    const contract = await factory.deploy(...args);
    const receipt = await contract.deployTransaction.wait();
    return { contract, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
}

// the pool and everything it links to
async function deployNoidPool(hre, { wrappedNative, log = () => {} }) {
    const poseidonT3 = await deployPoseidonLibrary(hre, "PoseidonT3");
    log(`PoseidonT3        ${poseidonT3.address}  (${poseidonT3.how})`);
    const poseidonT5 = await deployPoseidonLibrary(hre, "PoseidonT5");
    log(`PoseidonT5        ${poseidonT5.address}  (${poseidonT5.how})`);

    const transferVerifier = await deployContract(hre, "TransferVerifier");
    log(`TransferVerifier  ${transferVerifier.contract.address}`);
    const withdrawVerifier = await deployContract(hre, "WithdrawVerifier");
    log(`WithdrawVerifier  ${withdrawVerifier.contract.address}`);

    const pool = await deployContract(
        hre,
        "NoidPool",
        [transferVerifier.contract.address, withdrawVerifier.contract.address, wrappedNative],
        { libraries: { PoseidonT3: poseidonT3.address, PoseidonT5: poseidonT5.address } }
    );
    log(`NoidPool          ${pool.contract.address}  (block ${pool.blockNumber})`);

    return {
        pool: pool.contract,
        deployBlock: pool.blockNumber,
        poseidonT3,
        poseidonT5,
        transferVerifier: transferVerifier.contract,
        withdrawVerifier: withdrawVerifier.contract,
        gasUsed: {
            poseidonT3: poseidonT3.gasUsed,
            poseidonT5: poseidonT5.gasUsed,
            transferVerifier: transferVerifier.gasUsed,
            withdrawVerifier: withdrawVerifier.gasUsed,
            noidPool: pool.gasUsed
        }
    };
}

// the Uniswap V3 swap venue for a pool, whitelisted
async function deployUniswapV3Adapter(hre, { pool, router, log = () => {} }) {
    const adapter = (await deployContract(hre, "UniswapV3Adapter", [router, pool.address])).contract;
    await (await pool.setSwapAdapter(adapter.address, true)).wait();
    log(`UniswapV3Adapter  ${adapter.address}  (router ${router})`);
    return adapter;
}

/**
 * Local network only: mock wrapped native + a 6-decimal "USDC", both
 * accepted by the pool. Caps are generous; tests lower them where needed.
 *
 * uniswap: true also deploys the real Uniswap V3 contracts, seeds three pools
 * and whitelists a UniswapV3Adapter, so private swaps run end to end:
 *
 *      WNATIVE/USDC 0.30%   20,000,000 : 500,000    (1 WNATIVE = 0.025 USDC, like MON)
 *      WNATIVE/USDC 0.05%      400,000 :  10,000    (cheaper fee, thin)
 *      USDC/TKN     0.05%      500,000 : 500,000    (TKN has no WNATIVE pool: needs a hop)
 */
async function deployLocalSystem(hre, { log = () => {}, uniswap = false } = {}) {
    const { ethers } = hre;
    const [deployer] = await ethers.getSigners();

    const wrappedNative = (await deployContract(hre, "MockWrappedNative")).contract;
    log(`MockWrappedNative ${wrappedNative.address}`);
    const usdc = (await deployContract(hre, "MockERC20", ["USD Coin", "USDC", 6])).contract;
    log(`MockERC20 (USDC)  ${usdc.address}`);

    const core = await deployNoidPool(hre, { wrappedNative: wrappedNative.address, log });

    await (await core.pool.configureToken(wrappedNative.address, true, ethers.utils.parseEther("1000000"))).wait();
    await (await core.pool.configureToken(usdc.address, true, ethers.utils.parseUnits("1000000", 6))).wait();

    const system = { ...core, wrappedNative, usdc };
    if (!uniswap) return system;

    const tkn = (await deployContract(hre, "MockERC20", ["Test Token", "TKN", 18])).contract;
    log(`MockERC20 (TKN)   ${tkn.address}`);
    await (await core.pool.configureToken(tkn.address, true, ethers.utils.parseEther("1000000"))).wait();

    const uni = await deployLocalUniswapV3(hre, { wrappedNative: wrappedNative.address, signer: deployer });
    log(`UniswapV3Factory  ${uni.factory.address}`);
    log(`SwapRouter02      ${uni.router.address}`);
    log(`QuoterV2          ${uni.quoter.address}`);

    // the deployer provides the liquidity
    const eth = (n) => ethers.utils.parseEther(n);
    const usd = (n) => ethers.utils.parseUnits(n, 6);
    const lpBalance = "0x" + BigInt(eth("30000000").toString()).toString(16);   // RPC quantities: no leading zeros
    await hre.network.provider.send("hardhat_setBalance", [deployer.address, lpBalance]);
    await (await wrappedNative.deposit({ value: eth("20400000") })).wait();
    await (await usdc.mint(deployer.address, usd("1010000"))).wait();
    await (await tkn.mint(deployer.address, eth("500000"))).wait();

    const add = (tokenA, tokenB, fee, amountA, amountB) =>
        addFullRangeLiquidity(hre, { uniswap: uni, lp: deployer, tokenA, tokenB, fee, amountA, amountB });
    const pools = {
        wnativeUsdc3000: await add(wrappedNative, usdc, 3000, eth("20000000"), usd("500000")),
        wnativeUsdc500: await add(wrappedNative, usdc, 500, eth("400000"), usd("10000")),
        usdcTkn500: await add(usdc, tkn, 500, usd("500000"), eth("500000"))
    };
    log(`pools             ${Object.values(pools).join(", ")}`);

    const adapter = await deployUniswapV3Adapter(hre, { pool: core.pool, router: uni.router.address, log });

    return { ...system, tkn, uniswap: { ...uni, adapter, pools } };
}

module.exports = {
    deployPoseidonLibrary,
    deployContract,
    deployNoidPool,
    deployUniswapV3Adapter,
    deployLocalSystem
};
