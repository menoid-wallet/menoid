/// NoidPool — on-chain root verified via the `new_root` ZK proof.
///
/// Aptos has no native Poseidon, so the contract cannot recompute the Merkle root
/// itself. Instead, for every output commitment the caller attaches a `new_root`
/// Groth16 proof. The contract builds that proof's public signals from its OWN
/// stored state — `oldSubtrees` (current filled_subtrees), `commitment`, and
/// `leafIndex` (next_idx) — so the proof is bound to the live tree and cannot be
/// forged or replayed. The proven `newRoot` + `newSubtrees` are then stored.
///
/// Permissionless: anyone can call deposit/transfer/withdraw directly. The
/// `relayer` module is only a convenience task-queue; the system works without it.
/// `relayer_commitment` is unrelated — it's the ZK fee-note key bound inside the
/// deposit/transfer/withdraw circuits.
module noid::pool {

    use std::vector;
    use std::error;
    use std::signer;
    use aptos_framework::coin::{Self, Coin};
    use aptos_framework::aptos_coin::AptosCoin;
    use aptos_framework::aptos_account;
    use aptos_framework::event;
    use aptos_framework::table::{Self, Table};
    use aptos_framework::account::{Self, SignerCapability};
    use noid::poseidon;
    use noid::merkle_tree::{Self, Forest};
    use noid::verifier;

    // ── Constants ─────────────────────────────────────────────────────────────

    const ZERO_COMMITMENT: u256 = 0u256;
    const MAX_INPUTS: u64       = 4;
    const TREE_DEPTH: u64       = 20;
    const BN254_P: u256 = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ── Error codes ───────────────────────────────────────────────────────────

    const E_ALREADY_INITIALIZED: u64  = 1;
    const E_NOT_INITIALIZED: u64      = 2;
    const E_ZERO_AMOUNT: u64          = 3;
    const E_INVALID_COMMITMENT: u64   = 4;
    const E_COMMITMENT_EXISTS: u64    = 5;
    const E_NULLIFIER_SPENT: u64      = 6;
    const E_INVALID_ROOT: u64         = 7;
    const E_INVALID_POOL_ID: u64      = 8;
    const E_DUPLICATE_NULLIFIER: u64  = 9;
    const E_NO_OUTPUTS: u64           = 10;
    const E_PROOF_FAILED: u64         = 11;
    const E_WITHDRAW_FAILED: u64      = 12;
    const E_DUPLICATE_COMMITMENT: u64 = 13;
    const E_INSUFFICIENT_BALANCE: u64 = 14;
    const E_PENDING_TASKS: u64        = 15;
    const E_NO_PENDING_TASKS: u64     = 16;
    const E_COMMITMENT_MISMATCH: u64  = 17;
    const E_BAD_INPUT_LEN: u64        = 20;
    const E_NOT_RELAYER: u64          = 21;
    const E_BAD_PROOF_COUNT: u64      = 22;
    const E_AMOUNT_MISMATCH: u64      = 23;
    const E_ALREADY_REGISTERED: u64   = 24;
    const E_INVALID_USER_COMMITMENT: u64 = 25;

    // ── Events ────────────────────────────────────────────────────────────────

    #[event]
    struct NoteCreatedEvent has drop, store {
        pool_id:        u64,
        commitment:     u256,
        encrypted_note: vector<u8>,
    }

    #[event]
    struct NullifierSpentEvent has drop, store {
        nullifier: u256,
    }

    #[event]
    struct WalletRegisteredEvent has drop, store {
        wallet:          address,
        user_commitment: u256,
    }

    struct PendingCommitment has store, drop, copy {
        commitment:     u256,
        encrypted_note: vector<u8>,
    }

    // ── State ─────────────────────────────────────────────────────────────────

    struct PoolState has key {
        forest:              Forest,
        nullifiers:          Table<u256, bool>,
        commitments:         Table<u256, bool>,
        locked_balance:      u64,
        relayer_commitment:   u256,
        relayer_address:     address, // retained for set_relayer; no longer gates access
        admin:               address,
        pool_signer_cap:     SignerCapability,
        pool_resource_addr:  address,
        pending_commitments: vector<PendingCommitment>,
        // wallet address => user commitment
        // user_commitment = Poseidon(address mod p, spendPk.x, spendPk.y)
        registered:          Table<address, u256>,
    }

    // ── Initialization ────────────────────────────────────────────────────────

