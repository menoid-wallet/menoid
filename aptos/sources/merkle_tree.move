/// Incremental Merkle Tree — root computed by the `new_root` ZK circuit, verified
/// on-chain. Aptos has no native Poseidon, so the contract never hashes; it only
/// verifies a Groth16 proof (in pool.move) and stores the proven outputs.
///
/// To keep the proof's public-signal / IC-point count small (Aptos deserializes one
/// G1 point per signal in pure Move), the filled-subtrees array is committed as a
/// single Poseidon-fold HASH rather than 20 field elements. The pool binds each
/// proof to the live tree via this stored `subtrees_hash` + `next_idx` + commitment.
module noid::merkle_tree {

    use std::vector;

    const TREE_DEPTH:        u64 = 20;
    const MAX_LEAF:          u64 = 1048576; // 2^TREE_DEPTH
    const ROOT_HISTORY_SIZE: u64 = 100;

    const E_INVALID_ROOT: u64 = 2;
    const E_TREE_FULL:    u64 = 3;

    /// Root of an empty depth-20 tree (Z20) under circomlib Poseidon.
    const EMPTY_ROOT: u256 = 15019797232609675441998260052101280400536945603062888308240081994073687793470;
    /// Poseidon fold of the initial filled_subtrees (Z0..Z19) — matches new_root.circom.
    const INITIAL_SUBTREES_HASH: u256 = 18923760017949255023558646736314951518245537495032738639626585245273309960268;

    struct InsertResult has copy, drop, store {
        pool_idx: u64,
        leaf_idx: u64,
    }

    public fun insert_result_pool_idx(r: &InsertResult): u64 { r.pool_idx }
    public fun insert_result_leaf_idx(r: &InsertResult): u64 { r.leaf_idx }

    struct Pool has store {
        root_history:  vector<u256>,
        root_ptr:      u64,
        next_idx:      u64,
        current_root:  u256,
        /// Poseidon-fold hash of the current filled_subtrees (the relayer keeps the
        /// actual subtree values off-chain; the contract only needs this commitment).
        subtrees_hash: u256,
    }

    struct Forest has store {
        pools: vector<Pool>,
    }

    public fun create_forest(): Forest {
        let root_history = vector::empty<u256>();
        let i = 0u64;
        while (i < ROOT_HISTORY_SIZE) { vector::push_back(&mut root_history, EMPTY_ROOT); i = i + 1; };

        let pool = Pool {
            root_history,
            root_ptr:      0,
            next_idx:      0,
            current_root:  EMPTY_ROOT,
            subtrees_hash: INITIAL_SUBTREES_HASH,
        };
        let pools = vector::empty<Pool>();
        vector::push_back(&mut pools, pool);
        Forest { pools }
    }

    /// Store a verified insertion (new root + new subtrees-hash), proven by a
    /// `new_root` proof that pool.move has already checked against this pool.
    public fun insert(
        forest:            &mut Forest,
        new_root:          u256,
        new_subtrees_hash: u256,
    ): InsertResult {
        let pool_idx = vector::length(&forest.pools) - 1;
        let p        = vector::borrow_mut(&mut forest.pools, pool_idx);
        assert!(p.next_idx < MAX_LEAF, E_TREE_FULL);

        let leaf_idx      = p.next_idx;
        p.subtrees_hash   = new_subtrees_hash;
        p.current_root    = new_root;
        p.next_idx        = leaf_idx + 1;

        let ptr = p.root_ptr;
        *vector::borrow_mut(&mut p.root_history, ptr) = new_root;
        p.root_ptr = (ptr + 1) % ROOT_HISTORY_SIZE;

        InsertResult { pool_idx, leaf_idx }
    }

    /// Current subtrees-hash of the latest pool — pool.move feeds this in as the
    /// `oldSubtreesHash` public signal, binding the proof to live state.
    public fun current_subtrees_hash(forest: &Forest, pool_idx: u64): u256 {
        vector::borrow(&forest.pools, pool_idx).subtrees_hash
    }

    public fun is_valid_root(forest: &Forest, pool_idx: u64, root: u256): bool {
        assert!(pool_idx < vector::length(&forest.pools), E_INVALID_ROOT);
        let p = vector::borrow(&forest.pools, pool_idx);
        let i = 0u64;
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
