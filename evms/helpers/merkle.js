const { IncrementalMerkleTree } = require("@zk-kit/incremental-merkle-tree");

const { initCrypto, poseidonHash } = require("./poseidon");
const { TREE_DEPTH } = require("./constants");

/**
 * PoolMirror — a client's copy of the pool, rebuilt from public events.
 *
 * Every pool operation inserts one aligned chunk of 4 leaves, zero-padded
 * (see contracts/libraries/poolLib.sol). Leaves without a NoteCreated event
 * are zero, so the mirror lays every note at its emitted leafIndex, fills the
 * rest with zeros up to the tree's nextIndex, and gets the contract's root.
 *
 * sync() refuses to continue if a rebuilt root differs from the contract's:
 * a proof against a tree the chain never had would only fail on-chain.
 */
class PoolMirror {
    constructor(pool, { fromBlock = 0 } = {}) {
        this.pool = pool;
        this.fromBlock = fromBlock;
        this.trees = [];
        this.notes = [];                 // every NoteCreated, in chain order
        this.nullifiers = new Set();     // decimal strings
        this.outgoing = new Map();       // firstNullifier (decimal) -> { record, txHash }
        this.swapOutputs = new Map();    // bought note commitment (decimal) -> Swapped event fields
    }

    async sync() {
        await initCrypto();

        const [noteEvents, nullifierEvents, outgoingEvents, swapEvents] = await Promise.all([
            this.pool.queryFilter(this.pool.filters.NoteCreated(), this.fromBlock),
            this.pool.queryFilter(this.pool.filters.NullifierSpent(), this.fromBlock),
            this.pool.queryFilter(this.pool.filters.OutgoingRecord(), this.fromBlock),
            this.pool.queryFilter(this.pool.filters.Swapped(), this.fromBlock)
        ]);

        // a swap's bought note carries no amount in its ciphertext; it is here
        this.swapOutputs = new Map(
            swapEvents.map((ev) => [
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

        this.notes = noteEvents.map((ev) => ({
            treeId: ev.args.treeId.toNumber(),
            leafIndex: ev.args.leafIndex.toNumber(),
            commitment: BigInt(ev.args.commitment),
            encryptedNote: ev.args.encryptedNote,
            blockNumber: ev.blockNumber,
            txHash: ev.transactionHash
        }));

        this.nullifiers = new Set(nullifierEvents.map((ev) => BigInt(ev.args.nullifier).toString()));

        this.outgoing = new Map(
            outgoingEvents.map((ev) => [
                BigInt(ev.args.firstNullifier).toString(),
                { record: ev.args.record, txHash: ev.transactionHash }
            ])
        );

        const hash = (inputs) => poseidonHash(inputs);
        const treeCount = (await this.pool.treeCount()).toNumber();
        this.trees = [];

        for (let treeId = 0; treeId < treeCount; treeId++) {
            const [onChainRoot, nextIndex] = await this.pool.treeInfo(treeId);
            const leaves = new Array(nextIndex.toNumber()).fill(0n);
            for (const note of this.notes) {
                if (note.treeId === treeId) leaves[note.leafIndex] = note.commitment;
            }

            const tree = new IncrementalMerkleTree(hash, TREE_DEPTH, 0n, 2);
            for (const leaf of leaves) tree.insert(leaf);

            if (BigInt(tree.root) !== BigInt(onChainRoot)) {
                throw new Error(`tree ${treeId}: rebuilt root does not match the contract`);
            }
            this.trees.push(tree);
        }
        return this;
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
