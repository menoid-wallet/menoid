/// Incremental Merkle Tree — on-chain Poseidon root computation (filled subtrees).
///
/// Ported from the Ethereum poolLib.sol. Each insert walks all TREE_DEPTH levels,
/// hashing with the native Sui Poseidon (noid::poseidon::merkle_node →
/// sui::poseidon::poseidon_bn254), so the contract derives the new root itself.
/// No caller-supplied roots: security comes from on-chain recomputation, not trust.
module noid::merkle_tree {

    use std::vector;
    use noid::poseidon;

    const TREE_DEPTH:        u64 = 20;
    const MAX_LEAF:          u64 = 1048576; // 2^TREE_DEPTH
    const ROOT_HISTORY_SIZE: u64 = 100;

    const E_INVALID_ROOT:      u64 = 2;
    const E_TREE_FULL:         u64 = 3;
    const E_POSEIDON_MISMATCH: u64 = 4;

    /// Root of an empty depth-20 tree (Z20) under circomlib Poseidon with zero leaves.
    /// Used as a fail-fast self-check that the native Poseidon matches the off-chain hash.
    const EMPTY_ROOT: u256 = 15019797232609675441998260052101280400536945603062888308240081994073687793470;

    public struct InsertResult has copy, drop, store {
        pool_idx: u64,
        leaf_idx: u64,
    }

    public fun insert_result_pool_idx(r: &InsertResult): u64 { r.pool_idx }
    public fun insert_result_leaf_idx(r: &InsertResult): u64 { r.leaf_idx }

    public struct Pool has store {
        root_history:    vector<u256>,
        root_ptr:        u64,
        next_idx:        u64,
        current_root:    u256,
        /// Latest completed left-subtree hash at each level (incremental tree cache).
        filled_subtrees: vector<u256>,
        /// Zero-subtree hash at each level (Z0..Z19), seeded once at creation.
        zeros:           vector<u256>,
    }

    public struct Forest has store {
        pools: vector<Pool>,
    }

    public fun create_forest(): Forest {
        // Build the zero-subtree hashes and seed the filled subtrees, exactly like
        // poolLib.createPool on Ethereum:
        //   zeros[0] = 0, zeros[i] = Poseidon(zeros[i-1], zeros[i-1]), empty root = Z20.
        let mut zeros           = vector[];
        let mut filled_subtrees = vector[];
        let mut zero = 0u256;
        let mut i = 0u64;
        while (i < TREE_DEPTH) {
            vector::push_back(&mut zeros, zero);
            vector::push_back(&mut filled_subtrees, zero);
            zero = poseidon::merkle_node(zero, zero);
            i = i + 1;
        };
        let empty_root = zero; // Z20

        // Fail fast if the native Poseidon disagrees with the expected off-chain root.
        assert!(empty_root == EMPTY_ROOT, E_POSEIDON_MISMATCH);

        let mut root_history = vector[];
        let mut k = 0u64;
        while (k < ROOT_HISTORY_SIZE) {
            vector::push_back(&mut root_history, empty_root);
            k = k + 1;
        };

        let pool = Pool {
            root_history,
            root_ptr:        0,
            next_idx:        0,
            current_root:    empty_root,
            filled_subtrees,
            zeros,
        };
        let mut pools = vector[];
        vector::push_back(&mut pools, pool);
        Forest { pools }
    }

