/**
 * Uniswap V3 for Menoid on Monad testnet. TESTNET ONLY.
 *
 * Uniswap's own V3 addresses on the current Monad testnet have no code, so
 * this deploys the official compiled contracts from npm (@uniswap/v3-core,
 * v3-periphery, swap-router-contracts): the same bytecode as Uniswap's Monad
 * mainnet deployment, against the canonical testnet WMON. Plus two test
 * tokens anyone can mint, and three pools with full-range liquidity:
 *
 *      WMON/mUSDC  0.30%   8 MON :    80 mUSDC   (1 MON = 10 mUSDC)
 *      WMON/mUSDC  0.05%   4 MON :    40 mUSDC   (cheaper fee, half the depth)
 *      mUSDC/mTKN  0.05%   1,000 : 1,000          (mTKN has no WMON pool: a hop)
 *
 * With two fee tiers of different depth, the route really is a choice: small
 * trades go through the 0.05% pool, bigger ones through the deeper 0.30% pool.
 *
 *   npx hardhat run scripts/testnet/deploy-uniswap.js --network monadTestnet
 *
 * Resumable: each finished step is saved to deployments/<network>-uniswap.json
 * and skipped when the script runs again. scripts/deploy.js reads that file.
 *
 * Mainnet never uses this. There, helpers/uniswap.js names Uniswap's own
 * deployment, and scripts/deploy.js only takes it when the chain id matches.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { UNISWAP_ARTIFACTS, deployArtifact, addFullRangeLiquidity } = require("../../helpers/uniswap-local");
const { MAINNET_CHAIN_IDS } = require("../../helpers/wallets");

// the canonical wrapped MON on Monad testnet
const TESTNET_WRAPPED_NATIVE = { 10143: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541" };

const WRAPPED_NATIVE_ABI = [
    "function deposit() payable",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)"
];
const POOL_ABI = [
    "function liquidity() view returns (uint128)",
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
    "function token0() view returns (address)",
    "function token1() view returns (address)"
];

async function main() {
    const { ethers, network } = hre;
    const [deployer] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const log = (line) => console.log("  " + line);

    if (MAINNET_CHAIN_IDS.has(chainId)) throw new Error("testnet only: on mainnet, Menoid uses Uniswap's own deployment");
    const wrappedNative = process.env.WRAPPED_NATIVE || TESTNET_WRAPPED_NATIVE[chainId];
    if (!wrappedNative) throw new Error(`no wrapped native token known for chain ${chainId}: set WRAPPED_NATIVE`);
    if ((await ethers.provider.getCode(wrappedNative)) === "0x") throw new Error(`no contract at WRAPPED_NATIVE ${wrappedNative}`);

    const file = path.join(__dirname, "..", "..", "deployments", `${network.name}-uniswap.json`);
    const record = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : {
              network: network.name,
              chainId,
              purpose: "testnet only: Uniswap V3 has no live deployment on this chain",
              source: {
                  "@uniswap/v3-core": require("@uniswap/v3-core/package.json").version,
                  "@uniswap/v3-periphery": require("@uniswap/v3-periphery/package.json").version,
                  "@uniswap/swap-router-contracts": require("@uniswap/swap-router-contracts/package.json").version,
                  poolInitCodeHash: ethers.utils.keccak256(UNISWAP_ARTIFACTS.pool.bytecode)
              },
              deployer: deployer.address,
              wrappedNative,
              tokens: {},
              pools: {},
              txs: {}
          };
    if (record.chainId !== chainId) throw new Error(`${path.basename(file)} is for chain ${record.chainId}`);
    const save = () => fs.writeFileSync(file, JSON.stringify(record, null, 4) + "\n");

    // Monad charges gas limit x price, so the record keeps both
    const keep = (label, tx, receipt) => {
        const price = receipt.effectiveGasPrice || tx.gasPrice || tx.maxFeePerGas;
        record.txs[label] = {
            hash: receipt.transactionHash,
            block: receipt.blockNumber,
            gasLimit: tx.gasLimit.toString(),
            gasUsed: receipt.gasUsed.toString(),
            costMON: ethers.utils.formatEther(tx.gasLimit.mul(price))
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
    console.log(`Uniswap V3 for Menoid on ${network.name} (chain ${chainId}), deployer ${deployer.address}`);
    console.log(`balance ${ethers.utils.formatEther(startBalance)} MON\n`);

    // ── contracts ───────────────────────────────────────────────────────────
    // holder[key] is where the address is recorded
    async function deployOnce(holder, key, deploy) {
        if (holder[key] && (await ethers.provider.getCode(holder[key])) !== "0x") {
            log(`${key.padEnd(16)} ${holder[key]}  (deployed earlier)`);
            return holder[key];
        }
        const contract = await deploy();
        await contract.deployed();
        keep(key, contract.deployTransaction, await contract.deployTransaction.wait());
        holder[key] = contract.address;
        save();
        log(`${key.padEnd(16)} ${contract.address}`);
        return contract.address;
    }

    const zero = ethers.constants.AddressZero;
    await deployOnce(record, "factory", () => deployArtifact(hre, deployer, UNISWAP_ARTIFACTS.factory));
    // no token descriptor: only tokenURI uses it
    await deployOnce(record, "positionManager", () =>
        deployArtifact(hre, deployer, UNISWAP_ARTIFACTS.positionManager, [record.factory, wrappedNative, zero])
    );
    // no Uniswap V2 factory: only V2 routes use it
    await deployOnce(record, "swapRouter02", () =>
        deployArtifact(hre, deployer, UNISWAP_ARTIFACTS.swapRouter02, [zero, record.factory, record.positionManager, wrappedNative])
    );
    await deployOnce(record, "quoterV2", () =>
        deployArtifact(hre, deployer, UNISWAP_ARTIFACTS.quoterV2, [record.factory, wrappedNative])
    );

    const tokenFactory = await ethers.getContractFactory("MockERC20");
    record.tokens.WMON = wrappedNative;
    await deployOnce(record.tokens, "mUSDC", () => tokenFactory.deploy("Menoid Test USD", "mUSDC", 6));
    await deployOnce(record.tokens, "mTKN", () => tokenFactory.deploy("Menoid Test Token", "mTKN", 18));

    // ── pools ───────────────────────────────────────────────────────────────
    const tokens = {
        WMON: new ethers.Contract(wrappedNative, WRAPPED_NATIVE_ABI, deployer),
        mUSDC: tokenFactory.attach(record.tokens.mUSDC).connect(deployer),
        mTKN: tokenFactory.attach(record.tokens.mTKN).connect(deployer)
    };
    const uniswap = {
        factory: new ethers.Contract(record.factory, UNISWAP_ARTIFACTS.factory.abi, deployer),
        positionManager: new ethers.Contract(record.positionManager, UNISWAP_ARTIFACTS.positionManager.abi, deployer)
    };
    const eth = (n) => ethers.utils.parseEther(n);
    const usd = (n) => ethers.utils.parseUnits(n, 6);
    const POOLS = [
        { key: "WMON/mUSDC 0.30%", a: "WMON", b: "mUSDC", fee: 3000, amountA: eth("8"), amountB: usd("80") },
        { key: "WMON/mUSDC 0.05%", a: "WMON", b: "mUSDC", fee: 500, amountA: eth("4"), amountB: usd("40") },
        { key: "mUSDC/mTKN 0.05%", a: "mUSDC", b: "mTKN", fee: 500, amountA: usd("1000"), amountB: eth("1000") }
    ];

    // the deployer holds what a pool needs: wrap MON, mint the test tokens
    async function holdAtLeast(symbol, amount, label) {
        const balance = await tokens[symbol].balanceOf(deployer.address);
        if (balance.gte(amount)) return;
        const missing = amount.sub(balance);
        if (symbol === "WMON") await send(`${label}: wrap MON`, tokens.WMON.deposit({ value: missing }));
        else await send(`${label}: mint ${symbol}`, tokens[symbol].mint(deployer.address, missing));
    }

    for (const spec of POOLS) {
        const existing = record.pools[spec.key];
        if (existing && existing.address) {
            const live = new ethers.Contract(existing.address, POOL_ABI, ethers.provider);
            if ((await live.liquidity()).gt(0)) {
                log(`${spec.key.padEnd(16)} ${existing.address}  (created earlier)`);
                continue;
            }
        }
        await holdAtLeast(spec.a, spec.amountA, spec.key);
        await holdAtLeast(spec.b, spec.amountB, spec.key);
        const address = await addFullRangeLiquidity(hre, {
            uniswap,
            lp: deployer,
            tokenA: tokens[spec.a],
            tokenB: tokens[spec.b],
            fee: spec.fee,
            amountA: spec.amountA,
            amountB: spec.amountB,
            onReceipt: (step, tx, receipt) => keep(`${spec.key}: ${step}`, tx, receipt)
        });
        const live = new ethers.Contract(address, POOL_ABI, ethers.provider);
        const [token0, { sqrtPriceX96, tick }, liquidity] = await Promise.all([live.token0(), live.slot0(), live.liquidity()]);
        record.pools[spec.key] = {
            address,
            fee: spec.fee,
            token0,
            token1: await live.token1(),
            seeded: { [spec.a]: spec.amountA.toString(), [spec.b]: spec.amountB.toString() },
            sqrtPriceX96: sqrtPriceX96.toString(),
            tick,
            liquidity: liquidity.toString()
        };
        save();
        log(`${spec.key.padEnd(16)} ${address}`);
    }

    // ── sanity: the periphery finds the pools the factory made ──────────────
    const router = new ethers.Contract(record.swapRouter02, UNISWAP_ARTIFACTS.swapRouter02.abi, ethers.provider);
    if ((await router.factoryV2()) !== zero || (await router.WETH9()) !== ethers.utils.getAddress(wrappedNative)) {
        throw new Error("SwapRouter02 is not wired to this WMON");
    }
    for (const spec of POOLS) {
        const found = await uniswap.factory.getPool(tokens[spec.a].address, tokens[spec.b].address, spec.fee);
        if (found !== record.pools[spec.key].address) throw new Error(`${spec.key}: factory does not know the pool`);
    }

    const spent = startBalance.sub(await deployer.getBalance());
    console.log(`\nspent this run ${ethers.utils.formatEther(spent)} MON (gas, and MON wrapped into pool liquidity)`);
    console.log(`written ${path.relative(process.cwd(), file)}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