    public entry fun initialize(
        admin:             &signer,
        relayer_commitment: u256,
        relayer_address:   address,
        seed:              vector<u8>,
    ) {
        let admin_addr = signer::address_of(admin);
        assert!(!exists<PoolState>(admin_addr), error::already_exists(E_ALREADY_INITIALIZED));

        let (pool_signer, pool_signer_cap) =
            account::create_resource_account(admin, seed);
        let pool_resource_addr = signer::address_of(&pool_signer);

        if (!coin::is_account_registered<AptosCoin>(pool_resource_addr)) {
            coin::register<AptosCoin>(&pool_signer);
        };

        let forest = merkle_tree::create_forest();

        move_to(admin, PoolState {
            forest,
            nullifiers:         table::new<u256, bool>(),
            commitments:        table::new<u256, bool>(),
            locked_balance:     0,
            relayer_commitment,
            relayer_address,
            admin:              admin_addr,
            pool_signer_cap,
            pool_resource_addr,
            pending_commitments: vector::empty<PendingCommitment>(),
            registered:          table::new<address, u256>(),
        });
    }

    public entry fun set_relayer(
        admin: &signer, pool_addr: address,
        relayer_commitment: u256, relayer_address: address,
    ) acquires PoolState {
        let state = borrow_global_mut<PoolState>(pool_addr);
        assert!(
            state.admin == signer::address_of(admin),
            error::permission_denied(E_NOT_RELAYER)
        );
        state.relayer_commitment = relayer_commitment;
        state.relayer_address   = relayer_address;
    }

    // ── new_root proof: verify against live state, then store ───────────────────
    //
    // Builds the public-signal vector EXACTLY as the new_root circuit emits it:
    //   [ newRoot, newSubtrees[0..19], oldSubtrees[0..19], commitment, leafIndex ]
    // where oldSubtrees and leafIndex are taken from the CONTRACT's current state,
    // so the proof can only verify if it was computed for this exact insertion.

    fun insert_with_proof(
        state:             &mut PoolState,
        pool_addr:         address,
        commitment:        u256,
        nr_a:              vector<u8>,
        nr_b:              vector<u8>,
        nr_c:              vector<u8>,
        new_root:          u256,
        new_subtrees_hash: u256,
    ) {
        let old_subtrees_hash = merkle_tree::current_subtrees_hash(&state.forest, 0);
        let leaf_index        = merkle_tree::next_index(&state.forest, 0);

        // public signals: [ newRoot, newSubtreesHash, oldSubtreesHash, commitment, leafIndex ]
        let sigs = vector::empty<u256>();
        vector::push_back(&mut sigs, new_root);
        vector::push_back(&mut sigs, new_subtrees_hash);
        vector::push_back(&mut sigs, old_subtrees_hash);
        vector::push_back(&mut sigs, commitment);
        vector::push_back(&mut sigs, (leaf_index as u256));

        assert!(
            verifier::verify_new_root(pool_addr, &nr_a, &nr_b, &nr_c, &sigs),
            error::invalid_argument(E_PROOF_FAILED)
        );

        merkle_tree::insert(&mut state.forest, new_root, new_subtrees_hash);
    }

    // ── REGISTER ──────────────────────────────────────────────────────────────
    //
    // One-time binding of a real wallet address to its user commitment.
    //
    // Wallet responsibilities (off-chain):
    //   - Sign the message "menoid_Wallet" with the real wallet's private key
    //   - Derive the BabyJubJub spending keypair from that signature
    //   - user_commitment = Poseidon(address mod p, spendPk.x, spendPk.y)

    public entry fun register(
        user:            &signer,
        pool_addr:       address,
        user_commitment: u256,
    ) acquires PoolState {
        assert!(user_commitment != 0u256, error::invalid_argument(E_INVALID_USER_COMMITMENT));

        let user_addr = signer::address_of(user);
        let state = borrow_global_mut<PoolState>(pool_addr);
        assert!(
            !table::contains(&state.registered, user_addr),
            error::already_exists(E_ALREADY_REGISTERED)
        );

        table::add(&mut state.registered, user_addr, user_commitment);
        event::emit(WalletRegisteredEvent { wallet: user_addr, user_commitment });
    }

    #[view]
    public fun is_registered(pool_addr: address, wallet: address): bool acquires PoolState {
        table::contains(&borrow_global<PoolState>(pool_addr).registered, wallet)
    }

