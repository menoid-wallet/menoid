/// Incremental Merkle Tree — caller-supplied roots (no on-chain Poseidon)
module noid::merkle_tree {

    use std::vector;

    const ROOT_HISTORY_SIZE: u64 = 100;
    const E_INVALID_ROOT: u64    = 2;
    const EMPTY_ROOT: u256 = 15019797232609675441998260052101280400536945603062888308240081994073687793470;

    public struct InsertResult has copy, drop, store {
        pool_idx: u64,
        leaf_idx: u64,
    }

    public fun insert_result_pool_idx(r: &InsertResult): u64 { r.pool_idx }
    public fun insert_result_leaf_idx(r: &InsertResult): u64 { r.leaf_idx }

    public struct Pool has store {
        root_history: vector<u256>,
        root_ptr:     u64,
        next_idx:     u64,
        current_root: u256,
    }

    public struct Forest has store {
        pools: vector<Pool>,
    }

    public fun create_forest(): Forest {
        let mut root_history = vector[];
        let mut i = 0u64;
        while (i < ROOT_HISTORY_SIZE) {
            vector::push_back(&mut root_history, EMPTY_ROOT);
            i = i + 1;
        };
        let pool = Pool {
            root_history,
            root_ptr:     0,
            next_idx:     0,
            current_root: EMPTY_ROOT,
        };
        let mut pools = vector[];
        vector::push_back(&mut pools, pool);
        Forest { pools }
    }

    public fun insert(forest: &mut Forest, _commitment: u256, new_root: u256): InsertResult {
        let pool_idx = vector::length(&forest.pools) - 1;
        let p        = vector::borrow_mut(&mut forest.pools, pool_idx);
        let leaf_idx = p.next_idx;
        p.current_root = new_root;
        p.next_idx     = leaf_idx + 1;
        *vector::borrow_mut(&mut p.root_history, p.root_ptr) = new_root;
        p.root_ptr = (p.root_ptr + 1) % ROOT_HISTORY_SIZE;
        InsertResult { pool_idx, leaf_idx }
    }

    public fun insert_batch(
        forest:      &mut Forest,
        commitments: vector<u256>,
        new_roots:   vector<u256>,
    ): vector<InsertResult> {
        let mut results = vector[];
        let mut i = 0u64;
        let len = vector::length(&commitments);
        while (i < len) {
            let c = *vector::borrow(&commitments, i);
            let r = *vector::borrow(&new_roots, i);
            vector::push_back(&mut results, insert(forest, c, r));
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
}
