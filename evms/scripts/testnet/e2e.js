/**
 * Menoid v1-mainnet end to end on Monad testnet, with real wallets. TESTNET ONLY.
 *
 *   npx hardhat run scripts/testnet/deploy-uniswap.js --network monadTestnet
 *   npx hardhat run scripts/deploy.js --network monadTestnet
 *   npx hardhat run scripts/testnet/e2e.js --network monadTestnet
 *
 * Four new wallets: alice, bob and carol register; dave never does (a public
 * address that only receives withdrawals). Their private keys stay in
 * testnet-wallets.<network>.local.json (git-ignored). The deployer is the
 * relayer: it submits every private transaction and earns the fee notes.
 *
 * Everything is recorded in deployments/<network>-e2e.json, plus a readable
 * deployments/<network>-e2e.txt: transactions and gas, every note's
 * commitment, owner, token, amount and leaf, every nullifier, the routes the
 * backend picked, what each viewing key saw, and the attacks that were
 * refused. The record holds no private keys and no viewing keys.
 *
 * Resumable: finished steps are skipped when the script runs again, and a
 * step whose transaction was sent but not recorded is finished from its
 * receipt.
 *
 * Monad specifics handled here:
 *   - fees are charged on the gas LIMIT: limits are the estimate + 10%
 *   - reserve balance: an account under 10 MON may only send value in a
 *     transaction that is its first in 3 blocks, so native deposits wait
 *   - eth_getLogs is capped: the mirror reads 100-block windows
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const W = require("../../helpers/wallets");
const { PoolMirror } = require("../../helpers/merkle");
const { scan, viewerFromWallet, viewerFromViewingKey } = require("../../helpers/scanner");
const { buildDeposit, buildTransfer, buildWithdraw, buildSwap } = require("../../helpers/transactions");
const { shutdownProver } = require("../../helpers/prover");
const { findBestRoute, withSlippage } = require("../../helpers/uniswap");
const { toBytes32 } = require("../../helpers/commitments");
const { ACTION } = require("../../helpers/encryption");
const { ResilientProvider } = require("../../helpers/rpc");
const { PROXY_OPTIONS } = require("../../helpers/deploy");

const EVMS = path.join(__dirname, "..", "..");
const RESERVE_DELAY_BLOCKS = 3;     // Monad's k
const GAS_BUFFER_PCT = 110;         // gas limit = estimate + 10%
const LOG_WINDOW = 100;             // blocks per eth_getLogs

const FUNDING = { alice: "2.5", bob: "2", carol: "1" };   // MON: gas, and the native deposits
const MUSDC_MINT = { alice: "500", bob: "300" };
const IDENTITIES = ["alice", "bob", "carol", "relayer"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex32 = (value) => toBytes32(value);
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(EVMS, relative), "utf8"));
const actionName = (code) => Object.keys(ACTION).find((name) => ACTION[name] === code) || String(code);

// ─── the run record ────────────────────────────────────────────────────────

class Journal {
    constructor(file, header) {
        this.file = file;
        this.data = fs.existsSync(file)
            ? JSON.parse(fs.readFileSync(file, "utf8"))
            : { ...header, startedAt: new Date().toISOString(), steps: [] };
    }

    get(id) {
        return this.data.steps.find((s) => s.id === id);
    }

    put(step) {
        const i = this.data.steps.findIndex((s) => s.id === step.id);
        if (i === -1) this.data.steps.push(step);
        else this.data.steps[i] = step;
        this.save();
    }

    save() {
        const json = JSON.stringify(this.data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 4);
        fs.writeFileSync(this.file, json + "\n");
    }
}

function revertReason(error) {
    const text = [JSON.stringify(error), error && error.message, error && error.error && error.error.message]
        .filter(Boolean)
        .join(" ");
    const data = text.match(/0x08c379a0[0-9a-fA-F]+/);
    if (data) {
        try {
            return ethers.utils.defaultAbiCoder.decode(["string"], "0x" + data[0].slice(10))[0];
        } catch {
            // not a well-formed Error(string)
        }
    }
    const quoted = text.match(/reverted with reason string '([^']*)'/) || text.match(/execution reverted: ([^"\\]+)/);
    if (quoted) return quoted[1];
    return String((error && (error.reason || error.message)) || error).slice(0, 160);
}

async function main() {
    const net = hre.network;
    if (!net.config.url) throw new Error("run against a live testnet, or a local fork node");
    const deployment = readJson(`deployments/${net.name}.json`);
    const venue = readJson(`deployments/${net.name}-uniswap.json`);

    const provider = new ResilientProvider(net.config.url, deployment.chainId);
    const { chainId } = await provider.getNetwork();
    if (W.keyNetworkForChainId(chainId) !== "testnet") throw new Error("testnet only");
    const devNode = /hardhat|anvil/i.test(await provider.send("web3_clientVersion", []));

    const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    if (deployer.address !== deployment.relayer.address) throw new Error("PRIVATE_KEY is not this deployment's relayer");

    const poolAbi = (await hre.artifacts.readArtifact("NoidPool")).abi;
    const erc20Abi = (await hre.artifacts.readArtifact("MockERC20")).abi;
    const pool = new ethers.Contract(deployment.noidPool, poolAbi, provider);
    const adapter = deployment.uniswapV3.adapter;

    const TOKENS = {
        WMON: { address: ethers.utils.getAddress(venue.tokens.WMON), decimals: 18 },
        mUSDC: { address: ethers.utils.getAddress(venue.tokens.mUSDC), decimals: 6 },
        mTKN: { address: ethers.utils.getAddress(venue.tokens.mTKN), decimals: 18 }
    };
    const symbolOf = (address) => Object.keys(TOKENS).find((s) => TOKENS[s].address === ethers.utils.getAddress(address));
    const units = (symbol, n) => BigInt(ethers.utils.parseUnits(String(n), TOKENS[symbol].decimals).toString());
    const show = (symbol, amount) => `${ethers.utils.formatUnits(BigInt(amount).toString(), TOKENS[symbol].decimals)} ${symbol}`;
    const erc20 = (symbol) => new ethers.Contract(TOKENS[symbol].address, erc20Abi, provider);

    // ── wallets ─────────────────────────────────────────────────────────────
    const walletFile = path.join(EVMS, `testnet-wallets.${net.name}.local.json`);
    if (!fs.existsSync(walletFile)) {
        const wallets = {};
        for (const name of ["alice", "bob", "carol", "dave"]) {
            const wallet = ethers.Wallet.createRandom();
            wallets[name] = { address: wallet.address, privateKey: wallet.privateKey };
        }
        const content = {
            warning: "TESTNET ONLY: private keys of the e2e test wallets. Never commit; never hold real assets here.",
            network: net.name,
            chainId,
            wallets
        };
        fs.writeFileSync(walletFile, JSON.stringify(content, null, 4) + "\n", { mode: 0o600 });
    }
    const walletKeys = JSON.parse(fs.readFileSync(walletFile, "utf8")).wallets;
    const signers = { relayer: deployer };
    for (const [name, { privateKey }] of Object.entries(walletKeys)) signers[name] = new ethers.Wallet(privateKey, provider);
    const labelOf = (address) =>
        Object.keys(signers).find((name) => signers[name].address === ethers.utils.getAddress(address)) || address;

    // every private identity: one signature of the testnet key message each
    const ids = {};
    for (const name of IDENTITIES) ids[name] = await W.deriveWallet(signers[name], { network: "testnet" });
    async function refreshEpoch(name) {
        const onChain = await W.resolveRecipient(pool, ids[name].address);
        if (onChain.registered && onChain.viewingEpoch !== ids[name].viewingEpoch) {
            ids[name] = W.withViewingEpoch(ids[name], onChain.viewingEpoch);
        }
    }
    for (const name of IDENTITIES) await refreshEpoch(name);
    const relayerRecipient = await W.resolveRecipient(pool, deployer.address);
    if (!relayerRecipient.registered) throw new Error("the relayer is not registered: run scripts/deploy.js first");

    const mirror = new PoolMirror(pool, { fromBlock: deployment.deployBlock, maxBlockRange: LOG_WINDOW });
    const view = async (name) => {
        await mirror.sync();
        return scan(mirror, viewerFromWallet(ids[name]));
    };

    const journal = new Journal(path.join(EVMS, "deployments", `${net.name}-e2e.json`), {
        network: net.name,
        chainId,
        pool: deployment.noidPool,
        implementation: deployment.noidPoolImplementation,
        adapter,
        uniswapV3: {
            deployedBy: "scripts/testnet/deploy-uniswap.js (official Uniswap bytecode)",
            factory: venue.factory,
            swapRouter02: venue.swapRouter02,
            quoterV2: venue.quoterV2,
            pools: Object.fromEntries(Object.entries(venue.pools).map(([key, p]) => [key, p.address]))
        },
        tokens: Object.fromEntries(Object.entries(TOKENS).map(([s, t]) => [s, t.address])),
        participants: Object.fromEntries(
            Object.keys(signers).map((name) => [
                name,
                {
                    address: signers[name].address,
                    userCommitment: ids[name] ? ids[name].userCommitmentBytes32 : null,
                    registers: Boolean(ids[name])
                }
            ])
        ),
        keyNetwork: "testnet",
        gasPolicy: "gas limit = eth_estimateGas + 10% for pool calls (Monad charges the limit); exact for the rest"
    });

    console.log(`Menoid v1-mainnet e2e on ${net.name} (chain ${chainId})${devNode ? " [local fork node]" : ""}`);
    console.log(`pool ${pool.address}   relayer ${deployer.address}\n`);

    // ── sending ─────────────────────────────────────────────────────────────
    const nonces = new Map();
    const lastTxBlock = new Map();

    async function send(signer, request, { buffer = true } = {}) {
        const from = signer.address;
        let estimate;
        try {
            estimate = await provider.estimateGas({ ...request, from });
        } catch (error) {
            throw new Error(`would revert: ${revertReason(error)}`);
        }
        const gasLimit = buffer ? estimate.mul(GAS_BUFFER_PCT).div(100) : estimate;
        if (!nonces.has(from)) nonces.set(from, await provider.getTransactionCount(from, "pending"));
        const nonce = nonces.get(from);
        let tx;
        try {
            tx = await signer.sendTransaction({ ...request, gasLimit, nonce, chainId });
        } catch (error) {
            nonces.delete(from);   // read it from the node again next time
            throw error;
        }
        nonces.set(from, nonce + 1);
        return { tx, estimate, gasLimit };
    }

    async function confirm(hash) {
        const receipt = await provider.waitForTransaction(hash, 1, 180000);
        if (!receipt) throw new Error(`no receipt for ${hash} after 3 minutes`);
        lastTxBlock.set(ethers.utils.getAddress(receipt.from), receipt.blockNumber);
        return receipt;
    }

    // Monad charges gas limit x price
    function finishTx(record, receipt) {
        const price = receipt.effectiveGasPrice;
        Object.assign(record, {
            block: receipt.blockNumber,
            status: receipt.status === 1 ? "success" : "reverted",
            gasUsed: receipt.gasUsed.toString(),
            gasPriceGwei: ethers.utils.formatUnits(price, "gwei"),
            costMON: ethers.utils.formatEther(ethers.BigNumber.from(record.gasLimit).mul(price))
        });
        return record;
    }

    async function sendAndConfirm(signer, request, options) {
        const { tx, estimate, gasLimit } = await send(signer, request, options);
        const record = { hash: tx.hash, from: signer.address, gasEstimate: estimate.toString(), gasLimit: gasLimit.toString() };
        return finishTx(record, await confirm(tx.hash));
    }

    // an account under 10 MON may send value only in its first transaction in k blocks
    async function waitForReserveWindow(address) {
        const last = lastTxBlock.get(address);
        if (devNode || last === undefined) return;
        while ((await provider.getBlockNumber()) < last + RESERVE_DELAY_BLOCKS) await sleep(250);
    }

    const poolEvents = (receipt) =>
        receipt.logs
            .filter((log) => ethers.utils.getAddress(log.address) === pool.address)
            .map((log) => {
                try {
                    return pool.interface.parseLog(log);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

    const outputsOf = (step) => [...(step.outputs || []), ...(step.parts || []).flatMap((part) => part.outputs)];

    // everything a receipt adds to a step, so a re-run can finish it the same way
    function finalize(step, receipt) {
        finishTx(step.tx, receipt);
        if (receipt.status !== 1) {
            step.status = "failed";
            return step;
        }
        const events = poolEvents(receipt);
        const created = events.filter((e) => e.name === "NoteCreated");
        const leafOf = (commitment) => {
            const event = created.find((e) => BigInt(e.args.commitment) === BigInt(commitment));
            return event ? { treeId: event.args.treeId.toNumber(), leafIndex: event.args.leafIndex.toNumber() } : {};
        };
        for (const out of outputsOf(step)) Object.assign(out, leafOf(out.commitment));

        const swapped = events.find((e) => e.name === "Swapped");
        if (step.swap && swapped) {
            const amountOut = BigInt(swapped.args.amountOut.toString());
            const symbol = step.swap.tokenOut;
            step.swap.amountOut = amountOut.toString();
            step.swap.received = show(symbol, amountOut);
            const bought = {
                role: "bought",
                owner: step.swap.owner,
                token: symbol,
                amount: amountOut.toString(),
                commitment: hex32(swapped.args.commitment)
            };
            step.outputs.push({ ...bought, ...leafOf(bought.commitment) });
            step.flows.push({ who: step.swap.owner, token: symbol, amount: amountOut.toString() });
        }

        const deposited = events.find((e) => e.name === "Deposited");
        if (step.deposit && deposited) {
            step.deposit.onChainCommitment = hex32(deposited.args.commitment);
            step.deposit.matchesClient = step.deposit.onChainCommitment === step.outputs[0].commitment;
        }

        const spent = events.filter((e) => e.name === "NullifierSpent").map((e) => e.args.nullifier);
        if (spent.length) step.nullifiersOnChain = spent;
        step.status = "done";
        return step;
    }

    async function step(id, title, run) {
        const saved = journal.get(id);
        if (saved && saved.status === "done") {
            console.log(`  ✓ ${title}  (recorded earlier)`);
            return saved;
        }
        if (saved && saved.status === "sent") {
            const receipt = await provider.waitForTransaction(saved.tx.hash, 1, 60000).catch(() => null);
            if (receipt) {
                finalize(saved, receipt);
                journal.put(saved);
                if (saved.status === "done") {
                    console.log(`  ✓ ${title}  (finished from its receipt)`);
                    return saved;
                }
            }
            console.log(`  ! ${title}: the earlier attempt did not land, running it again`);
        }
        console.log(`  → ${title}`);
        return run({ id, title });
    }

    // send a pool call; the step is saved before waiting, so a crash cannot lose it
    async function submitPoolTx(record, signer, method, args, overrides = {}) {
        const data = pool.interface.encodeFunctionData(method, args);
        const { tx, estimate, gasLimit } = await send(signer, { to: pool.address, data, ...overrides });
        record.status = "sent";
        record.tx = { method, from: labelOf(signer.address), hash: tx.hash, gasEstimate: estimate.toString(), gasLimit: gasLimit.toString() };
        journal.put(record);
        finalize(record, await confirm(tx.hash));
        journal.put(record);
        if (record.status !== "done") throw new Error(`${record.title}: reverted on-chain (${tx.hash})`);
        console.log(`      tx ${tx.hash}  gas ${record.tx.gasEstimate} (limit ${record.tx.gasLimit} charged: ${record.tx.costMON} MON)`);
        return record;
    }

    // ── note bookkeeping ────────────────────────────────────────────────────
    const noteInfo = (owner, note) => ({
        owner,
        token: symbolOf(note.token),
        amount: BigInt(note.amount).toString(),
        commitment: hex32(note.commitment)
    });
    const inputInfo = (owner, note) => ({
        ...noteInfo(owner, note),
        treeId: note.treeId,
        leafIndex: note.leafIndex,
        nullifier: hex32(note.nullifier),
        ...(note.fromSwap ? { fromSwap: true } : {})
    });

    // largest notes first, up to the 4 a proof can spend
    function pickNotes(walletView, symbol, needed, prefer) {
        let candidates = walletView.unspent.filter((n) => n.token === TOKENS[symbol].address);
        if (prefer) candidates = candidates.filter(prefer);
        candidates.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
        const picked = [];
        let total = 0n;
        for (const note of candidates) {
            if (total >= needed && picked.length) break;
            picked.push(note);
            total += note.amount;
        }
        if (total < needed) throw new Error(`${symbol}: unspent notes hold ${total}, need ${needed}`);
        if (picked.length > 4) throw new Error(`${symbol}: needs more than 4 notes`);
        return picked;
    }

    // the real inputs' nullifiers must be exactly what the wallet's own view computed
    function spendRecord(owner, notes, built) {
        notes.forEach((note, i) => {
            if (hex32(note.nullifier) !== hex32(built.nullifiers[i])) throw new Error("nullifier mismatch between scanner and builder");
        });
        return {
            root: built.call.root,
            extDataHash: hex32(built.extDataHash),
            inputs: notes.map((n) => inputInfo(owner, n)),
            dummyNullifiers: built.nullifiers.slice(notes.length).map(hex32)
        };
    }

    async function transferPart({ from, to, symbol, amount, fee, prefer }) {
        const notes = pickNotes(await view(from), symbol, amount + fee, prefer);
        const recipient = await W.resolveRecipient(pool, ids[to].address);
        const built = await buildTransfer({
            pool, chainId, mirror, sender: ids[from], notes, token: TOKENS[symbol].address,
            recipient, amount, relayer: relayerRecipient, fee
        });
        const part = {
            from,
            to,
            amount: show(symbol, amount),
            fee: show(symbol, fee),
            ...spendRecord(from, notes, built),
            outputs: [
                { role: "recipient", ...noteInfo(to, built.outputs[0]) },
                { role: "change", ...noteInfo(from, built.outputs[1]) },
                { role: "fee", ...noteInfo("relayer", built.outputs[2]) }
            ]
        };
        const flows = [
            { who: from, token: symbol, amount: (-(amount + fee)).toString() },
            { who: to, token: symbol, amount: amount.toString() },
            { who: "relayer", token: symbol, amount: fee.toString() }
        ];
        return { built, part, flows };
    }

    const privateTransfer = (id, title, spec) =>
        step(id, title, async (base) => {
            const { built, part, flows } = await transferPart(spec);
            return submitPoolTx({ ...base, kind: "transfer", ...part, flows }, deployer, "transfer", [[built.call]]);
        });

    const privateWithdraw = (id, title, { from, to, symbol, fee, unwrapNative = false, amount, prefer }) =>
        step(id, title, async (base) => {
            const walletView = await view(from);
            // amount = null: everything in the preferred note but the fee
            const notes = amount === null ? [walletView.unspent.find(prefer)] : pickNotes(walletView, symbol, amount + fee, prefer);
            if (!notes[0]) throw new Error(`${from} has no note to withdraw`);
            const value = amount === null ? notes[0].amount - fee : amount;
            const recipient = signers[to].address;
            const built = await buildWithdraw({
                pool, chainId, mirror, sender: ids[from], notes, token: TOKENS[symbol].address,
                amount: value, recipient, unwrapNative, relayer: relayerRecipient, fee
            });
            const publicBalance = () =>
                unwrapNative ? provider.getBalance(recipient) : erc20(symbol).balanceOf(recipient);
            const before = BigInt((await publicBalance()).toString());
            const record = {
                ...base,
                kind: "withdraw",
                from,
                to,
                amount: show(symbol, value),
                fee: show(symbol, fee),
                unwrapNative,
                ...spendRecord(from, notes, built),
                outputs: [
                    { role: "change", ...noteInfo(from, built.outputs[0]) },
                    { role: "fee", ...noteInfo("relayer", built.outputs[1]) }
                ],
                flows: [
                    { who: from, token: symbol, amount: (-(value + fee)).toString() },
                    { who: "relayer", token: symbol, amount: fee.toString() }
                ]
            };
            await submitPoolTx(record, deployer, "withdraw", [[built.call]]);
            const received = BigInt((await publicBalance()).toString()) - before;
            record.public = {
                recipient: to,
                asset: unwrapNative ? "MON (native)" : symbol,
                received: received.toString(),
                matches: received === value
            };
            journal.put(record);
            if (received !== value) throw new Error(`${to} received ${received}, expected ${value}`);
            return record;
        });

    const privateSwap = (id, title, { from, symbolIn, symbolOut, amountIn, fee, slippageBps = 100, prefer }) =>
        step(id, title, async (base) => {
            const tokenIn = TOKENS[symbolIn].address;
            const tokenOut = TOKENS[symbolOut].address;
            // the backend picks the route, the user never does
            const route = await findBestRoute({
                factory: venue.factory,
                quoter: venue.quoterV2,
                provider,
                tokenIn,
                tokenOut,
                amountIn,
                connectors: [TOKENS.WMON.address, TOKENS.mUSDC.address]
            });
            const minAmountOut = withSlippage(route.amountOut, slippageBps);
            const notes = pickNotes(await view(from), symbolIn, amountIn + fee, prefer);
            const { timestamp } = await provider.getBlock("latest");
            const built = await buildSwap({
                pool, chainId, mirror, sender: ids[from], notes, tokenIn, amountIn, tokenOut, minAmountOut,
                adapter, routeData: route.path, deadline: timestamp + 600, relayer: relayerRecipient, fee
            });
            const record = {
                ...base,
                kind: "swap",
                from,
                swap: {
                    owner: from,
                    tokenIn: symbolIn,
                    tokenOut: symbolOut,
                    amountIn: show(symbolIn, amountIn),
                    fee: show(symbolIn, fee),
                    route: route.tokens.map(symbolOf).join(" → "),
                    feeTiers: route.fees.map((f) => `${f / 10000}%`),
                    path: route.path,
                    quote: show(symbolOut, route.amountOut),
                    minAmountOut: show(symbolOut, minAmountOut),
                    slippage: `${slippageBps / 100}%`
                },
                ...spendRecord(from, notes, built),
                outputs: [
                    { role: "change", ...noteInfo(from, built.outputs[0]) },
                    { role: "fee", ...noteInfo("relayer", built.outputs[1]) }
                ],
                flows: [
                    { who: from, token: symbolIn, amount: (-(amountIn + fee)).toString() },
                    { who: "relayer", token: symbolIn, amount: fee.toString() }
                ]
            };
            return submitPoolTx(record, deployer, "swap", [[built.call]]);
        });

    const deposit = (id, title, { from, to, symbol, amount, native = false }) =>
        step(id, title, async (base) => {
            const token = TOKENS[symbol].address;
            const recipient = await W.resolveRecipient(pool, ids[to].address);
            const built = buildDeposit({ token, amount, recipient });
            const record = {
                ...base,
                kind: "deposit",
                from,
                to,
                amount: show(symbol, amount),
                native,
                deposit: { npk: built.npk, ciphertextBytes: (built.encryptedNote.length - 2) / 2 },
                outputs: [{ role: "deposit", ...noteInfo(to, built.note) }],
                flows: [{ who: to, token: symbol, amount: amount.toString() }]
            };
            if (native) {
                await waitForReserveWindow(signers[from].address);
                return submitPoolTx(record, signers[from], "depositNative", [built.npk, built.encryptedNote], { value: amount });
            }
            const approveData = erc20(symbol).interface.encodeFunctionData("approve", [pool.address, amount]);
            record.approveTx = await sendAndConfirm(signers[from], { to: token, data: approveData }, { buffer: false });
            return submitPoolTx(record, signers[from], "deposit", [token, amount, built.npk, built.encryptedNote]);
        });

    // ═════════════════════════════════════════════════════════════════════════
    //  1. setup and registration
    // ═════════════════════════════════════════════════════════════════════════
    console.log("setup");
    await step("fund", "fund the test wallets: MON for gas and native deposits, mUSDC to deposit", async (base) => {
        const txs = [];
        for (const [name, amount] of Object.entries(FUNDING)) {
            const target = ethers.utils.parseEther(amount);
            const balance = await provider.getBalance(signers[name].address);
            if (balance.gte(target)) continue;
            const tx = await sendAndConfirm(deployer, { to: signers[name].address, value: target.sub(balance) }, { buffer: false });
            txs.push({ what: `${name} +${ethers.utils.formatEther(target.sub(balance))} MON`, ...tx });
        }
        for (const [name, amount] of Object.entries(MUSDC_MINT)) {
            const target = units("mUSDC", amount);
            const balance = BigInt((await erc20("mUSDC").balanceOf(signers[name].address)).toString());
            if (balance >= target) continue;
            const data = erc20("mUSDC").interface.encodeFunctionData("mint", [signers[name].address, target - balance]);
            const tx = await sendAndConfirm(deployer, { to: TOKENS.mUSDC.address, data }, { buffer: false });
            txs.push({ what: `${name} +${show("mUSDC", target - balance)} (test token mint)`, ...tx });
        }
        const record = { ...base, kind: "setup", status: "done", txs };
        journal.put(record);
        return record;
    });

    for (const name of ["alice", "bob", "carol"]) {
        await step(`register-${name}`, `${name} registers: one signature, one transaction`, async (base) => {
            const record = {
                ...base,
                kind: "register",
                who: name,
                address: ids[name].address,
                userCommitment: ids[name].userCommitmentBytes32,
                viewingPublicKey: ids[name].viewing.ivkPub
            };
            return submitPoolTx(record, signers[name], "register", [ids[name].userCommitmentBytes32, ids[name].viewing.ivkPub]);
        });
    }

    await step("registry", "senders resolve recipients from the chain; dave stays unregistered", async (base) => {
        const resolved = {};
        for (const name of ["alice", "bob", "carol", "dave", "relayer"]) {
            const r = await W.resolveRecipient(pool, signers[name].address);
            resolved[name] = { registered: r.registered, userCommitment: r.registered ? hex32(r.userCommitment) : null, viewingEpoch: r.viewingEpoch };
        }
        for (const name of ["alice", "bob", "carol"]) {
            await W.assertRegisteredIdentity(pool, ids[name]);
        }
        if (resolved.dave.registered) throw new Error("dave should not be registered");
        const record = { ...base, kind: "check", status: "done", resolved, loginCheck: "re-derived identities match the chain" };
        journal.put(record);
        return record;
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  2. deposits
    // ═════════════════════════════════════════════════════════════════════════
    console.log("deposits");
    await deposit("deposit-alice-musdc", "alice deposits 300 mUSDC", { from: "alice", to: "alice", symbol: "mUSDC", amount: units("mUSDC", 300) });
    await deposit("deposit-alice-mon", "alice deposits 1 MON (wrapped to WMON inside the pool)", {
        from: "alice", to: "alice", symbol: "WMON", amount: units("WMON", 1), native: true
    });
    await deposit("deposit-bob-for-carol", "bob deposits 100 mUSDC straight into carol's private balance", {
        from: "bob", to: "carol", symbol: "mUSDC", amount: units("mUSDC", 100)
    });
    await deposit("deposit-bob-mon", "bob deposits 0.5 MON", { from: "bob", to: "bob", symbol: "WMON", amount: units("WMON", "0.5"), native: true });

    // ═════════════════════════════════════════════════════════════════════════
    //  3. private transfers (relayed)
    // ═════════════════════════════════════════════════════════════════════════
    console.log("private transfers");
    await privateTransfer("transfer-alice-bob", "alice → bob 120 mUSDC, privately", {
        from: "alice", to: "bob", symbol: "mUSDC", amount: units("mUSDC", 120), fee: units("mUSDC", "0.5")
    });
    await privateTransfer("transfer-carol-alice", "carol → alice 50 mUSDC (from the note bob deposited for her)", {
        from: "carol", to: "alice", symbol: "mUSDC", amount: units("mUSDC", 50), fee: units("mUSDC", "0.2")
    });
    await privateTransfer("transfer-alice-carol-wmon", "alice → carol 0.3 WMON", {
        from: "alice", to: "carol", symbol: "WMON", amount: units("WMON", "0.3"), fee: units("WMON", "0.01")
    });
    await privateTransfer("transfer-alice-bob-two-notes", "alice → bob 200 mUSDC, spending two notes in one proof", {
        from: "alice", to: "bob", symbol: "mUSDC", amount: units("mUSDC", 200), fee: units("mUSDC", "0.5")
    });
    await step("transfer-batch", "one relayer transaction, two private transfers: bob → carol 20 mUSDC, carol → bob 0.1 WMON", async (base) => {
        const a = await transferPart({ from: "bob", to: "carol", symbol: "mUSDC", amount: units("mUSDC", 20), fee: units("mUSDC", "0.1") });
        const b = await transferPart({ from: "carol", to: "bob", symbol: "WMON", amount: units("WMON", "0.1"), fee: units("WMON", "0.005") });
        const record = { ...base, kind: "transfer-batch", parts: [a.part, b.part], flows: [...a.flows, ...b.flows] };
        return submitPoolTx(record, deployer, "transfer", [[a.built.call, b.built.call]]);
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  4. withdrawals to a public address
    // ═════════════════════════════════════════════════════════════════════════
    console.log("withdrawals");
    await privateWithdraw("withdraw-bob-dave", "bob withdraws 100 mUSDC to dave (unregistered, public)", {
        from: "bob", to: "dave", symbol: "mUSDC", amount: units("mUSDC", 100), fee: units("mUSDC", "0.5")
    });
    await privateWithdraw("withdraw-alice-dave-native", "alice withdraws 0.2 MON to dave as native MON (unwrapped)", {
        from: "alice", to: "dave", symbol: "WMON", amount: units("WMON", "0.2"), fee: units("WMON", "0.01"), unwrapNative: true
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  5. private swaps on Uniswap V3
    // ═════════════════════════════════════════════════════════════════════════
    console.log("private swaps");
    await privateSwap("swap-bob-small", "bob swaps 0.01 WMON → mUSDC (a small trade: the backend compares both fee tiers)", {
        from: "bob", symbolIn: "WMON", symbolOut: "mUSDC", amountIn: units("WMON", "0.01"), fee: units("WMON", "0.0005")
    });
    await privateSwap("swap-alice-musdc-wmon", "alice swaps 5 mUSDC → WMON", {
        from: "alice", symbolIn: "mUSDC", symbolOut: "WMON", amountIn: units("mUSDC", 5), fee: units("mUSDC", "0.05")
    });
    await privateSwap("swap-bob-wmon-musdc", "bob swaps 0.2 WMON → mUSDC", {
        from: "bob", symbolIn: "WMON", symbolOut: "mUSDC", amountIn: units("WMON", "0.2"), fee: units("WMON", "0.005")
    });
    await privateSwap("swap-carol-two-hops", "carol swaps 0.1 WMON → mTKN (no direct pool: WMON → mUSDC → mTKN)", {
        from: "carol", symbolIn: "WMON", symbolOut: "mTKN", amountIn: units("WMON", "0.1"), fee: units("WMON", "0.002")
    });

    console.log("bought notes are ordinary notes");
    await privateTransfer("transfer-alice-bought-wmon", "alice → bob 0.4 WMON out of the WMON she bought", {
        from: "alice", to: "bob", symbol: "WMON", amount: units("WMON", "0.4"), fee: units("WMON", "0.005"), prefer: (n) => n.fromSwap
    });
    await privateWithdraw("withdraw-carol-mtkn", "carol withdraws all the mTKN she bought to dave", {
        from: "carol", to: "dave", symbol: "mTKN", amount: null, fee: units("mTKN", "0.01"),
        prefer: (n) => n.fromSwap && n.token === TOKENS.mTKN.address
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  6. viewing keys
    // ═════════════════════════════════════════════════════════════════════════
    console.log("viewing keys");
    const fingerprint = (encoded) => ethers.utils.id(encoded).slice(0, 18);
    const describeView = (seen) => ({
        notes: seen.notes.length,
        received: Object.fromEntries(Object.entries(seen.received).map(([t, a]) => [symbolOf(t), show(symbolOf(t), a)])),
        balances: seen.balances
            ? Object.fromEntries(Object.entries(seen.balances).map(([t, a]) => [symbolOf(t), show(symbolOf(t), a)]))
            : "not visible (no nullifier key)",
        outgoing: seen.outgoing.map((o) => ({
            action: actionName(o.action),
            token: symbolOf(o.token),
            amount: show(symbolOf(o.token), o.amount),
            fee: show(symbolOf(o.token), o.fee),
            to: o.action === ACTION.SWAP ? `swap into ${symbolOf(o.tokenOut)}` : labelOf(o.counterpartyAddress),
            epoch: o.epoch,
            txHash: o.txHash
        }))
    });
    const sameBalances = (a, b) => JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)) ===
        JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v));

    await step("viewing-keys", "alice shares a full, an incoming and an epoch viewing key; none can spend", async (base) => {
        const own = await view("alice");
        const { viewingEpoch } = await W.resolveRecipient(pool, ids.alice.address);
        const keys = {
            full: W.fullViewingKey(ids.alice),
            incoming: W.incomingViewingKey(ids.alice),
            epoch0: W.epochViewingKey(ids.alice, 0)
        };
        const results = {};
        for (const [kind, key] of Object.entries(keys)) {
            const encoded = W.encodeViewingKey(key);
            const decoded = W.decodeViewingKey(encoded);   // what the receiving side does
            const seen = scan(mirror, viewerFromViewingKey(decoded, viewingEpoch));
            const plain = JSON.stringify(decoded, (_, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase();
            const sk = ids.alice.spend.sk;
            results[kind] = {
                encodedLength: encoded.length,
                fingerprint: fingerprint(encoded),
                network: decoded.network,
                containsSpendingKey: plain.includes(sk.toString()) || plain.includes(sk.toString(16)),
                sees: describeView(seen),
                balanceMatchesWallet: seen.balances ? sameBalances(seen.balances, own.balances) : null
            };
        }
        if (!results.full.balanceMatchesWallet) throw new Error("the full viewing key does not show alice's real balance");
        if (Object.values(results).some((r) => r.containsSpendingKey)) throw new Error("a viewing key contains the spending key");

        // someone else's keys see none of alice's notes
        const bobSeesAlice = (await view("bob")).notes.filter((n) => own.notes.some((m) => m.commitment === n.commitment));
        const record = {
            ...base,
            kind: "viewing-keys",
            status: "done",
            wallet: describeView(own),
            keys: results,
            bobSeesAlicesNotes: bobSeesAlice.length
        };
        journal.put(record);
        return record;
    });

    await step("alice-new-viewing-key", "alice moves to viewing epoch 1 (same identity, new viewing key)", async (base) => {
        const next = W.withViewingEpoch(ids.alice, ids.alice.viewingEpoch + 1);
        const record = { ...base, kind: "viewing-epoch", who: "alice", epoch: next.viewingEpoch, viewingPublicKey: next.viewing.ivkPub };
        await submitPoolTx(record, signers.alice, "updateViewingKey", [next.viewing.ivkPub]);
        ids.alice = next;
        return record;
    });
    await refreshEpoch("alice");

    await privateTransfer("transfer-bob-alice-epoch1", "bob → alice 10 mUSDC, encrypted to alice's epoch-1 key", {
        from: "bob", to: "alice", symbol: "mUSDC", amount: units("mUSDC", 10), fee: units("mUSDC", "0.1")
    });

    await step("viewing-epochs", "an epoch key shows one period only", async (base) => {
        const own = await view("alice");
        const epochs = {};
        for (const epoch of [0, 1]) {
            const seen = scan(mirror, viewerFromViewingKey(W.decodeViewingKey(W.encodeViewingKey(W.epochViewingKey(ids.alice, epoch)))));
            epochs[`epoch${epoch}`] = describeView(seen);
        }
        const full = scan(mirror, viewerFromViewingKey(W.fullViewingKey(ids.alice), ids.alice.viewingEpoch));
        const epoch1Commitments = scan(mirror, viewerFromViewingKey(W.epochViewingKey(ids.alice, 1))).notes.map((n) => hex32(n.commitment));
        const epoch0Commitments = scan(mirror, viewerFromViewingKey(W.epochViewingKey(ids.alice, 0))).notes.map((n) => hex32(n.commitment));
        const overlap = epoch1Commitments.filter((c) => epoch0Commitments.includes(c));
        if (overlap.length) throw new Error("an epoch key saw another epoch's notes");
        if (!sameBalances(full.balances, own.balances)) throw new Error("the full viewing key lost track across epochs");
        const record = {
            ...base,
            kind: "viewing-epochs",
            status: "done",
            ...epochs,
            fullKeyAcrossEpochs: describeView(full),
            overlapBetweenEpochs: overlap.length
        };
        journal.put(record);
        return record;
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  7. attacks, simulated with eth_call (no gas spent)
    // ═════════════════════════════════════════════════════════════════════════
    console.log("attacks (eth_call only)");
    await step("attacks", "tampered, replayed, expired and unauthorized calls are refused", async (base) => {
        const checks = [];
        // raw eth_call: ethers v5's provider.call() hands revert data back as a
        // result instead of throwing
        const ethCall = (from, to, data) => provider.send("eth_call", [{ from, to, data }, "latest"]);
        const simulate = async (from, method, args, target = pool) => {
            try {
                await ethCall(from, target.address, target.interface.encodeFunctionData(method, args));
                return null;
            } catch (error) {
                return revertReason(error);
            }
        };
        const expectRefused = async (check, from, method, args) => {
            const reason = await simulate(from, method, args);
            checks.push({ check, refused: reason !== null, reason });
        };
        const clone = (call) => JSON.parse(JSON.stringify(call, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

        // a fresh withdrawal that is valid as built
        const bobView = await view("bob");
        const notes = pickNotes(bobView, "mUSDC", units("mUSDC", "1.1"));
        const fresh = await buildWithdraw({
            pool, chainId, mirror, sender: ids.bob, notes, token: TOKENS.mUSDC.address, amount: units("mUSDC", 1),
            recipient: signers.dave.address, relayer: relayerRecipient, fee: units("mUSDC", "0.1")
        });
        const valid = await simulate(deployer.address, "withdraw", [[fresh.call]]);
        checks.push({ check: "the untampered withdrawal (control)", refused: valid !== null, reason: valid, expected: "accepted" });

        const toStranger = clone(fresh.call);
        toStranger.ext.recipient = ethers.Wallet.createRandom().address;
        await expectRefused("relayer redirects the withdrawal to another address", deployer.address, "withdraw", [[toStranger]]);
        const bigger = clone(fresh.call);
        bigger.amount = (BigInt(bigger.amount) + 1n).toString();
        await expectRefused("relayer raises the withdrawal amount", deployer.address, "withdraw", [[bigger]]);
        const otherFee = clone(fresh.call);
        otherFee.relayer = ids.alice.userCommitmentBytes32;
        await expectRefused("someone else claims the relayer fee", deployer.address, "withdraw", [[otherFee]]);
        const otherRoot = clone(fresh.call);
        otherRoot.root = hex32(BigInt(ethers.utils.hexlify(ethers.utils.randomBytes(31))));
        await expectRefused("a root the pool never had", deployer.address, "withdraw", [[otherRoot]]);
        await expectRefused("the same spend twice in one transaction", deployer.address, "withdraw", [[fresh.call, fresh.call]]);

        // replay: the exact calldata of an executed transfer
        const executed = journal.get("transfer-alice-bob");
        const replay = await provider.getTransaction(executed.tx.hash);
        let replayReason = null;
        try {
            await ethCall(deployer.address, pool.address, replay.data);
        } catch (error) {
            replayReason = revertReason(error);
        }
        checks.push({ check: "replay of an executed private transfer", refused: replayReason !== null, reason: replayReason });

        // swaps: expired, and a minimum the market cannot meet
        const aliceView = await view("alice");
        const swapNotes = pickNotes(aliceView, "mUSDC", units("mUSDC", "1.01"));
        const route = await findBestRoute({
            factory: venue.factory, quoter: venue.quoterV2, provider,
            tokenIn: TOKENS.mUSDC.address, tokenOut: TOKENS.WMON.address, amountIn: units("mUSDC", 1)
        });
        const { timestamp } = await provider.getBlock("latest");
        const swapArgs = {
            pool, chainId, mirror, sender: ids.alice, notes: swapNotes, tokenIn: TOKENS.mUSDC.address, amountIn: units("mUSDC", 1),
            tokenOut: TOKENS.WMON.address, adapter, routeData: route.path, relayer: relayerRecipient, fee: units("mUSDC", "0.01")
        };
        const expired = await buildSwap({ ...swapArgs, minAmountOut: withSlippage(route.amountOut, 100), deadline: timestamp - 1 });
        await expectRefused("a swap executed after its deadline", deployer.address, "swap", [[expired.call]]);
        const greedy = await buildSwap({ ...swapArgs, minAmountOut: route.amountOut * 2n, deadline: timestamp + 600 });
        await expectRefused("a swap whose minimum output the market cannot meet", deployer.address, "swap", [[greedy.call]]);

        // admin and deposit rules
        await expectRefused("a non-owner accepts a new token", signers.alice.address, "configureToken", [signers.dave.address, true, 1]);
        await expectRefused("a non-owner upgrades the pool", signers.alice.address, "upgradeTo", [signers.dave.address]);
        const stray = buildDeposit({ token: signers.dave.address, amount: 1n, recipient: await W.resolveRecipient(pool, ids.alice.address) });
        await expectRefused("a deposit of a token the pool does not accept", signers.alice.address, "deposit", [signers.dave.address, 1, stray.npk, stray.encryptedNote]);

        // the wallet itself refuses a private transfer to an unregistered address
        let clientRefusal = null;
        try {
            await buildTransfer({
                pool, chainId, mirror, sender: ids.alice, notes: swapNotes, token: TOKENS.mUSDC.address,
                recipient: await W.resolveRecipient(pool, signers.dave.address), amount: 1n, relayer: relayerRecipient
            });
        } catch (error) {
            clientRefusal = error.message;
        }
        checks.push({ check: "a private transfer to an unregistered address (wallet side)", refused: clientRefusal !== null, reason: clientRefusal });

        const wrong = checks.filter((c) => (c.expected === "accepted" ? c.refused : !c.refused));
        const record = { ...base, kind: "attacks", status: wrong.length ? "failed" : "done", checks };
        journal.put(record);
        if (wrong.length) throw new Error(`unexpected outcome: ${wrong.map((c) => c.check).join("; ")}`);
        return record;
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  8. upgrade dry run against the live proxy
    // ═════════════════════════════════════════════════════════════════════════
    await step("upgrade-dry-run", "the live proxy accepts the current code as an upgrade (validated, nothing sent)", async (base) => {
        const libraries = { PoseidonT3: deployment.poseidonT3, PoseidonT5: deployment.poseidonT5 };
        const constructorArgs = [await pool.transferVerifier(), await pool.withdrawVerifier(), await pool.wrappedNative()];
        const factory = await hre.ethers.getContractFactory("NoidPool", { libraries });
        hre.upgrades.silenceWarnings();
        await hre.upgrades.validateUpgrade(pool.address, factory, { ...PROXY_OPTIONS, constructorArgs });
        const record = {
            ...base,
            kind: "upgrade",
            status: "done",
            proxy: pool.address,
            implementation: await hre.upgrades.erc1967.getImplementationAddress(pool.address),
            version: await pool.version(),
            owner: await pool.owner(),
            result: "upgrade-safe, storage layout compatible"
        };
        journal.put(record);
        return record;
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  9. the books must balance
    // ═════════════════════════════════════════════════════════════════════════
    console.log("final checks");
    const done = journal.data.steps.filter((s) => s.status === "done");
    const ledger = {};
    for (const s of done) {
        for (const flow of s.flows || []) {
            ledger[flow.who] = ledger[flow.who] || {};
            ledger[flow.who][flow.token] = (ledger[flow.who][flow.token] || 0n) + BigInt(flow.amount);
        }
    }

    const identities = {};
    const notesHeld = {};
    for (const name of IDENTITIES) {
        await refreshEpoch(name);
        const own = await view(name);
        const actual = {};
        for (const [token, amount] of Object.entries(own.balances)) {
            actual[symbolOf(token)] = amount;
            notesHeld[symbolOf(token)] = (notesHeld[symbolOf(token)] || 0n) + amount;
        }
        const expected = ledger[name] || {};
        const symbols = new Set([...Object.keys(actual), ...Object.keys(expected)]);
        const rows = {};
        let ok = true;
        for (const symbol of symbols) {
            const a = actual[symbol] || 0n;
            const e = expected[symbol] || 0n;
            if (a !== e) ok = false;
            rows[symbol] = { private: show(symbol, a), ledger: show(symbol, e), match: a === e };
        }
        identities[name] = { matchesLedger: ok, unspentNotes: own.unspent.length, balances: rows };
    }

    const holdings = {};
    for (const symbol of Object.keys(TOKENS)) {
        const held = BigInt((await erc20(symbol).balanceOf(pool.address)).toString());
        holdings[symbol] = {
            pool: show(symbol, held),
            sumOfUnspentNotes: show(symbol, notesHeld[symbol] || 0n),
            match: held === (notesHeld[symbol] || 0n)
        };
    }

    const dave = {
        MON: ethers.utils.formatEther(await provider.getBalance(signers.dave.address)),
        mUSDC: show("mUSDC", BigInt((await erc20("mUSDC").balanceOf(signers.dave.address)).toString())),
        mTKN: show("mTKN", BigInt((await erc20("mTKN").balanceOf(signers.dave.address)).toString())),
        registered: await pool.isRegistered(signers.dave.address)
    };

    const spends = done.filter((s) => s.inputs || s.parts);
    const calls = spends.reduce((n, s) => n + (s.parts ? s.parts.length : 1), 0);
    const [root, nextIndex] = await pool.treeInfo(0);
    const tree = {
        root,
        nextIndex: nextIndex.toNumber(),
        mirrorRoot: hex32(mirror.root(0)),
        nullifiersOnChain: mirror.nullifiers.size,
        nullifiersExpected: calls * 4,
        notesOnChain: mirror.notes.length
    };

    const costs = {};
    let totalCost = 0;
    for (const s of done) {
        const txs = [s.tx, s.approveTx, ...(s.txs || [])].filter((t) => t && t.costMON);
        for (const t of txs) {
            costs[s.kind] = (costs[s.kind] || 0) + Number(t.costMON);
            totalCost += Number(t.costMON);
        }
    }
    const gasByKind = {};
    // execution gas = eth_estimateGas (Monad receipts report gasUsed = the limit it charged)
    for (const s of done.filter((x) => x.tx && x.tx.gasEstimate)) {
        const key =
            s.kind === "transfer-batch" ? "transfer (2 calls)"
            : s.kind === "deposit" ? (s.native ? "deposit (native)" : "deposit (ERC-20)")
            : s.kind === "withdraw" ? (s.unwrapNative ? "withdraw (native)" : "withdraw (ERC-20)")
            : s.kind === "swap" ? (s.swap.feeTiers.length > 1 ? "swap (2 hops)" : "swap (1 hop)")
            : s.kind;
        gasByKind[key] = gasByKind[key] || [];
        gasByKind[key].push(Number(s.tx.gasEstimate));
    }
    const gasSummary = Object.fromEntries(
        Object.entries(gasByKind).map(([k, list]) => [k, { count: list.length, gasAvg: Math.round(list.reduce((a, b) => a + b, 0) / list.length) }])
    );

    const final = {
        id: "final",
        title: "the books balance",
        kind: "final",
        status: "done",
        identities,
        poolHoldings: holdings,
        dave,
        tree,
        gas: gasSummary,
        costMON: { ...Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, v.toFixed(6)])), total: totalCost.toFixed(6) }
    };
    journal.put(final);
    journal.data.finishedAt = new Date().toISOString();
    journal.save();

    const problems = [
        ...Object.entries(identities).filter(([, r]) => !r.matchesLedger).map(([n]) => `${n}'s private balance does not match the ledger`),
        ...Object.entries(holdings).filter(([, h]) => !h.match).map(([s]) => `the pool's ${s} differs from the sum of notes`),
        ...(tree.mirrorRoot !== root ? ["mirror root differs from the contract"] : []),
        ...(tree.nullifiersOnChain !== tree.nullifiersExpected ? ["nullifier count differs from the spends recorded"] : [])
    ];

    const reportFile = path.join(EVMS, "deployments", `${net.name}-e2e.txt`);
    fs.writeFileSync(reportFile, renderReport(journal.data, { show, symbolOf }));
    console.log(`\nwritten ${path.relative(process.cwd(), journal.file)} and ${path.relative(process.cwd(), reportFile)}`);
    for (const [name, r] of Object.entries(identities)) {
        console.log(`  ${name.padEnd(8)} ${r.matchesLedger ? "balance = ledger" : "MISMATCH"}  ${Object.entries(r.balances).map(([s, b]) => b.private).join(", ")}`);
    }
    console.log(`  pool holdings = sum of unspent notes: ${Object.values(holdings).every((h) => h.match)}`);
    console.log(`  total gas cost of this run: ${totalCost.toFixed(4)} MON`);
    if (problems.length) throw new Error(problems.join("; "));
    console.log("\nall checks passed");
}

// ─── the readable report ───────────────────────────────────────────────────

function renderReport(data, { show }) {
    const out = [];
    const line = (text = "") => out.push(text);
    const short = (hex) => (hex ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : "");
    const amount = (o) => show(o.token, o.amount);
    const leaf = (o) => (o.leafIndex === undefined ? "leaf ?" : `leaf ${String(o.leafIndex).padStart(3)}`);

    line(`Menoid v1-mainnet: end-to-end run on ${data.network} (chain ${data.chainId})`);
    line(`started ${data.startedAt}${data.finishedAt ? `, finished ${data.finishedAt}` : ""}`);
    line();
    line(`pool (proxy)      ${data.pool}`);
    line(`implementation    ${data.implementation}`);
    line(`swap adapter      ${data.adapter}`);
    line(`Uniswap V3        factory ${data.uniswapV3.factory}, SwapRouter02 ${data.uniswapV3.swapRouter02}, QuoterV2 ${data.uniswapV3.quoterV2}`);
    for (const [key, address] of Object.entries(data.uniswapV3.pools)) line(`                  ${key.padEnd(18)} ${address}`);
    line(`tokens            ${Object.entries(data.tokens).map(([s, a]) => `${s} ${a}`).join(", ")}`);
    line();
    line("participants (testnet keys)");
    for (const [name, p] of Object.entries(data.participants)) {
        line(`  ${name.padEnd(8)} ${p.address}  ${p.registers ? `user commitment ${p.userCommitment}` : "never registers (public address only)"}`);
    }

    data.steps.forEach((s, i) => {
        line();
        line(`${String(i + 1).padStart(2)}. ${s.title}  [${s.status}]`);
        if (s.tx && s.tx.hash) {
            line(`    tx ${s.tx.hash}  block ${s.tx.block}  gas ${s.tx.gasEstimate} (limit ${s.tx.gasLimit} charged: ${s.tx.costMON} MON)`);
        }
        if (s.approveTx) line(`    approve ${s.approveTx.hash}  gas ${s.approveTx.gasUsed}`);
        for (const t of s.txs || []) line(`    ${t.what}: ${t.hash}`);
        if (s.kind === "register") line(`    user commitment ${s.userCommitment}`);
        if (s.deposit) {
            line(`    npk ${s.deposit.npk}  ciphertext ${s.deposit.ciphertextBytes} bytes`);
            line(`    commitment computed on-chain ${s.deposit.onChainCommitment} (matches the wallet's: ${s.deposit.matchesClient})`);
        }
        if (s.swap) {
            line(`    route ${s.swap.route}  (${s.swap.feeTiers.join(", ")})  quote ${s.swap.quote}, minimum ${s.swap.minAmountOut}`);
            line(`    received ${s.swap.received}`);
        }
        const parts = s.parts || (s.inputs ? [s] : []);
        for (const part of parts) {
            if (s.parts) line(`    ${part.from} → ${part.to} ${part.amount} (fee ${part.fee})`);
            line(`    root ${part.root}`);
            for (const input of part.inputs) {
                line(`    spent    ${leaf(input)}  ${short(input.commitment)}  ${input.owner.padEnd(7)} ${amount(input)}${input.fromSwap ? " (bought in a swap)" : ""}`);
                line(`             nullifier ${input.nullifier}`);
            }
            line(`    dummy nullifiers ${part.dummyNullifiers.map(short).join(", ")}`);
            for (const o of part.outputs) {
                line(`    created  ${leaf(o)}  ${short(o.commitment)}  ${o.owner.padEnd(7)} ${amount(o)}  (${o.role})`);
            }
        }
        if (!parts.length) {
            for (const o of s.outputs || []) line(`    created  ${leaf(o)}  ${o.commitment}  ${o.owner} ${amount(o)}  (${o.role})`);
        }
        if (s.public) line(`    ${s.public.recipient} received ${s.public.asset === "MON (native)" ? `${Number(s.public.received) / 1e18} MON` : show(s.public.asset, s.public.received)} publicly`);
        if (s.kind === "check") {
            for (const [name, r] of Object.entries(s.resolved)) line(`    ${name.padEnd(8)} registered ${r.registered}`);
        }
        if (s.kind === "viewing-keys") {
            line(`    alice's own view: ${JSON.stringify(s.wallet.balances)}`);
            for (const [kind, r] of Object.entries(s.keys)) {
                line(`    ${kind.padEnd(9)} key (${r.encodedLength} chars, ${r.network}): ${r.sees.notes} notes, balances ${JSON.stringify(r.sees.balances)}, ${r.sees.outgoing.length} outgoing records, contains sk: ${r.containsSpendingKey}`);
            }
            for (const o of s.keys.full.sees.outgoing) line(`      outgoing: ${o.action} ${o.amount} → ${o.to} (fee ${o.fee})`);
            line(`    bob's keys see ${s.bobSeesAlicesNotes} of alice's notes`);
        }
        if (s.kind === "viewing-epochs") {
            line(`    epoch 0 key: ${s.epoch0.notes} notes, balances ${JSON.stringify(s.epoch0.balances)}`);
            line(`    epoch 1 key: ${s.epoch1.notes} notes, balances ${JSON.stringify(s.epoch1.balances)}`);
            line(`    full key, both epochs: balances ${JSON.stringify(s.fullKeyAcrossEpochs.balances)}; notes seen by both epoch keys: ${s.overlapBetweenEpochs}`);
        }
        if (s.kind === "attacks") {
            for (const c of s.checks) {
                const outcome = c.expected === "accepted" ? (c.refused ? "REFUSED!" : "accepted") : c.refused ? "refused " : "ACCEPTED";
                line(`    ${outcome}  ${c.check}${c.reason ? `: ${c.reason}` : ""}`);
            }
        }
        if (s.kind === "upgrade") line(`    ${s.result} (proxy ${s.proxy}, implementation ${s.implementation}, v${s.version})`);
        if (s.kind === "final") {
            for (const [name, r] of Object.entries(s.identities)) {
                line(`    ${name.padEnd(8)} ${r.matchesLedger ? "= ledger" : "≠ LEDGER"}  ${Object.entries(r.balances).map(([sym, b]) => b.private).join(", ")}`);
            }
            for (const [sym, h] of Object.entries(s.poolHoldings)) line(`    pool ${sym.padEnd(6)} ${h.pool}  = sum of unspent notes ${h.sumOfUnspentNotes}: ${h.match}`);
            line(`    dave (public): ${s.dave.MON} MON, ${s.dave.mUSDC}, ${s.dave.mTKN}; registered ${s.dave.registered}`);
            line(`    tree: ${s.tree.notesOnChain} notes, next index ${s.tree.nextIndex}, nullifiers ${s.tree.nullifiersOnChain} (expected ${s.tree.nullifiersExpected})`);
            for (const [kind, g] of Object.entries(s.gas)) line(`    gas ${kind.padEnd(20)} ${g.gasAvg}${g.count > 1 ? ` (average of ${g.count})` : ""}`);
            line(`    cost: ${JSON.stringify(s.costMON)}`);
        }
    });
    return out.join("\n") + "\n";
}

main()
    .then(async () => {
        await shutdownProver();
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(error);
        await shutdownProver();
        process.exit(1);
    });