    #[view]
    public fun registered_commitment(pool_addr: address, wallet: address): u256 acquires PoolState {
        *table::borrow(&borrow_global<PoolState>(pool_addr).registered, wallet)
    }

    // ── DEPOSIT ───────────────────────────────────────────────────────────────
    //
    // Permissionless. Two entry points:
    //   • deposit()            — caller funds the deposit from their own account.
    //   • deposit_with_coin()  — a Coin is supplied directly (used by the relayer
    //                            module, which escrowed it from the user).

    public entry fun deposit(
        caller:          &signer,
        pool_addr:       address,
        a_bytes:         vector<u8>,
        b_bytes:         vector<u8>,
        c_bytes:         vector<u8>,
        c1:              u256,
        c2:              u256,
        amount:          u64,
        encrypted_note1: vector<u8>,
        encrypted_note2: vector<u8>,
    ) acquires PoolState {
        let coin = coin::withdraw<AptosCoin>(caller, amount);
        deposit_with_coin(
            pool_addr, coin, a_bytes, b_bytes, c_bytes, c1, c2, amount,
            encrypted_note1, encrypted_note2,
        );
    }

    public fun deposit_with_coin(
        pool_addr:       address,
        coin:            Coin<AptosCoin>,
        a_bytes:         vector<u8>,
        b_bytes:         vector<u8>,
        c_bytes:         vector<u8>,
        c1:              u256,
        c2:              u256,
        amount:          u64,
        encrypted_note1: vector<u8>,
        encrypted_note2: vector<u8>,
    ) acquires PoolState {
        assert!(amount > 0, error::invalid_argument(E_ZERO_AMOUNT));
        assert!(c1 != ZERO_COMMITMENT, error::invalid_argument(E_INVALID_COMMITMENT));
        assert!(coin::value(&coin) == amount, error::invalid_argument(E_AMOUNT_MISMATCH));

        // C2 is the optional relayer fee note - it may be zero
        let c2_enabled: u256 = if (c2 != ZERO_COMMITMENT) { 1u256 } else { 0u256 };
        if (c2_enabled == 1u256) {
            assert!(c1 != c2, error::invalid_argument(E_DUPLICATE_COMMITMENT));
        };

        let state = borrow_global_mut<PoolState>(pool_addr);
        assert!(vector::is_empty(&state.pending_commitments), error::invalid_state(E_PENDING_TASKS));
        assert!(!table::contains(&state.commitments, c1), error::already_exists(E_COMMITMENT_EXISTS));
        if (c2_enabled == 1u256) {
            assert!(!table::contains(&state.commitments, c2), error::already_exists(E_COMMITMENT_EXISTS));
        };

        // Deposit ZK proof: amount == sum of committed values, fee note bound to
        // the relayer's user commitment.
        // public signals: [amount, c1, c2, c2_enabled, relayer_commitment]
        let dsigs = vector::empty<u256>();
        vector::push_back(&mut dsigs, (amount as u256));
        vector::push_back(&mut dsigs, c1);
        vector::push_back(&mut dsigs, c2);
        vector::push_back(&mut dsigs, c2_enabled);
        vector::push_back(&mut dsigs, state.relayer_commitment);
        assert!(
            verifier::verify_deposit(pool_addr, &a_bytes, &b_bytes, &c_bytes, &dsigs),
            error::invalid_argument(E_PROOF_FAILED)
        );

        // Move the supplied coin into the pool's resource account.
        coin::deposit<AptosCoin>(state.pool_resource_addr, coin);
        state.locked_balance = state.locked_balance + amount;

        // Push commitments to the pending queue instead of inserting immediately.
        vector::push_back(&mut state.pending_commitments, PendingCommitment { commitment: c1, encrypted_note: encrypted_note1 });
        if (c2_enabled == 1u256) {
            vector::push_back(&mut state.pending_commitments, PendingCommitment { commitment: c2, encrypted_note: encrypted_note2 });
        };
    }

    // ── TRANSFER ──────────────────────────────────────────────────────────────
    // Permissionless. One new_root proof per ENABLED output, in c_outs order.

