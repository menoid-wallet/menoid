/**
 * Menoid v1-mainnet deployment.
 *
 *   npx hardhat node                                         (another shell)
 *   npx hardhat run scripts/deploy.js --network localhost
 *
 * On a local network this also deploys mock tokens (wrapped native + USDC).
 * On a live network set WRAPPED_NATIVE (WMON / WETH / WPOL address); accepted
 * tokens are then configured separately with configureToken.
 *
 * signers[0] deploys, owns the pool (move ownership to a multisig on a live
 * network), and is registered as the relayer identity.
 *
 * Writes deployments/<network>.json.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { deployLocalSystem, deployNoidPool } = require("../helpers/deploy");
const { deriveWallet, registerWallet } = require("../helpers/wallets");

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

async function main() {
    const { ethers, network } = hre;
    const [deployer] = await ethers.getSigners();
    const log = (line) => console.log("  " + line);

    console.log(`Deploying Menoid v1-mainnet to ${network.name} with ${deployer.address}\n`);

    let system;
    if (LOCAL_NETWORKS.has(network.name)) {
        system = await deployLocalSystem(hre, { log });
    } else {
        const wrappedNative = process.env.WRAPPED_NATIVE;
        if (!wrappedNative) throw new Error("set WRAPPED_NATIVE to the chain's wrapped native token address");
        system = await deployNoidPool(hre, { wrappedNative, log });
    }

    // the relayer's identity: fee notes are locked to its user commitment
    const relayer = await deriveWallet(deployer);
    await registerWallet(system.pool, relayer);
    log(`relayer registered (user commitment ${relayer.userCommitmentBytes32})`);

    const record = {
        network: network.name,
        chainId: (await ethers.provider.getNetwork()).chainId,
        version: "v1-mainnet",
        noidPool: system.pool.address,
        deployBlock: system.deployBlock,
        transferVerifier: system.transferVerifier.address,
        withdrawVerifier: system.withdrawVerifier.address,
        poseidonT3: system.poseidonT3.address,
        poseidonT5: system.poseidonT5.address,
        wrappedNative: system.wrappedNative ? system.wrappedNative.address : process.env.WRAPPED_NATIVE,
        tokens: system.usdc ? { USDC: system.usdc.address } : {},
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
