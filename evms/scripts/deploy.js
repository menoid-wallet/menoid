/**
 * Menoid v1-mainnet deployment.
 *
 *   npx hardhat node                                         (another shell)
 *   npx hardhat run scripts/deploy.js --network localhost
 *
 * Local network: also deploys mock tokens (wrapped native, USDC, TKN), the real
 * Uniswap V3 contracts with seeded pools, and a whitelisted UniswapV3Adapter —
 * a complete environment for private swaps (and for the website to talk to).
 *
 * Live network: the chain's Uniswap V3 deployment and wrapped native token are
 * taken from helpers/uniswap.js when the chain id matches one of them (Monad,
 * Base, Polygon, Arbitrum); otherwise set WRAPPED_NATIVE (and optionally
 * UNISWAP_V3_ROUTER). Accepted tokens are configured afterwards with
 * configureToken.
 *
 * The pool is deployed behind a UUPS proxy (ERC-1967): `noidPool` in the record
 * is the proxy, the permanent address. Upgrade later with scripts/upgrade.js.
 *
 * signers[0] deploys, owns the pool (and with it the right to upgrade: move
 * ownership to a multisig on a live network), and is registered as the relayer
 * identity.
 *
 * Writes deployments/<network>.json.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { deployLocalSystem, deployNoidPool, deployUniswapV3Adapter } = require("../helpers/deploy");
const { deriveWallet, registerWallet } = require("../helpers/wallets");
const { UNISWAP_V3 } = require("../helpers/uniswap");

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

async function main() {
    const { ethers, network } = hre;
    const [deployer] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const log = (line) => console.log("  " + line);

    console.log(`Deploying Menoid v1-mainnet to ${network.name} (chain ${chainId}) with ${deployer.address}\n`);

    let system;
    let swapVenue;
    if (LOCAL_NETWORKS.has(network.name)) {
        system = await deployLocalSystem(hre, { log, uniswap: true });
        swapVenue = {
            factory: system.uniswap.factory.address,
            swapRouter02: system.uniswap.router.address,
            quoterV2: system.uniswap.quoter.address,
            adapter: system.uniswap.adapter.address,
            pools: system.uniswap.pools
        };
    } else {
        // only trust a known deployment if the chain id really matches it
        const known = Object.values(UNISWAP_V3).find((d) => d.chainId === chainId);
        const wrappedNative = process.env.WRAPPED_NATIVE || (known && known.wrappedNative);
        if (!wrappedNative) throw new Error("unknown chain: set WRAPPED_NATIVE to its wrapped native token address");
        system = await deployNoidPool(hre, { wrappedNative, log });

        const router = process.env.UNISWAP_V3_ROUTER || (known && known.swapRouter02);
        if (router) {
            const adapter = await deployUniswapV3Adapter(hre, { pool: system.pool, router, log });
            swapVenue = { ...(known || {}), swapRouter02: router, adapter: adapter.address };
        } else {
            log("no Uniswap V3 router for this chain: swaps stay disabled until an adapter is added");
        }
    }

    // the relayer's identity: fee notes are locked to its user commitment
    const relayer = await deriveWallet(deployer);
    await registerWallet(system.pool, relayer);
    log(`relayer registered (user commitment ${relayer.userCommitmentBytes32})`);

    const tokens = {};
    if (system.usdc) tokens.USDC = system.usdc.address;
    if (system.tkn) tokens.TKN = system.tkn.address;

    const record = {
        network: network.name,
        chainId,
        version: "v1-mainnet",
        noidPool: system.pool.address,                       // the proxy: the only address clients use
        noidPoolImplementation: system.implementation,
        noidPoolVersion: await system.pool.version(),
        proxyKind: "uups (ERC-1967)",
        deployBlock: system.deployBlock,
        transferVerifier: system.transferVerifier.address,
        withdrawVerifier: system.withdrawVerifier.address,
        poseidonT3: system.poseidonT3.address,
        poseidonT5: system.poseidonT5.address,
        wrappedNative: system.wrappedNative ? system.wrappedNative.address : system.pool.wrappedNative && (await system.pool.wrappedNative()),
        tokens,
        uniswapV3: swapVenue || null,
        owner: deployer.address,
        relayer: {
            address: relayer.address,
            userCommitment: relayer.userCommitmentBytes32,
            viewingPublicKey: relayer.viewing.ivkPub
        }
    };

    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${network.name}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 4) + "\n");

    console.log(`\nwritten ${path.relative(process.cwd(), file)}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