    public entry fun transfer(
        _caller:         &signer,
        pool_addr:       address,
        a_bytes:         vector<u8>,
        b_bytes:         vector<u8>,
        c_bytes:         vector<u8>,
        enabled:         vector<u8>,
        pool_ids:        vector<u64>,
        roots:           vector<u256>,
        nullifiers:      vector<u256>,
        output_enabled:  vector<u8>,
        c_outs:          vector<u256>,
        encrypted_note1: vector<u8>,
        encrypted_note2: vector<u8>,
        encrypted_note3: vector<u8>,
    ) acquires PoolState {
        assert!(
            vector::length(&enabled)    == MAX_INPUTS &&
            vector::length(&pool_ids)   == MAX_INPUTS &&
            vector::length(&roots)      == MAX_INPUTS &&
            vector::length(&nullifiers) == MAX_INPUTS,
            error::invalid_argument(E_BAD_INPUT_LEN)
        );
        assert!(
            vector::length(&output_enabled) == 3 && vector::length(&c_outs) == 3,
            error::invalid_argument(E_BAD_INPUT_LEN)
        );

        let state = borrow_global_mut<PoolState>(pool_addr);
        assert!(vector::is_empty(&state.pending_commitments), error::invalid_state(E_PENDING_TASKS));
        verify_inputs(state, &enabled, &pool_ids, &roots, &nullifiers);

        // Transfer ZK proof public signals (19).
        let sigs = vector::empty<u256>();
        vector::push_back(&mut sigs, state.relayer_commitment);
        pack_enabled(&mut sigs, &enabled);
        pack_u256_vec(&mut sigs, &roots);
        pack_u256_vec(&mut sigs, &nullifiers);
        pack_enabled_3(&mut sigs, &output_enabled);
        pack_u256_vec(&mut sigs, &c_outs);
        assert!(
            verifier::verify_transfer(pool_addr, &a_bytes, &b_bytes, &c_bytes, &sigs),
            error::invalid_argument(E_PROOF_FAILED)
        );

        spend_nullifiers(state, &enabled, &nullifiers);

        // Push each enabled output to pending_commitments queue instead of inserting immediately.
        let k = 0u64;
        let j = 0u64;
        while (j < 3) {
            if (*vector::borrow(&output_enabled, j) == 1u8) {
                let c = *vector::borrow(&c_outs, j);
                assert!(c != ZERO_COMMITMENT, error::invalid_argument(E_INVALID_COMMITMENT));
                assert!(!table::contains(&state.commitments, c), error::already_exists(E_COMMITMENT_EXISTS));

                let enc = if (j == 0) { copy encrypted_note1 }
                          else if (j == 1) { copy encrypted_note2 }
                          else { copy encrypted_note3 };
                
                vector::push_back(&mut state.pending_commitments, PendingCommitment { commitment: c, encrypted_note: enc });
                k = k + 1;
            };
            j = j + 1;
        };
        assert!(k > 0, error::invalid_argument(E_NO_OUTPUTS));
    }

    // ── WITHDRAW ──────────────────────────────────────────────────────────────
    // Permissionless. Sends `withdraw_amount` from the pool to `receiver`.
    // One new_root proof per ENABLED change output.

