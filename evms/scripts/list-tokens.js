/**
 * Brings a deployed mainnet pool's accepted tokens up to date with
 * helpers/mainnet-tokens.js: configureToken for each listed token the pool
 * does not accept yet. Tokens it already accepts keep their cap (raise caps
 * deliberately, one by one). Safe to run again.
 *
 *   npx hardhat run scripts/list-tokens.js --network monadMainnetFork   (rehearsal)
 *   npx hardhat run scripts/list-tokens.js --network monadMainnet
 *
 * The pool's owner signs. Updates `tokens` in deployments/<network>.json.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const { MAINNET_TOKENS } = require("../helpers/mainnet-tokens");

const ERC20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

async function main() {
    const { ethers, network } = hre;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const list = MAINNET_TOKENS[chainId];
    if (!list) throw new Error(`no token list for chain ${chainId} in helpers/mainnet-tokens.js`);

    const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
    if (!fs.existsSync(file)) throw new Error(`no deployment record: ${path.relative(process.cwd(), file)}`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const [signer] = await ethers.getSigners();
    const pool = await ethers.getContractAt("NoidPool", record.noidPool, signer);
    if ((await pool.owner()).toLowerCase() !== signer.address.toLowerCase()) throw new Error(`${signer.address} does not own the pool`);

    const log = (line) => console.log("  " + line);
    console.log(`Listing tokens on the pool ${record.noidPool} (${network.name}, chain ${chainId})\n`);

    record.tokens = record.tokens || {};
    let added = 0;
    for (const t of list) {
        const token = new ethers.Contract(t.address, ERC20, ethers.provider);
        const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
        if (symbol !== t.symbol && symbol.toUpperCase() !== t.symbol.toUpperCase()) log(`note: ${t.symbol} calls itself ${symbol} on-chain`);
        const config = await pool.tokenConfig(t.address);
        if (config.depositsEnabled) {
            log(`${t.symbol.padEnd(9)} already accepted (max ${ethers.utils.formatUnits(config.maxDeposit, decimals)} per deposit)`);
        } else {
            await (await pool.configureToken(t.address, true, ethers.utils.parseUnits(t.cap, decimals))).wait();
            log(`${t.symbol.padEnd(9)} accepted  ${t.address}  (max ${t.cap} per deposit)`);
            added += 1;
        }
        record.tokens[t.symbol] = t.address;
    }

    fs.writeFileSync(file, JSON.stringify(record, null, 4) + "\n");
    console.log(`\n${added} token(s) added; recorded in ${path.relative(process.cwd(), file)}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
