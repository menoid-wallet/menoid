const poseidonDeployments = require("poseidon-solidity");

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

/**
 * Local network only: mock wrapped native + a 6-decimal "USDC", both
 * accepted by the pool. Caps are generous; tests lower them where needed.
 */
async function deployLocalSystem(hre, { log = () => {} } = {}) {
    const { ethers } = hre;

    const wrappedNative = (await deployContract(hre, "MockWrappedNative")).contract;
    log(`MockWrappedNative ${wrappedNative.address}`);
    const usdc = (await deployContract(hre, "MockERC20", ["USD Coin", "USDC", 6])).contract;
    log(`MockERC20 (USDC)  ${usdc.address}`);

    const core = await deployNoidPool(hre, { wrappedNative: wrappedNative.address, log });

    await (await core.pool.configureToken(wrappedNative.address, true, ethers.utils.parseEther("1000"))).wait();
    await (await core.pool.configureToken(usdc.address, true, ethers.utils.parseUnits("1000000", 6))).wait();

    return { ...core, wrappedNative, usdc };
}

module.exports = {
    deployPoseidonLibrary,
    deployContract,
    deployNoidPool,
    deployLocalSystem
};