    public entry fun withdraw(
        _caller:         &signer,
        pool_addr:       address,
        a_bytes:         vector<u8>,
        b_bytes:         vector<u8>,
        c_bytes:         vector<u8>,
        enabled:         vector<u8>,
        pool_ids:        vector<u64>,
        roots:           vector<u256>,
        nullifiers:      vector<u256>,
        receiver:        address,
        withdraw_amount: u64,
        out_enabled:     vector<u8>,
        c_outs:          vector<u256>,
        encrypted_note1: vector<u8>,
        encrypted_note2: vector<u8>,
    ) acquires PoolState {
        assert!(
            vector::length(&enabled)    == MAX_INPUTS &&
            vector::length(&pool_ids)   == MAX_INPUTS &&
            vector::length(&roots)      == MAX_INPUTS &&
            vector::length(&nullifiers) == MAX_INPUTS,
            error::invalid_argument(E_BAD_INPUT_LEN)
        );
        assert!(
            vector::length(&out_enabled) == 2 && vector::length(&c_outs) == 2,
            error::invalid_argument(E_BAD_INPUT_LEN)
        );
        assert!(withdraw_amount > 0, error::invalid_argument(E_ZERO_AMOUNT));

        let state = borrow_global_mut<PoolState>(pool_addr);
        assert!(vector::is_empty(&state.pending_commitments), error::invalid_state(E_PENDING_TASKS));
        assert!(
            state.locked_balance >= withdraw_amount,
            error::invalid_argument(E_INSUFFICIENT_BALANCE)
        );
        verify_inputs(state, &enabled, &pool_ids, &roots, &nullifiers);

        // Withdraw ZK proof public signals (19).
        let sigs = vector::empty<u256>();
        vector::push_back(&mut sigs, address_to_u256_mod_p(receiver));
        vector::push_back(&mut sigs, state.relayer_commitment);
        pack_enabled(&mut sigs, &enabled);
        pack_u256_vec(&mut sigs, &roots);
        pack_u256_vec(&mut sigs, &nullifiers);
        vector::push_back(&mut sigs, (withdraw_amount as u256));
        pack_enabled_2(&mut sigs, &out_enabled);
        pack_u256_vec(&mut sigs, &c_outs);
        assert!(
            verifier::verify_withdraw(pool_addr, &a_bytes, &b_bytes, &c_bytes, &sigs),
            error::invalid_argument(E_PROOF_FAILED)
        );

        spend_nullifiers(state, &enabled, &nullifiers);

        // Push each enabled change output to pending_commitments queue instead of inserting immediately.
        let k = 0u64;
        let j = 0u64;
        while (j < 2) {
            if (*vector::borrow(&out_enabled, j) == 1u8) {
                let c = *vector::borrow(&c_outs, j);
                assert!(c != ZERO_COMMITMENT, error::invalid_argument(E_INVALID_COMMITMENT));
                assert!(!table::contains(&state.commitments, c), error::already_exists(E_COMMITMENT_EXISTS));

                let enc = if (j == 0) { copy encrypted_note1 } else { copy encrypted_note2 };
                vector::push_back(&mut state.pending_commitments, PendingCommitment { commitment: c, encrypted_note: enc });
                k = k + 1;
            };
            j = j + 1;
        };

        state.locked_balance = state.locked_balance - withdraw_amount;

        let pool_signer = account::create_signer_with_capability(&state.pool_signer_cap);
        aptos_account::transfer(&pool_signer, receiver, withdraw_amount);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fun verify_inputs(
        state:      &PoolState,
        enabled:    &vector<u8>,
        pool_ids:   &vector<u64>,
        roots:      &vector<u256>,
        nullifiers: &vector<u256>,
    ) {
        let n_pools = merkle_tree::pool_count(&state.forest);
        let i = 0u64;
        while (i < MAX_INPUTS) {
            let en = *vector::borrow(enabled, i);
            assert!(en == 0u8 || en == 1u8, error::invalid_argument(E_BAD_INPUT_LEN));
            if (en == 0u8) { i = i + 1; continue };

            let pid  = *vector::borrow(pool_ids,   i);
            let root = *vector::borrow(roots,      i);
            let null = *vector::borrow(nullifiers, i);

            assert!(pid < n_pools, error::invalid_argument(E_INVALID_POOL_ID));
            assert!(
                merkle_tree::is_valid_root(&state.forest, pid, root),
                error::invalid_argument(E_INVALID_ROOT)
            );
            assert!(
                !table::contains(&state.nullifiers, null),
                error::invalid_argument(E_NULLIFIER_SPENT)
            );

            let j = 0u64;
            while (j < i) {
                if (*vector::borrow(enabled, j) == 1u8) {
                    assert!(
                        *vector::borrow(nullifiers, j) != null,
                        error::invalid_argument(E_DUPLICATE_NULLIFIER)
                    );
                };
                j = j + 1;
            };
            i = i + 1;
        };
    }

    fun spend_nullifiers(
        state:      &mut PoolState,
        enabled:    &vector<u8>,
        nullifiers: &vector<u256>,
    ) {
        let i = 0u64;
        while (i < MAX_INPUTS) {
            if (*vector::borrow(enabled, i) == 1u8) {
                let null = *vector::borrow(nullifiers, i);
                table::add(&mut state.nullifiers, null, true);
                event::emit(NullifierSpentEvent { nullifier: null });
            };
            i = i + 1;
        };
    }

    /// Reduce an Aptos address mod the BN254 scalar prime so it can be a public
    /// signal (the circom circuit reduces it the same way).
    fun address_to_u256_mod_p(addr: address): u256 {
        poseidon::bytes32_to_u256(std::bcs::to_bytes(&addr)) % BN254_P
    }

    fun pack_enabled(sigs: &mut vector<u256>, e: &vector<u8>) {
        let i = 0u64;
        while (i < MAX_INPUTS) {
            vector::push_back(sigs, (*vector::borrow(e, i) as u256));
            i = i + 1;
        };
    }

    fun pack_enabled_3(sigs: &mut vector<u256>, e: &vector<u8>) {
        let i = 0u64;
        while (i < 3) {
            vector::push_back(sigs, (*vector::borrow(e, i) as u256));
            i = i + 1;
        };
    }

    fun pack_enabled_2(sigs: &mut vector<u256>, e: &vector<u8>) {
        let i = 0u64;
        while (i < 2) {
            vector::push_back(sigs, (*vector::borrow(e, i) as u256));
            i = i + 1;
        };
    }

    fun pack_u256_vec(sigs: &mut vector<u256>, v: &vector<u256>) {
        let i = 0u64;
        let n = vector::length(v);
        while (i < n) {
            vector::push_back(sigs, *vector::borrow(v, i));
            i = i + 1;
        };
    }

    // ── View functions ──────────────────────────────────────────────────────

    #[view]
    public fun is_nullifier_spent(pool_addr: address, nullifier: u256): bool acquires PoolState {
        table::contains(&borrow_global<PoolState>(pool_addr).nullifiers, nullifier)
    }

    #[view]
    public fun commitment_exists(pool_addr: address, c: u256): bool acquires PoolState {
        table::contains(&borrow_global<PoolState>(pool_addr).commitments, c)
    }

    #[view]
    public fun locked_balance(pool_addr: address): u64 acquires PoolState {
        borrow_global<PoolState>(pool_addr).locked_balance
    }

    #[view]
    public fun pool_count(pool_addr: address): u64 acquires PoolState {
        merkle_tree::pool_count(&borrow_global<PoolState>(pool_addr).forest)
    }

    #[view]
    public fun current_root(pool_addr: address, pool_idx: u64): u256 acquires PoolState {
        merkle_tree::current_root(&borrow_global<PoolState>(pool_addr).forest, pool_idx)
    }

    #[view]
    public fun next_index(pool_addr: address, pool_idx: u64): u64 acquires PoolState {
        merkle_tree::next_index(&borrow_global<PoolState>(pool_addr).forest, pool_idx)
    }

    #[view]
    public fun current_subtrees_hash(pool_addr: address, pool_idx: u64): u256 acquires PoolState {
        merkle_tree::current_subtrees_hash(&borrow_global<PoolState>(pool_addr).forest, pool_idx)
    }

    #[view]
    public fun relayer_address(pool_addr: address): address acquires PoolState {
        borrow_global<PoolState>(pool_addr).relayer_address
    }

    #[view]
    public fun relayer_commitment(pool_addr: address): u256 acquires PoolState {
        borrow_global<PoolState>(pool_addr).relayer_commitment
    }

    #[view]
    public fun pool_resource_addr(pool_addr: address): address acquires PoolState {
        borrow_global<PoolState>(pool_addr).pool_resource_addr
    }

    public entry fun update_root(
        _caller:           &signer,
        pool_addr:         address,
        commitment:        u256,
        nr_a:              vector<u8>,
        nr_b:              vector<u8>,
        nr_c:              vector<u8>,
        new_root:          u256,
        new_subtrees_hash: u256,
    ) acquires PoolState {
        let state = borrow_global_mut<PoolState>(pool_addr);
        assert!(!vector::is_empty(&state.pending_commitments), error::invalid_state(E_NO_PENDING_TASKS));

        let first_pending = vector::borrow(&state.pending_commitments, 0);
        assert!(first_pending.commitment == commitment, error::invalid_argument(E_COMMITMENT_MISMATCH));

        insert_with_proof(
            state,
            pool_addr,
            commitment,
            nr_a,
            nr_b,
            nr_c,
            new_root,
            new_subtrees_hash,
        );

        table::add(&mut state.commitments, commitment, true);

        let PendingCommitment { commitment: _, encrypted_note } = vector::remove(&mut state.pending_commitments, 0);
        event::emit(NoteCreatedEvent {
            pool_id: 0,
            commitment,
            encrypted_note,
        });
    }

    #[view]
    public fun pending_commitments_count(pool_addr: address): u64 acquires PoolState {
        vector::length(&borrow_global<PoolState>(pool_addr).pending_commitments)
    }

    #[view]
    public fun get_pending_commitment_at(pool_addr: address, idx: u64): u256 acquires PoolState {
        let state = borrow_global<PoolState>(pool_addr);
        vector::borrow(&state.pending_commitments, idx).commitment
    }
}
