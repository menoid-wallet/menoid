/**
 * The MAINNET trusted setup (Groth16 phase 2) for the v1-mainnet circuits.
 *
 *   Phase 1  the Hermez / Polygon perpetual powers of tau (powersOfTau28_hez_final_17),
 *            checked against the blake2b hash snarkjs publishes. Many contributors.
 *   Phase 2  this ceremony, per circuit (transfer_proof, withdraw_proof):
 *
 *     node scripts/ceremony.js init                    fresh compile check, then contribution #0
 *     node scripts/ceremony.js contribute "Your name"  adds one contribution: type random text when asked
 *                                                      (snarkjs mixes in 64 bytes of OS randomness too)
 *     node scripts/ceremony.js beacon                  a public random beacon: the hash of the latest
 *                                                      Monad mainnet block, taken AFTER the last contribution
 *     node scripts/ceremony.js finalize                verifies every step against phase 1, then writes
 *                                                      contracts/Mainnet{Transfer,Withdraw}Verifier.sol and
 *                                                      website/public/zk/v1m/mainnet/*_proof_final.zkey
 *     node scripts/ceremony.js status
 *
 * The setup is sound if ANY ONE contributor destroyed their randomness (snarkjs
 * keeps it only in memory, for the length of one command). More people, on
 * other machines, make it stronger: send them the two latest .zkey files and
 * this script; they run `contribute` and send the two new files back.
 *
 * Everything public goes into ceremony/v1m-mainnet/transcript.json (committed):
 * the circuits' hashes, every contribution's hash, the beacon, the final keys.
 * The .zkey files themselves are git-ignored; the final ones are served by the
 * website.
 *
 * The testnet pools keep the development setup (contracts/TransferVerifier.sol,
 * website/public/zk/v1m/*.zkey) — those keys were made by one contributor and
 * must never secure real funds.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { execFileSync } = require("child_process");
const snarkjs = require("snarkjs");

const EVMS = path.join(__dirname, "..");
const WEBSITE_ZK = path.join(EVMS, "..", "..", "website", "public", "zk", "v1m");
const DIR = path.join(EVMS, "ceremony", "v1m-mainnet");
const TRANSCRIPT = path.join(DIR, "transcript.json");
const PTAU = path.join(EVMS, "ptau", "powersOfTau28_hez_final_17.ptau");
// snarkjs README, "powersOfTau28_hez_final_17.ptau"
const PTAU_BLAKE2B =
    "6247a3433948b35fbfae414fa5a9355bfb45f56efa7ab4929e669264a0258976741dfbe3288bfb49828e5df02c2e633df38d2245e30162ae7e3bcca5b8b49345";
const BEACON_RPC = process.env.CEREMONY_BEACON_RPC || "https://rpc.monad.xyz";
const BEACON_ITERATIONS_EXP = 10;
// snarkjs' package exports hide these from require(): read them by path
const SNARKJS_DIR = path.join(EVMS, "node_modules", "snarkjs");

const CIRCUITS = {
    transfer: { source: "circuits/transfer_proof.circom", r1cs: "build/v1m/transfer_proof.r1cs", wasm: "build/v1m/transfer_proof_js/transfer_proof.wasm", contract: "MainnetTransferVerifier" },
    withdraw: { source: "circuits/withdraw_proof.circom", r1cs: "build/v1m/withdraw_proof.r1cs", wasm: "build/v1m/withdraw_proof_js/withdraw_proof.wasm", contract: "MainnetWithdrawVerifier" }
};

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const blake2b = (file) => {
    const hash = crypto.createHash("blake2b512");
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(1 << 20);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    fs.closeSync(fd);
    return hash.digest("hex");
};
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const pad = (n) => String(n).padStart(4, "0");
const zkeyPath = (name, index) => path.join(DIR, `${name}_${typeof index === "number" ? pad(index) : index}.zkey`);
const load = () => JSON.parse(fs.readFileSync(TRANSCRIPT, "utf8"));
const save = (t) => fs.writeFileSync(TRANSCRIPT, JSON.stringify(t, null, 4) + "\n");
const say = (line = "") => console.log(line);

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer))));
}

async function init() {
    if (fs.existsSync(TRANSCRIPT)) throw new Error(`a ceremony already exists (${path.relative(EVMS, TRANSCRIPT)}); move it away to start over`);
    fs.mkdirSync(DIR, { recursive: true });

    say("phase 1: checking the powers of tau file …");
    const b2 = blake2b(PTAU);
    if (b2 !== PTAU_BLAKE2B) throw new Error("ptau/powersOfTau28_hez_final_17.ptau is not the published file (blake2b differs)");
    say("  powersOfTau28_hez_final_17.ptau = the published Hermez file ✓");

    // the ceremony must be for EXACTLY the circuits the website proves with
    say("circuits: compiling the sources again and comparing …");
    const compiled = path.join(DIR, "compile");
    fs.mkdirSync(compiled, { recursive: true });
    const circuits = {};
    for (const [name, c] of Object.entries(CIRCUITS)) {
        execFileSync("circom", [c.source, "--O2", "--r1cs", "--wasm", "-o", compiled], { cwd: EVMS, stdio: "ignore" });
        const fresh = { r1cs: sha256(path.join(compiled, `${name}_proof.r1cs`)), wasm: sha256(path.join(compiled, `${name}_proof_js`, `${name}_proof.wasm`)) };
        const built = { r1cs: sha256(path.join(EVMS, c.r1cs)), wasm: sha256(path.join(EVMS, c.wasm)) };
        const served = sha256(path.join(WEBSITE_ZK, `${name}_proof.wasm`));
        if (fresh.r1cs !== built.r1cs || fresh.wasm !== built.wasm) throw new Error(`${name}: build/v1m is stale — run scripts/build_circuits.sh first`);
        if (served !== built.wasm) throw new Error(`${name}: the website serves a different ${name}_proof.wasm`);
        const info = await snarkjs.r1cs.info(path.join(EVMS, c.r1cs));
        circuits[name] = { source: c.source, sourceSha256: sha256(path.join(EVMS, c.source)), r1csSha256: built.r1cs, wasmSha256: built.wasm, constraints: info.nConstraints };
        say(`  ${name}: ${info.nConstraints} constraints; source, r1cs and the website's wasm agree ✓`);
    }
    fs.rmSync(compiled, { recursive: true, force: true });

    for (const [name, c] of Object.entries(CIRCUITS)) {
        say(`phase 2 start: ${name} (groth16 setup) …`);
        await snarkjs.zKey.newZKey(path.join(EVMS, c.r1cs), PTAU, zkeyPath(name, 0));
    }

    save({
        ceremony: "Menoid v1-mainnet, Groth16 phase 2",
        startedAt: new Date().toISOString(),
        tools: { snarkjs: JSON.parse(fs.readFileSync(path.join(SNARKJS_DIR, "package.json"), "utf8")).version, circom: execFileSync("circom", ["--version"]).toString().trim() },
        phase1: { file: "powersOfTau28_hez_final_17.ptau", blake2b: PTAU_BLAKE2B, origin: "Hermez / Polygon perpetual powers of tau, as listed in the snarkjs README" },
        circuits,
        contributions: [],
        beacon: null,
        final: null
    });
    say(`\nready. Next: node scripts/ceremony.js contribute "Your name"`);
}

async function contribute(name, auto) {
    if (!name) throw new Error('usage: node scripts/ceremony.js contribute "Your name" [--auto]');
    const t = load();
    if (t.beacon) throw new Error("the beacon is already applied: the ceremony is closed");
    const n = t.contributions.length;

    let entropy;
    if (auto) entropy = crypto.randomBytes(64).toString("hex");
    else {
        say("Type a long random text (mash the keyboard), then press Enter.");
        say("It is mixed with 64 bytes of OS randomness and forgotten when this command ends.");
        entropy = await ask("> ");
        if (entropy.trim().length < 8) throw new Error("type a bit more than that");
    }

    const record = { index: n + 1, name, at: new Date().toISOString(), contributionHash: {}, zkeySha256: {} };
    for (const circuit of Object.keys(CIRCUITS)) {
        say(`contributing to ${circuit} …`);
        const hash = await snarkjs.zKey.contribute(zkeyPath(circuit, n), zkeyPath(circuit, n + 1), name, `${entropy}/${circuit}/${crypto.randomBytes(32).toString("hex")}`);
        record.contributionHash[circuit] = hex(hash);
        record.zkeySha256[circuit] = sha256(zkeyPath(circuit, n + 1));
    }
    entropy = null;
    t.contributions.push(record);
    save(t);
    for (const circuit of Object.keys(CIRCUITS)) fs.rmSync(zkeyPath(circuit, n), { force: true });
    say(`\ncontribution #${n + 1} by ${name} recorded:`);
    for (const [circuit, h] of Object.entries(record.contributionHash)) say(`  ${circuit}: ${h}`);
    say("Publish these hashes; anyone can later check they are in the final keys.");
}

async function beacon() {
    const t = load();
    if (t.beacon) throw new Error("the beacon is already applied");
    if (t.contributions.length === 0) throw new Error("contribute first");
    const res = await fetch(BEACON_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] })
    });
    const block = (await res.json()).result;
    if (!block || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new Error("could not read a block hash for the beacon");
    const number = parseInt(block.number, 16);
    const at = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
    const last = t.contributions[t.contributions.length - 1];
    if (at <= last.at) throw new Error("the beacon block must come after the last contribution");
    const n = t.contributions.length;
    const label = `Beacon: Monad mainnet block ${number}`;
    for (const circuit of Object.keys(CIRCUITS)) {
        say(`applying the beacon to ${circuit} …`);
        await snarkjs.zKey.beacon(zkeyPath(circuit, n), zkeyPath(circuit, "final"), label, block.hash.slice(2), BEACON_ITERATIONS_EXP);
    }
    t.beacon = { source: `Monad mainnet (chain 143) block ${number}, via ${BEACON_RPC}`, blockNumber: number, blockTime: at, hash: block.hash, iterationsExp: BEACON_ITERATIONS_EXP, appliedAt: new Date().toISOString() };
    save(t);
    for (const circuit of Object.keys(CIRCUITS)) fs.rmSync(zkeyPath(circuit, n), { force: true });
    say(`\nbeacon applied (block ${number}, ${block.hash}). Next: node scripts/ceremony.js finalize`);
}

async function finalize() {
    const t = load();
    if (!t.beacon) throw new Error("apply the beacon first");
    const template = fs.readFileSync(path.join(SNARKJS_DIR, "templates", "verifier_groth16.sol.ejs"), "utf8");
    fs.mkdirSync(path.join(WEBSITE_ZK, "mainnet"), { recursive: true });
    const final = {};
    for (const [circuit, c] of Object.entries(CIRCUITS)) {
        const zkey = zkeyPath(circuit, "final");
        say(`verifying ${circuit}: every contribution and the beacon, against phase 1 (takes a minute) …`);
        const lines = [];
        const logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), debug: () => {} };
        const ok = await snarkjs.zKey.verifyFromR1cs(path.join(EVMS, c.r1cs), PTAU, zkey, logger);
        fs.writeFileSync(path.join(DIR, `${circuit}_verify.log`), lines.join("\n") + "\n");
        if (!ok) throw new Error(`${circuit}: the final key does NOT verify — see ${circuit}_verify.log`);

        const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
        const vkeyFile = path.join(DIR, `${circuit}_verification_key.json`);
        fs.writeFileSync(vkeyFile, JSON.stringify(vkey, null, 1) + "\n");

        let sol = await snarkjs.zKey.exportSolidityVerifier(zkey, { groth16: template });
        sol = sol.replace(/contract Groth16Verifier/, `contract ${c.contract}`);
        const header = `// ${c.contract}: the MAINNET verifier for ${path.basename(c.source)}, from the\n// Menoid v1-mainnet phase-2 ceremony (ceremony/v1m-mainnet/transcript.json).\n`;
        fs.writeFileSync(path.join(EVMS, "contracts", `${c.contract}.sol`), header + sol);

        const served = path.join(WEBSITE_ZK, "mainnet", `${circuit}_proof_final.zkey`);
        fs.copyFileSync(zkey, served);
        final[circuit] = {
            zkeySha256: sha256(zkey),
            verificationKeySha256: sha256(vkeyFile),
            verifier: `contracts/${c.contract}.sol`,
            served: `website/public/zk/v1m/mainnet/${circuit}_proof_final.zkey`
        };
        say(`  ${circuit}: verified ✓ → contracts/${c.contract}.sol, ${path.relative(path.join(EVMS, "..", ".."), served)}`);
    }
    t.final = final;
    t.finalizedAt = new Date().toISOString();
    save(t);
    say("\nthe mainnet setup is final. Compile the contracts (npx hardhat compile) before deploying.");
}

function status() {
    if (!fs.existsSync(TRANSCRIPT)) return say("no ceremony yet: node scripts/ceremony.js init");
    const t = load();
    say(`${t.ceremony} — started ${t.startedAt}`);
    say(`phase 1: ${t.phase1.file} (blake2b ${t.phase1.blake2b.slice(0, 16)}…)`);
    for (const [name, c] of Object.entries(t.circuits)) say(`circuit ${name}: ${c.constraints} constraints, r1cs ${c.r1csSha256.slice(0, 16)}…`);
    for (const c of t.contributions) say(`#${c.index} ${c.name} (${c.at}): transfer ${c.contributionHash.transfer.slice(0, 16)}…, withdraw ${c.contributionHash.withdraw.slice(0, 16)}…`);
    say(t.beacon ? `beacon: ${t.beacon.source}, ${t.beacon.hash}` : "beacon: not yet");
    say(t.final ? `final: verified, ${t.finalizedAt}` : "final: not yet");
}

const [command, ...args] = process.argv.slice(2);
const run = { init, contribute: () => contribute(args.find((a) => !a.startsWith("--")), args.includes("--auto")), beacon, finalize, status }[command];
if (!run) {
    console.error("usage: node scripts/ceremony.js init | contribute \"Name\" [--auto] | beacon | finalize | status");
    process.exit(1);
}
Promise.resolve(run())
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(`\n✗ ${error.message}`);
        process.exit(1);
    });
