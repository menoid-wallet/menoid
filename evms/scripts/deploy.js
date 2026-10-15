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
 * Testnet without an official Uniswap (Monad testnet): run
 * scripts/testnet/deploy-uniswap.js first. Its deployments/<network>-uniswap.json
 * provides the router, the wrapped native token and the test tokens, which are
 * accepted right away. A live testnet deployment also writes the relayer's
 * testnet keys into the RELAYER WALLET comment block of .env.
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

const { deployLocalSystem, deployNoidPool, deployUniswapV3Adapter, VERIFIERS } = require("../helpers/deploy");
const { deriveWallet, registerWallet, keyNetworkForChainId, MAINNET_CHAIN_IDS } = require("../helpers/wallets");
const { UNISWAP_V3 } = require("../helpers/uniswap");
const { writeRelayerEnvBlock } = require("../helpers/relayer-env");

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

// A guarded launch: the tokens a mainnet pool accepts on day one, each with a
// small PER-DEPOSIT cap (helpers/mainnet-tokens.js). The owner raises caps or
// adds tokens later (scripts/list-tokens.js). Swaps can only buy listed tokens.
const { MAINNET_TOKENS } = require("../helpers/mainnet-tokens");

// mainnet pools are only deployed with the finished ceremony's verifiers
function mainnetCeremony() {
    const file = path.join(__dirname, "..", "ceremony", "v1m-mainnet", "transcript.json");
    if (!fs.existsSync(file)) throw new Error("no mainnet ceremony: run scripts/ceremony.js (init, contribute, beacon, finalize)");
    const t = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!t.final) throw new Error("the mainnet ceremony is not finalized: node scripts/ceremony.js finalize");
    for (const name of Object.values(VERIFIERS.mainnet)) {
        if (!fs.existsSync(path.join(__dirname, "..", "contracts", `${name}.sol`))) throw new Error(`contracts/${name}.sol is missing: re-run the ceremony's finalize`);
    }
    return {
        transcript: "ceremony/v1m-mainnet/transcript.json",
        contributions: t.contributions.map((c) => c.name),
        beacon: t.beacon && t.beacon.source,
        final: t.final
    };
}

// the Uniswap V3 that scripts/testnet/deploy-uniswap.js put on a testnet
function readTestnetVenue(networkName, chainId) {
    const file = path.join(__dirname, "..", "deployments", `${networkName}-uniswap.json`);
    if (MAINNET_CHAIN_IDS.has(chainId) || !fs.existsSync(file)) return null;
    const venue = JSON.parse(fs.readFileSync(file, "utf8"));
    if (venue.chainId !== chainId) throw new Error(`${path.basename(file)} is for chain ${venue.chainId}, not ${chainId}`);
    return venue;
}

async function main() {
    const { ethers, network } = hre;
    const [deployer] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const log = (line) => console.log("  " + line);

    console.log(`Deploying Menoid v1-mainnet to ${network.name} (chain ${chainId}) with ${deployer.address}\n`);

    // Mainnet chains get mainnet keys and the ceremony's verifiers; testnets
    // and local nodes get testnet keys and the development setup.
    const keyNetwork = keyNetworkForChainId(chainId);
    const ceremony = keyNetwork === "mainnet" ? mainnetCeremony() : null;
    if (ceremony) log(`trusted setup: ${ceremony.contributions.length} contributions + ${ceremony.beacon}`);

    let system;
    let swapVenue;
    const tokens = {};
    if (LOCAL_NETWORKS.has(network.name)) {
        system = await deployLocalSystem(hre, { log, uniswap: true });
        swapVenue = {
            factory: system.uniswap.factory.address,
            swapRouter02: system.uniswap.router.address,
            quoterV2: system.uniswap.quoter.address,
            adapter: system.uniswap.adapter.address,
            pools: system.uniswap.pools
        };
        if (system.usdc) tokens.USDC = system.usdc.address;
        if (system.tkn) tokens.TKN = system.tkn.address;
    } else {
        // only trust a known deployment if the chain id really matches it
        const known = Object.values(UNISWAP_V3).find((d) => d.chainId === chainId);
        const testnetVenue = known ? null : readTestnetVenue(network.name, chainId);
        const wrappedNative =
            process.env.WRAPPED_NATIVE || (known && known.wrappedNative) || (testnetVenue && testnetVenue.wrappedNative);
        if (!wrappedNative) throw new Error("unknown chain: set WRAPPED_NATIVE to its wrapped native token address");
        system = await deployNoidPool(hre, { wrappedNative, verifiers: VERIFIERS[keyNetwork], log });

        const router =
            process.env.UNISWAP_V3_ROUTER || (known && known.swapRouter02) || (testnetVenue && testnetVenue.swapRouter02);
        if (router) {
            const adapter = await deployUniswapV3Adapter(hre, { pool: system.pool, router, log });
            const venue = known || (testnetVenue && {
                factory: testnetVenue.factory,
                quoterV2: testnetVenue.quoterV2,
                positionManager: testnetVenue.positionManager,
                pools: testnetVenue.pools,
                deployedBy: "scripts/testnet/deploy-uniswap.js"
            });
            swapVenue = { ...(venue || {}), swapRouter02: router, adapter: adapter.address };
        } else {
            log("no Uniswap V3 router for this chain: swaps stay disabled until an adapter is added");
        }

        // a testnet's tokens are accepted right away; on mainnet the owner
        // (a multisig) configures each token deliberately
        if (testnetVenue) {
            const erc20 = ["function decimals() view returns (uint8)"];
            for (const [symbol, address] of Object.entries(testnetVenue.tokens)) {
                const decimals = await new ethers.Contract(address, erc20, ethers.provider).decimals();
                const cap = ethers.utils.parseUnits("1000000", decimals);
                await (await system.pool.configureToken(address, true, cap)).wait();
                tokens[symbol] = address;
                log(`accepted ${symbol.padEnd(6)} ${address}  (max deposit 1,000,000)`);
            }
        }
    }

    // a mainnet pool's day-one tokens, with their guarded-launch caps
    for (const t of (keyNetwork === "mainnet" && MAINNET_TOKENS[chainId]) || []) {
        const decimals = await new ethers.Contract(t.address, ["function decimals() view returns (uint8)"], ethers.provider).decimals();
        await (await system.pool.configureToken(t.address, true, ethers.utils.parseUnits(t.cap, decimals))).wait();
        tokens[t.symbol] = t.address;
        log(`accepted ${t.symbol.padEnd(6)} ${t.address}  (max ${t.cap} per deposit)`);
    }

    // the relayer's identity: fee notes are locked to its user commitment
    const relayer = await deriveWallet(deployer, { network: keyNetwork });
    await registerWallet(system.pool, relayer);
    log(`relayer registered (user commitment ${relayer.userCommitmentBytes32})`);

    // live testnets: the relayer's testnet keys go into .env (git-ignored)
    if (!LOCAL_NETWORKS.has(network.name) && keyNetwork === "testnet") {
        writeRelayerEnvBlock(path.join(__dirname, "..", ".env"), relayer, { networkLabel: `${network.name} (chain ${chainId})` });
        log("relayer keys written to the RELAYER WALLET block in .env");
    }

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
        trustedSetup: ceremony || "development (one contributor): testnet only",
        owner: deployer.address,
        relayer: {
            address: relayer.address,
            keyNetwork,
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
