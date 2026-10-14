/**
 * The real Uniswap V3 on a local chain.
 *
 * Deploys the official compiled contracts from npm — @uniswap/v3-core,
 * @uniswap/v3-periphery and @uniswap/swap-router-contracts — exactly the
 * bytecode that runs on Monad, Base, Polygon and Arbitrum (the pool init code
 * hash matches the periphery's), then seeds pools with full-range liquidity.
 *
 * Used by the tests, the localnet deployment, and testnets where Uniswap has
 * no live deployment (scripts/testnet/deploy-uniswap.js). Never on mainnet:
 * there helpers/uniswap.js names Uniswap's own deployment.
 */
const UNISWAP_ARTIFACTS = {
    factory: require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
    pool: require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json"),
    positionManager: require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
    quoterV2: require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json"),
    swapRouter02: require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json")
};

const TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const MAX_TICK = 887272;

async function deployArtifact(hre, signer, artifact, args = []) {
    const factory = new hre.ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
    const contract = await factory.deploy(...args);
    await contract.deployed();
    return contract;
}

async function deployLocalUniswapV3(hre, { wrappedNative, signer }) {
    const zero = hre.ethers.constants.AddressZero;
    const factory = await deployArtifact(hre, signer, UNISWAP_ARTIFACTS.factory);
    // no token descriptor: only tokenURI uses it
    const positionManager = await deployArtifact(hre, signer, UNISWAP_ARTIFACTS.positionManager, [factory.address, wrappedNative, zero]);
    // no Uniswap V2 factory: only V2 routes use it
    const router = await deployArtifact(hre, signer, UNISWAP_ARTIFACTS.swapRouter02, [zero, factory.address, positionManager.address, wrappedNative]);
    const quoter = await deployArtifact(hre, signer, UNISWAP_ARTIFACTS.quoterV2, [factory.address, wrappedNative]);
    return { factory, positionManager, router, quoter };
}

function sqrtBigInt(value) {
    if (value < 2n) return value;
    let x = value;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + value / x) / 2n;
    }
    return x;
}

// sqrt(amount1 / amount0) as a Q64.96 — the pool's starting price
function encodePriceSqrt(amount1, amount0) {
    return sqrtBigInt((BigInt(amount1) << 192n) / BigInt(amount0));
}

/**
 * Creates (if needed) the tokenA/tokenB pool at the price amountB / amountA
 * and adds full-range liquidity of amountA + amountB from `lp`.
 * onReceipt(label, tx, receipt) is called after each transaction.
 */
async function addFullRangeLiquidity(hre, { uniswap, lp, tokenA, tokenB, fee, amountA, amountB, onReceipt = () => {} }) {
    const aFirst = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();
    const [token0, token1] = aFirst ? [tokenA, tokenB] : [tokenB, tokenA];
    const [amount0, amount1] = aFirst ? [amountA, amountB] : [amountB, amountA];

    const send = async (label, pending) => {
        const tx = await pending;
        const receipt = await tx.wait();
        onReceipt(label, tx, receipt);
        return receipt;
    };

    const pm = uniswap.positionManager.connect(lp);
    await send("createPool", pm.createAndInitializePoolIfNecessary(token0.address, token1.address, fee, encodePriceSqrt(amount1, amount0)));
    await send("approve0", token0.connect(lp).approve(pm.address, amount0));
    await send("approve1", token1.connect(lp).approve(pm.address, amount1));

    const spacing = TICK_SPACING[fee];
    const maxTick = Math.floor(MAX_TICK / spacing) * spacing;
    const { timestamp } = await hre.ethers.provider.getBlock("latest");
    await send(
        "mint",
        pm.mint({
            token0: token0.address,
            token1: token1.address,
            fee,
            tickLower: -maxTick,
            tickUpper: maxTick,
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: lp.address,
            deadline: timestamp + 3600
        })
    );

    return uniswap.factory.getPool(token0.address, token1.address, fee);
}

module.exports = {
    UNISWAP_ARTIFACTS,
    TICK_SPACING,
    deployArtifact,
    deployLocalUniswapV3,
    addFullRangeLiquidity,
    encodePriceSqrt
};
