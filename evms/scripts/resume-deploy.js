/**
 * Finishes a mainnet deployment that stopped part-way (an RPC that hung after
 * the pool was deployed): reads what is on-chain, writes the deployment
 * record, accepts the launch tokens the pool does not accept yet and registers
 * the relayer if it is not. Every step checks the chain first: safe to re-run.
 *
 *   POOL=0x… DEPLOY_BLOCK=… ADAPTER=0x… \
 *     npx hardhat run scripts/resume-deploy.js --network baseMainnet
 *
 * Writes deployments/<network>.json (in scripts/deploy.js's format).
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { MAINNET_TOKENS } = require("../helpers/mainnet-tokens");
const { deriveWallet, registerWallet, keyNetworkForChainId } = require("../helpers/wallets");
const { UNISWAP_V3 } = require("../helpers/uniswap");

const ERC20 = ["function decimals() view returns (uint8)"];

async function main() {
    const { ethers, network, upgrades } = hre;
    const [deployer] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const keyNetwork = keyNetworkForChainId(chainId);
    if (keyNetwork !== "mainnet") throw new Error("resume-deploy.js is for mainnet pools");
    const log = (line) => console.log("  " + line);

    const poolAddress = ethers.utils.getAddress(process.env.POOL || "");
    const pool = await ethers.getContractAt("NoidPool", poolAddress, deployer);
    if ((await pool.owner()).toLowerCase() !== deployer.address.toLowerCase()) throw new Error(`${deployer.address} does not own ${poolAddress}`);
    console.log(`Resuming the deployment of ${poolAddress} on ${network.name} (chain ${chainId})\n`);

    const venue = Object.values(UNISWAP_V3).find((d) => d.chainId === chainId);
    const adapter = process.env.ADAPTER && ethers.utils.getAddress(process.env.ADAPTER);
    if (adapter && !(await pool.swapAdapters(adapter))) throw new Error(`${adapter} is not a whitelisted adapter of the pool`);

    // the tokens it does not accept yet
    const tokens = {};
    for (const t of MAINNET_TOKENS[chainId] || []) {
        const config = await pool.tokenConfig(t.address);
        if (!config.depositsEnabled) {
            const decimals = await new ethers.Contract(t.address, ERC20, ethers.provider).decimals();
            await (await pool.configureToken(t.address, true, ethers.utils.parseUnits(t.cap, decimals))).wait();
            log(`accepted ${t.symbol.padEnd(8)} ${t.address}  (max ${t.cap} per deposit)`);
        }
        tokens[t.symbol] = t.address;
    }
    log(`${Object.keys(tokens).length} tokens accepted`);

    // the relayer's identity
    const relayer = await deriveWallet(deployer, { network: keyNetwork });
    const reg = await pool.registrationOf(deployer.address);
    if (reg.userCommitment === ethers.constants.HashZero) {
        await registerWallet(pool, relayer);
        log(`relayer registered (user commitment ${relayer.userCommitmentBytes32})`);
    } else if (reg.userCommitment !== relayer.userCommitmentBytes32) {
        throw new Error("the deployer is registered with different keys");
    } else {
        log("relayer already registered");
    }

    // the record, as scripts/deploy.js writes it
    const transcript = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ceremony", "v1m-mainnet", "transcript.json"), "utf8"));
    const record = {
        network: network.name,
        chainId,
        version: "v1-mainnet",
        noidPool: pool.address,
        noidPoolImplementation: await upgrades.erc1967.getImplementationAddress(pool.address),
        noidPoolVersion: await pool.version(),
        proxyKind: "uups (ERC-1967)",
        deployBlock: Number(process.env.DEPLOY_BLOCK),
        transferVerifier: await pool.transferVerifier(),
        withdrawVerifier: await pool.withdrawVerifier(),
        poseidonT3: "0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93",
        poseidonT5: "0x555333f3f677Ca3930Bf7c56ffc75144c51D9767",
        wrappedNative: await pool.wrappedNative(),
        tokens,
        uniswapV3: venue && adapter ? { ...venue, adapter } : null,
        trustedSetup: {
            transcript: "ceremony/v1m-mainnet/transcript.json",
            contributions: transcript.contributions.map((c) => c.name),
            beacon: transcript.beacon && transcript.beacon.source,
            final: transcript.final
        },
        owner: deployer.address,
        relayer: {
            address: relayer.address,
            keyNetwork,
            userCommitment: relayer.userCommitmentBytes32,
            viewingPublicKey: relayer.viewing.ivkPub
        },
        resumed: "the deploy stopped after the adapter (an RPC timeout); scripts/resume-deploy.js finished it"
    };
    const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 4) + "\n");
    console.log(`\nwritten ${path.relative(process.cwd(), file)}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