    /// Insert a single leaf, recompute `current_root` on-chain via the incremental
    /// filled-subtree algorithm (the exact port of poolLib.updatePool), and append
    /// the new root to the circular history. No caller-supplied root.
    public fun insert(forest: &mut Forest, commitment: u256): InsertResult {
        let pool_idx = vector::length(&forest.pools) - 1;
        let p        = vector::borrow_mut(&mut forest.pools, pool_idx);
        assert!(p.next_idx < MAX_LEAF, E_TREE_FULL);
        let leaf_idx = p.next_idx;

        let mut current = commitment;
        let mut idx     = leaf_idx;
        let mut i       = 0u64;
        while (i < TREE_DEPTH) {
            if (idx % 2 == 0) {
                // Even index: `current` becomes the left child waiting for a right sibling.
                *vector::borrow_mut(&mut p.filled_subtrees, i) = current;
                let z = *vector::borrow(&p.zeros, i);
                current = poseidon::merkle_node(current, z);
            } else {
                // Odd index: the stored left subtree is the sibling.
                let left = *vector::borrow(&p.filled_subtrees, i);
                current = poseidon::merkle_node(left, current);
            };
            idx = idx / 2;
            i = i + 1;
        };

        p.current_root = current;
        p.next_idx     = leaf_idx + 1;
        let ptr = p.root_ptr;
        *vector::borrow_mut(&mut p.root_history, ptr) = current;
        p.root_ptr = (ptr + 1) % ROOT_HISTORY_SIZE;

        InsertResult { pool_idx, leaf_idx }
    }

    /// Insert a batch of commitments in order, each recomputing the root on-chain.
    public fun insert_batch(
        forest:      &mut Forest,
        commitments: vector<u256>,
    ): vector<InsertResult> {
        let mut results = vector[];
        let mut i = 0u64;
        let len = vector::length(&commitments);
        while (i < len) {
            let c = *vector::borrow(&commitments, i);
            vector::push_back(&mut results, insert(forest, c));
            i = i + 1;
        };
        results
    }

    public fun is_valid_root(forest: &Forest, pool_idx: u64, root: u256): bool {
        assert!(pool_idx < vector::length(&forest.pools), E_INVALID_ROOT);
        let p = vector::borrow(&forest.pools, pool_idx);
        let mut i = 0u64;
        while (i < ROOT_HISTORY_SIZE) {
            if (*vector::borrow(&p.root_history, i) == root) return true;
            i = i + 1;
        };
        false
    }

    public fun current_root(forest: &Forest, pool_idx: u64): u256 {
        vector::borrow(&forest.pools, pool_idx).current_root
    }

    public fun pool_count(forest: &Forest): u64 { vector::length(&forest.pools) }

    public fun next_index(forest: &Forest, pool_idx: u64): u64 {
        vector::borrow(&forest.pools, pool_idx).next_idx
    }

    // ─── Tests ────────────────────────────────────────────────────────────────
    // Validates that the on-chain filled-subtree root computation (native Poseidon)
    // matches the off-chain circomlibjs + @zk-kit IncrementalMerkleTree, depth 20.

    #[test_only]
    fun destroy_forest(forest: Forest) {
        let Forest { pools } = forest;
        let mut pools = pools;
        while (!vector::is_empty(&pools)) {
            let Pool {
                root_history: _,
                root_ptr: _,
                next_idx: _,
                current_root: _,
                filled_subtrees: _,
                zeros: _,
            } = vector::pop_back(&mut pools);
        };
        vector::destroy_empty(pools);
    }

    #[test]
    fun test_onchain_root_matches_offchain() {
        let mut forest = create_forest();

        // Empty tree root == Z20 (create_forest also asserts this internally).
        assert!(current_root(&forest, 0) == EMPTY_ROOT, 100);
        assert!(is_valid_root(&forest, 0, EMPTY_ROOT), 101);

        // insert(123) → root from @zk-kit depth-20 tree.
        insert(&mut forest, 123u256);
        assert!(
            current_root(&forest, 0)
                == 15544942873243012709540684980060519338171669902328326108400346498057157852487u256,
            102,
        );
        assert!(is_valid_root(&forest, 0, current_root(&forest, 0)), 103);

        // insert(456)
        insert(&mut forest, 456u256);
        assert!(
            current_root(&forest, 0)
                == 17591479434631633877456397574407363199312886314211675675885385800252847718169u256,
            104,
        );

        // insert(789)
        insert(&mut forest, 789u256);
        assert!(
            current_root(&forest, 0)
                == 21492534240968515056793041621695752946395192975720342938641755154534410617714u256,
            105,
        );

        assert!(next_index(&forest, 0) == 3, 106);

        destroy_forest(forest);
    }
}
