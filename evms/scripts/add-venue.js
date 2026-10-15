/**
 * Adds a swap venue to a deployed pool: a Uniswap V3 fork without Uniswap's
 * router (helpers/uniswap.js V3_FORKS), reached through a V3PoolAdapter that
 * swaps straight through its pools and is also its quoter.
 *
 *   VENUE=capricorn npx hardhat run scripts/add-venue.js --network monadMainnetFork   (rehearsal)
 *   VENUE=capricorn npx hardhat run scripts/add-venue.js --network monadMainnet
 *
 * Deploys the adapter (unless the record already has one), whitelists it with
 * setSwapAdapter (the pool's owner signs), and records it under `venues` in
 * deployments/<network>.json. The backend then needs its address
 * (website/backend/v1mainnet/config.js, venue "capricorn").
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { deployV3PoolAdapter } = require("../helpers/deploy");
const { V3_FORKS } = require("../helpers/uniswap");

async function main() {
    const { ethers, network } = hre;
    const id = (process.env.VENUE || "").toLowerCase();
    const venue = V3_FORKS[id];
    if (!venue) throw new Error(`VENUE must be one of: ${Object.keys(V3_FORKS).join(", ")}`);

    const chainId = (await ethers.provider.getNetwork()).chainId;
    if (chainId !== venue.chainId) throw new Error(`${venue.name} is on chain ${venue.chainId}, not ${chainId}`);
    if ((await ethers.provider.getCode(venue.factory)) === "0x") throw new Error(`no ${venue.name} factory at ${venue.factory}`);

    const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
    if (!fs.existsSync(file)) throw new Error(`no deployment record: ${path.relative(process.cwd(), file)}`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const [signer] = await ethers.getSigners();
    const pool = await ethers.getContractAt("NoidPool", record.noidPool, signer);
    if ((await pool.owner()).toLowerCase() !== signer.address.toLowerCase()) throw new Error(`${signer.address} does not own the pool`);

    const log = (line) => console.log("  " + line);
    console.log(`Adding ${venue.name} to the pool ${record.noidPool} on ${network.name} (chain ${chainId})\n`);

    record.venues = record.venues || {};
    let adapter = record.venues[id] && record.venues[id].adapter;
    if (adapter) {
        log(`adapter already deployed: ${adapter}`);
        if (!(await pool.swapAdapters(adapter))) {
            await (await pool.setSwapAdapter(adapter, true)).wait();
            log("whitelisted it again");
        }
    } else {
        const deployed = await deployV3PoolAdapter(hre, { pool, factory: venue.factory, label: `${venue.name} adapter`, log });
        adapter = deployed.address;
    }
    if (!(await pool.swapAdapters(adapter))) throw new Error("the adapter is not whitelisted");

    record.venues[id] = { name: venue.name, factory: venue.factory, adapter, kind: "V3PoolAdapter (swaps through the pools; also the venue's quoter)" };
    fs.writeFileSync(file, JSON.stringify(record, null, 4) + "\n");
    console.log(`\nrecorded in ${path.relative(process.cwd(), file)}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
