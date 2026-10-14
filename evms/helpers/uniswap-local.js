/**
 * The real Uniswap V3 on a local chain.
 *
 * Deploys the official compiled contracts from npm — @uniswap/v3-core,
 * @uniswap/v3-periphery and @uniswap/swap-router-contracts — exactly the
 * bytecode that runs on Monad, Base, Polygon and Arbitrum (the pool init code
 * hash matches the periphery's), then seeds pools with full-range liquidity.
 *
 * Local networks only: tests and the localnet deployment.
 */
const factoryArtifact = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const positionManagerArtifact = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
const quoterArtifact = require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");
const routerArtifact = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

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
    const factory = await deployArtifact(hre, signer, factoryArtifact);
    // no token descriptor: only tokenURI uses it
    const positionManager = await deployArtifact(hre, signer, positionManagerArtifact, [factory.address, wrappedNative, zero]);
    // no Uniswap V2 factory: only V2 routes use it
    const router = await deployArtifact(hre, signer, routerArtifact, [zero, factory.address, positionManager.address, wrappedNative]);
    const quoter = await deployArtifact(hre, signer, quoterArtifact, [factory.address, wrappedNative]);
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
 */
async function addFullRangeLiquidity(hre, { uniswap, lp, tokenA, tokenB, fee, amountA, amountB }) {
    const aFirst = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();
    const [token0, token1] = aFirst ? [tokenA, tokenB] : [tokenB, tokenA];
    const [amount0, amount1] = aFirst ? [amountA, amountB] : [amountB, amountA];

    const pm = uniswap.positionManager.connect(lp);
    await (await pm.createAndInitializePoolIfNecessary(token0.address, token1.address, fee, encodePriceSqrt(amount1, amount0))).wait();
    await (await token0.connect(lp).approve(pm.address, amount0)).wait();
    await (await token1.connect(lp).approve(pm.address, amount1)).wait();

    const spacing = TICK_SPACING[fee];
    const maxTick = Math.floor(MAX_TICK / spacing) * spacing;
    const { timestamp } = await hre.ethers.provider.getBlock("latest");
    await (
        await pm.mint({
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
    ).wait();

    return uniswap.factory.getPool(token0.address, token1.address, fee);
}

module.exports = {
    deployLocalUniswapV3,
    addFullRangeLiquidity,
    encodePriceSqrt
};
