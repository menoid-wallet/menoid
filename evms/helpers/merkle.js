const { IncrementalMerkleTree } = require("@zk-kit/incremental-merkle-tree");

const { initCrypto, poseidonHash } = require("./poseidon");
const { TREE_DEPTH, CHUNK_SIZE } = require("./constants");

const MIRRORED_EVENTS = new Set(["NoteCreated", "NullifierSpent", "OutgoingRecord", "Swapped"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toHex32 = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");

/**
 * PoolMirror — a client's copy of the pool, rebuilt from public events.
 *
 * Every pool operation inserts one aligned chunk of 4 leaves, zero-padded
 * (see contracts/libraries/poolLib.sol). Leaves without a NoteCreated event
 * are zero, so the mirror lays every note at its emitted leafIndex, pads each
 * chunk with zeros, and gets the contract's root.
 *
 * sync() reads only blocks it has not read yet, in windows of at most
 * maxBlockRange blocks (public RPCs cap eth_getLogs; Monad's at 100), and
 * retries a failed request with backoff.
 *
 * sync() refuses to continue if a rebuilt root is not one the contract has
 * had: a proof against a tree the chain never had would only fail on-chain.
 * If the chain is exactly where the mirror read up to, the root must be the
 * current one; if the chain has moved on since, it must still be in the
 * contract's recent-root history (which a proof may use anyway).
 */
class PoolMirror {
    /**
     * fromBlock      the pool's deploy block; nothing before it is read
     * maxBlockRange  most blocks per eth_getLogs request, 0 = no limit
     * retries        attempts per request, and re-reads when a rebuilt root
     *                is not (yet) known on-chain
     */
    constructor(pool, { fromBlock = 0, maxBlockRange = 0, retries = 5 } = {}) {
        this.pool = pool;
        this.fromBlock = fromBlock;
        this.maxBlockRange = maxBlockRange;
        this.retries = retries;
        this.syncedBlock = fromBlock - 1;  // every block up to here has been read
        this.events = new Map();           // "block:logIndex" -> event, so re-reading a block is harmless
        this.trees = [];
        this.notes = [];                   // every NoteCreated, in chain order
        this.nullifiers = new Set();       // decimal strings
        this.outgoing = new Map();         // firstNullifier (decimal) -> { record, txHash }
        this.swapOutputs = new Map();      // bought note commitment (decimal) -> Swapped event fields
    }

    async sync() {
        await initCrypto();

        for (let attempt = 0; ; attempt++) {
            await this._readNewBlocks();
            this._index();
            const problem = await this._buildTrees();
            if (!problem) return this;
            if (attempt >= this.retries) throw new Error(problem);

            // a node behind the head may have answered the newest blocks
            // incompletely: wait, then read the last window again
            await sleep(1000 * (attempt + 1));
            this.syncedBlock = Math.max(this.fromBlock - 1, this.syncedBlock - Math.max(this.maxBlockRange, 1));
        }
    }

    async _readNewBlocks() {
        const provider = this.pool.provider;
        const head = await this._retry(() => provider.getBlockNumber());
        const window = this.maxBlockRange > 0 ? this.maxBlockRange : Infinity;

        while (this.syncedBlock < head) {
            const fromBlock = this.syncedBlock + 1;
            const toBlock = Math.min(head, fromBlock + window - 1);
            const logs = await this._retry(() =>
                provider.getLogs({ address: this.pool.address, fromBlock, toBlock })
            );
            for (const log of logs) this._remember(log);
            this.syncedBlock = toBlock;
        }
    }

    _remember(log) {
        let parsed;
        try {
            parsed = this.pool.interface.parseLog(log);
        } catch (e) {
            return;   // not an event of this ABI
        }
        if (!MIRRORED_EVENTS.has(parsed.name)) return;
        this.events.set(`${log.blockNumber}:${log.logIndex}`, {
            name: parsed.name,
            args: parsed.args,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            transactionHash: log.transactionHash
        });
    }

    _index() {
        const events = [...this.events.values()].sort(
            (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
        );
        const named = (name) => events.filter((ev) => ev.name === name);

        // a swap's bought note carries no amount in its ciphertext; it is here
        this.swapOutputs = new Map(
            named("Swapped").map((ev) => [
                BigInt(ev.args.commitment).toString(),
                {
                    tokenIn: ev.args.tokenIn,
                    tokenOut: ev.args.tokenOut,
                    amountIn: BigInt(ev.args.amountIn.toString()),
                    amountOut: BigInt(ev.args.amountOut.toString()),
                    adapter: ev.args.adapter,
                    txHash: ev.transactionHash
                }
            ])
        );

        this.notes = named("NoteCreated").map((ev) => ({
            treeId: ev.args.treeId.toNumber(),
            leafIndex: ev.args.leafIndex.toNumber(),
            commitment: BigInt(ev.args.commitment),
            encryptedNote: ev.args.encryptedNote,
            blockNumber: ev.blockNumber,
            txHash: ev.transactionHash
        }));

        this.nullifiers = new Set(named("NullifierSpent").map((ev) => BigInt(ev.args.nullifier).toString()));

        this.outgoing = new Map(
            named("OutgoingRecord").map((ev) => [
                BigInt(ev.args.firstNullifier).toString(),
                { record: ev.args.record, txHash: ev.transactionHash }
            ])
        );
    }

    // null when every rebuilt root is one the contract has had, else what is wrong
    async _buildTrees() {
        const hash = (inputs) => poseidonHash(inputs);
        const treeCount = (await this._retry(() => this.pool.treeCount())).toNumber();
        const trees = [];

        for (let treeId = 0; treeId < treeCount; treeId++) {
            const notes = this.notes.filter((note) => note.treeId === treeId);
            const size = notes.reduce(
                (end, note) => Math.max(end, (Math.floor(note.leafIndex / CHUNK_SIZE) + 1) * CHUNK_SIZE),
                0
            );
            const leaves = new Array(size).fill(0n);
            for (const note of notes) leaves[note.leafIndex] = note.commitment;

            const tree = new IncrementalMerkleTree(hash, TREE_DEPTH, 0n, 2);
            for (const leaf of leaves) tree.insert(leaf);
            trees.push(tree);

            const [onChainRoot, nextIndex] = await this._retry(() => this.pool.treeInfo(treeId));
            const onChainSize = nextIndex.toNumber();
            if (onChainSize === size) {
                if (BigInt(tree.root) !== BigInt(onChainRoot)) {
                    return `tree ${treeId}: rebuilt root does not match the contract`;
                }
            } else if (onChainSize > size) {
                // the chain moved on after the last block read
                const known = await this._retry(() => this.pool.isKnownRoot(treeId, toHex32(tree.root)));
                if (!known) return `tree ${treeId}: rebuilt root is not one the contract has had`;
            } else {
                return `tree ${treeId}: the mirror has more leaves than the contract`;
            }
        }

        this.trees = trees;
        return null;
    }

    async _retry(request) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await request();
            } catch (error) {
                if (attempt >= this.retries) throw error;
                await sleep(500 * 2 ** attempt);   // 0.5 s, 1 s, 2 s, ...
            }
        }
    }

    latestTreeId() {
        return this.trees.length - 1;
    }

    root(treeId) {
        return BigInt(this.trees[treeId].root);
    }

    merkleProof(treeId, leafIndex) {
        const proof = this.trees[treeId].createProof(leafIndex);
        return {
            root: BigInt(proof.root),
            leaf: BigInt(proof.leaf),
            pathElements: proof.siblings.map((s) => BigInt(s[0])),
            pathIndices: proof.pathIndices
        };
    }

    isSpent(nullifier) {
        return this.nullifiers.has(BigInt(nullifier).toString());
    }
}

module.exports = { PoolMirror };
