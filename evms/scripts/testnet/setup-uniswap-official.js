/**
 * Uniswap V3 for Menoid on a testnet where Uniswap runs its own deployment
 * (Base Sepolia). TESTNET ONLY.
 *
 * Nothing of Uniswap's is deployed: the official factory, position manager,
 * SwapRouter02 and QuoterV2 are recorded after checking them on-chain. The
 * WETH/USDC pools already there (Circle's testnet USDC, other people's
 * liquidity) carry ETH <-> USDC swaps. Menoid adds one test token anyone can
 * mint, and one small pool so it can be bought and sold:
 *
 *      mTKN/USDC   0.05%   20 USDC : 20 mTKN   (1 mTKN = 1 USDC)
 *
 * The USDC for it is bought from the existing WETH/USDC 0.30% pool. ETH -> mTKN
 * is then a two-hop route through USDC, across both pools.
 *
 *   npx hardhat run scripts/testnet/setup-uniswap-official.js --network baseSepoliaV1m
 *
 * Resumable: each finished step is saved to deployments/<network>-uniswap.json
 * and skipped when the script runs again. scripts/deploy.js reads that file.
 *
 * Monad testnet has no live Uniswap: it uses scripts/testnet/deploy-uniswap.js.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { UNISWAP_ARTIFACTS, addFullRangeLiquidity } = require("../../helpers/uniswap-local");
const { MAINNET_CHAIN_IDS } = require("../../helpers/wallets");

// developers.uniswap.org/docs/protocols/v3/deployments, checked on-chain below
const OFFICIAL = {
    84532: {
        name: "Base Sepolia",
        factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
        positionManager: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
        swapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
        quoterV2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
        wrappedNative: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
        // Circle's testnet USDC (faucet.circle.com)
        stable: { symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
        buyStableFee: 3000
    }
};

const FEE_TIERS = [100, 500, 3000, 10000];
const POOL_ABI = [
    "function liquidity() view returns (uint128)",
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
    "function token0() view returns (address)",
    "function token1() view returns (address)"
];
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];
const ROUTER_ABI = [
    "function WETH9() view returns (address)",
    "function factory() view returns (address)",
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)"
];

async function main() {
    const { ethers, network } = hre;
    const [deployer] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const log = (line) => console.log("  " + line);

    if (MAINNET_CHAIN_IDS.has(chainId)) throw new Error("testnet only: on mainnet, Menoid uses Uniswap's own deployment as is");
    const official = OFFICIAL[chainId];
    if (!official) throw new Error(`no official Uniswap V3 known for chain ${chainId} (Monad testnet: scripts/testnet/deploy-uniswap.js)`);

    // ── Uniswap's own contracts: they must be there and wired together ─────
    for (const key of ["factory", "positionManager", "swapRouter02", "quoterV2"]) {
        if ((await ethers.provider.getCode(official[key])) === "0x") throw new Error(`no code at Uniswap's ${key} ${official[key]}`);
    }
    const router = new ethers.Contract(official.swapRouter02, ROUTER_ABI, deployer);
    if (ethers.utils.getAddress(await router.WETH9()) !== ethers.utils.getAddress(official.wrappedNative.address)) {
        throw new Error("SwapRouter02 is not wired to this chain's WETH");
    }
    if (ethers.utils.getAddress(await router.factory()) !== ethers.utils.getAddress(official.factory)) {
        throw new Error("SwapRouter02 does not use Uniswap's factory");
    }

    const file = path.join(__dirname, "..", "..", "deployments", `${network.name}-uniswap.json`);
    const record = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : {
              network: network.name,
              chainId,
              purpose: `testnet only: Uniswap V3's own ${official.name} deployment, plus a Menoid test token and pool`,
              official: true,
              factory: official.factory,
              positionManager: official.positionManager,
              swapRouter02: official.swapRouter02,
              quoterV2: official.quoterV2,
              deployer: deployer.address,
              wrappedNative: official.wrappedNative.address,
              tokens: {
                  [official.wrappedNative.symbol]: official.wrappedNative.address,
                  [official.stable.symbol]: official.stable.address
              },
              pools: {},
              txs: {}
          };
    if (record.chainId !== chainId) throw new Error(`${path.basename(file)} is for chain ${record.chainId}`);
    const save = () => fs.writeFileSync(file, JSON.stringify(record, null, 4) + "\n");

    const keep = (label, tx, receipt) => {
        const price = receipt.effectiveGasPrice || tx.gasPrice || tx.maxFeePerGas;
        record.txs[label] = {
            hash: receipt.transactionHash,
            block: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            costETH: ethers.utils.formatEther(receipt.gasUsed.mul(price))
        };
        save();
    };
    const send = async (label, pending) => {
        const tx = await pending;
        const receipt = await tx.wait();
        keep(label, tx, receipt);
        return receipt;
    };

    const startBalance = await deployer.getBalance();
    console.log(`Uniswap V3 (official) for Menoid on ${network.name} (chain ${chainId}), deployer ${deployer.address}`);
    console.log(`balance ${ethers.utils.formatEther(startBalance)} ETH\n`);
    log(`factory          ${official.factory}  (Uniswap)`);
    log(`positionManager  ${official.positionManager}  (Uniswap)`);
    log(`swapRouter02     ${official.swapRouter02}  (Uniswap)`);
    log(`quoterV2         ${official.quoterV2}  (Uniswap)`);

    // ── the pools that already exist between WETH and USDC ─────────────────
    const factory = new ethers.Contract(official.factory, UNISWAP_ARTIFACTS.factory.abi, ethers.provider);
    for (const fee of FEE_TIERS) {
        const address = await factory.getPool(official.wrappedNative.address, official.stable.address, fee);
        if (address === ethers.constants.AddressZero) continue;
        const live = new ethers.Contract(address, POOL_ABI, ethers.provider);
        const key = `${official.wrappedNative.symbol}/${official.stable.symbol} ${(fee / 10000).toFixed(2)}%`;
        record.pools[key] = { address, fee, token0: await live.token0(), token1: await live.token1(), liquidity: (await live.liquidity()).toString(), seededBy: "others" };
        log(`${key.padEnd(16)} ${address}  (existing, liquidity ${record.pools[key].liquidity})`);
    }
    save();

    // ── the test token ──────────────────────────────────────────────────────
    const tokenFactory = await ethers.getContractFactory("MockERC20");
    if (!record.tokens.mTKN || (await ethers.provider.getCode(record.tokens.mTKN)) === "0x") {
        const mTKN = await tokenFactory.deploy("Menoid Test Token", "mTKN", 18);
        await mTKN.deployed();
        keep("mTKN", mTKN.deployTransaction, await mTKN.deployTransaction.wait());
        record.tokens.mTKN = mTKN.address;
        save();
        log(`mTKN             ${mTKN.address}`);
    } else {
        log(`mTKN             ${record.tokens.mTKN}  (deployed earlier)`);
    }

    // ── mTKN/USDC: USDC bought from the existing WETH/USDC pool ─────────────
    const usdc = new ethers.Contract(official.stable.address, ERC20_ABI, deployer);
    const mTKN = tokenFactory.attach(record.tokens.mTKN).connect(deployer);
    const SPEC = { key: `mTKN/${official.stable.symbol} 0.05%`, fee: 500, amountStable: ethers.utils.parseUnits("20", 6), amountToken: ethers.utils.parseEther("20") };

    const existing = record.pools[SPEC.key];
    const seeded = existing && existing.address && (await new ethers.Contract(existing.address, POOL_ABI, ethers.provider).liquidity()).gt(0);
    if (seeded) {
        log(`${SPEC.key.padEnd(16)} ${existing.address}  (created earlier)`);
    } else {
        // enough USDC: buy what is missing (+5% for the pool's price) with ETH
        const have = await usdc.balanceOf(deployer.address);
        if (have.lt(SPEC.amountStable)) {
            const quoter = new ethers.Contract(official.quoterV2, UNISWAP_ARTIFACTS.quoterV2.abi, ethers.provider);
            const probe = ethers.utils.parseEther("0.001");
            const { amountOut } = await quoter.callStatic.quoteExactInputSingle({
                tokenIn: official.wrappedNative.address,
                tokenOut: official.stable.address,
                amountIn: probe,
                fee: official.buyStableFee,
                sqrtPriceLimitX96: 0
            });
            const missing = SPEC.amountStable.sub(have);
            const ethIn = missing.mul(probe).mul(105).div(100).div(amountOut);
            log(`buying ${ethers.utils.formatUnits(missing, 6)} USDC with ${ethers.utils.formatEther(ethIn)} ETH (WETH/USDC ${(official.buyStableFee / 10000).toFixed(2)}%)`);
            await send(
                "buy USDC",
                router.exactInputSingle(
                    {
                        tokenIn: official.wrappedNative.address,
                        tokenOut: official.stable.address,
                        fee: official.buyStableFee,
                        recipient: deployer.address,
                        amountIn: ethIn,
                        amountOutMinimum: missing,
                        sqrtPriceLimitX96: 0
                    },
                    { value: ethIn }
                )
            );
        }
        if ((await mTKN.balanceOf(deployer.address)).lt(SPEC.amountToken)) await send(`${SPEC.key}: mint mTKN`, mTKN.mint(deployer.address, SPEC.amountToken));

        const address = await addFullRangeLiquidity(hre, {
            uniswap: { factory, positionManager: new ethers.Contract(official.positionManager, UNISWAP_ARTIFACTS.positionManager.abi, deployer) },
            lp: deployer,
            tokenA: usdc,
            tokenB: mTKN,
            fee: SPEC.fee,
            amountA: SPEC.amountStable,
            amountB: SPEC.amountToken,
            onReceipt: (step, tx, receipt) => keep(`${SPEC.key}: ${step}`, tx, receipt)
        });
        const live = new ethers.Contract(address, POOL_ABI, ethers.provider);
        const [token0, { sqrtPriceX96, tick }, liquidity] = await Promise.all([live.token0(), live.slot0(), live.liquidity()]);
        record.pools[SPEC.key] = {
            address,
            fee: SPEC.fee,
            token0,
            token1: await live.token1(),
            seeded: { [official.stable.symbol]: SPEC.amountStable.toString(), mTKN: SPEC.amountToken.toString() },
            seededBy: "menoid deployer",
            sqrtPriceX96: sqrtPriceX96.toString(),
            tick,
            liquidity: liquidity.toString()
        };
        save();
        log(`${SPEC.key.padEnd(16)} ${address}`);
    }

    const spent = startBalance.sub(await deployer.getBalance());
    console.log(`\nspent this run ${ethers.utils.formatEther(spent)} ETH (gas, and ETH swapped into the pool's USDC)`);
    console.log(`written ${path.relative(process.cwd(), file)}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
