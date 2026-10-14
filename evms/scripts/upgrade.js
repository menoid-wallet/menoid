/**
 * Upgrade a deployed NoidPool proxy to the current compiled implementation.
 *
 *   npx hardhat run scripts/upgrade.js --network <network>
 *
 * Reads deployments/<network>.json (written by scripts/deploy.js). Before
 * anything is sent, the upgrades plugin checks that the new implementation is
 * upgrade-safe and that its storage layout is compatible with the deployed
 * one, and refuses otherwise.
 *
 * Optional environment:
 *   CONTRACT=NoidPool          implementation contract to upgrade to
 *   TRANSFER_VERIFIER=0x...    new verifiers, when the circuits changed
 *   WITHDRAW_VERIFIER=0x...    (otherwise the current ones are kept)
 *   DRY_RUN=1                  only validate, send nothing
 *
 * The signer must be the pool's owner. On a live network that should be a
 * multisig, in which case use DRY_RUN=1 here and propose upgradeTo(<new
 * implementation>) from the multisig (`upgrades.prepareUpgrade` deploys the
 * implementation without switching to it).
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { upgradeNoidPool, PROXY_OPTIONS } = require("../helpers/deploy");

async function main() {
    const { ethers, upgrades, network } = hre;
    const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));

    const pool = await ethers.getContractAt("NoidPool", record.noidPool);
    const contractName = process.env.CONTRACT || "NoidPool";
    const libraries = { PoseidonT3: record.poseidonT3, PoseidonT5: record.poseidonT5 };
    const constructorArgs = [
        process.env.TRANSFER_VERIFIER || (await pool.transferVerifier()),
        process.env.WITHDRAW_VERIFIER || (await pool.withdrawVerifier()),
        await pool.wrappedNative()
    ];

    const [signer] = await ethers.getSigners();
    console.log(`proxy            ${record.noidPool}`);
    console.log(`current version  ${await pool.version()} (implementation ${await upgrades.erc1967.getImplementationAddress(pool.address)})`);
    console.log(`owner            ${await pool.owner()}   signer ${signer.address}`);

    const factory = await ethers.getContractFactory(contractName, { libraries });
    await upgrades.validateUpgrade(record.noidPool, factory, { ...PROXY_OPTIONS, constructorArgs });
    console.log(`${contractName}: upgrade-safe, storage layout compatible`);

    if (process.env.DRY_RUN) {
        console.log("DRY_RUN: nothing sent");
        return;
    }

    const { pool: upgraded, implementation } = await upgradeNoidPool(hre, {
        pool,
        contractName,
        libraries,
        constructorArgs,
        log: (line) => console.log(line)
    });

    record.noidPoolImplementation = implementation;
    record.noidPoolVersion = await upgraded.version();
    record.transferVerifier = constructorArgs[0];
    record.withdrawVerifier = constructorArgs[1];
    fs.writeFileSync(file, JSON.stringify(record, null, 4) + "\n");
    console.log(`upgraded to ${record.noidPoolVersion}; ${path.relative(process.cwd(), file)} updated`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
