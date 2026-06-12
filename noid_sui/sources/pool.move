/// NoidPool — Sui port of the Aptos noid::pool module.
module noid::pool {

    use std::vector;
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::balance::{Self, Balance};
    use sui::table::{Self, Table};
    use sui::event;

    use noid::merkle_tree::{Self, Forest};
    use noid::verifier::{Self, VerifierConfig};
    use noid::poseidon;

    const ZERO_COMMITMENT: u256 = 0u256;
    const MAX_INPUTS: u64       = 4;
    const BN254_P: u256 = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    const E_ZERO_AMOUNT: u64          = 3;
    const E_INVALID_COMMITMENT: u64   = 4;
    const E_COMMITMENT_EXISTS: u64    = 5;
    const E_NULLIFIER_SPENT: u64      = 6;
    const E_INVALID_ROOT: u64         = 7;
    const E_INVALID_POOL_ID: u64      = 8;
    const E_DUPLICATE_NULLIFIER: u64  = 9;
    const E_NO_OUTPUTS: u64           = 10;
    const E_PROOF_FAILED: u64         = 11;
    const E_DUPLICATE_COMMITMENT: u64 = 13;
    const E_INSUFFICIENT_BALANCE: u64 = 14;
    const E_BAD_INPUT_LEN: u64        = 20;
    const E_NOT_RELAYER: u64          = 21;

    public struct NoteCreatedEvent has copy, drop {
        pool_id:        u64,
        commitment:     u256,
        encrypted_note: vector<u8>,
    }

    public struct NullifierSpentEvent has copy, drop {
        nullifier: u256,
    }

    public struct PoolState has key {
        id:                sui::object::UID,
        forest:            Forest,
        nullifiers:        Table<u256, bool>,
        commitments:       Table<u256, bool>,
        balance:           Balance<SUI>,
        locked_balance:    u64,
        relayer_zk_pubkey: u256,
        relayer_address:   address,
        admin:             address,
    }

    public entry fun initialize(
        relayer_zk_pubkey: u256,
        relayer_address:   address,
        ctx:               &mut sui::tx_context::TxContext,
    ) {
        let forest = merkle_tree::create_forest();
        let state  = PoolState {
            id:                sui::object::new(ctx),
            forest,
            nullifiers:        table::new<u256, bool>(ctx),
            commitments:       table::new<u256, bool>(ctx),
            balance:           balance::zero<SUI>(),
            locked_balance:    0,
            relayer_zk_pubkey,
            relayer_address,
            admin:             sui::tx_context::sender(ctx),
        };
        sui::transfer::share_object(state);
    }

    public entry fun set_relayer(
        state:             &mut PoolState,
        relayer_zk_pubkey: u256,
        relayer_address:   address,
        ctx:               &sui::tx_context::TxContext,
    ) {
        assert!(state.admin == sui::tx_context::sender(ctx), E_NOT_RELAYER);
        state.relayer_zk_pubkey = relayer_zk_pubkey;
        state.relayer_address   = relayer_address;
    }

    fun assert_relayer(state: &PoolState, ctx: &sui::tx_context::TxContext) {
        assert!(sui::tx_context::sender(ctx) == state.relayer_address, E_NOT_RELAYER);
    }

    public entry fun deposit(
        state:           &mut PoolState,
        config:          &VerifierConfig,
        coin:            Coin<SUI>,
        proof_bytes:     vector<u8>,
        c1:              u256,
        c2:              u256,
        amount:          u64,
        new_root_1:      u256,
        new_root_2:      u256,
        encrypted_note1: vector<u8>,
        encrypted_note2: vector<u8>,
        ctx:             &mut sui::tx_context::TxContext,
    ) {
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(c1 != ZERO_COMMITMENT && c2 != ZERO_COMMITMENT, E_INVALID_COMMITMENT);
        assert!(c1 != c2, E_DUPLICATE_COMMITMENT);
        let sponsor_addr = sui::tx_context::sponsor(ctx);
        assert!(
            std::option::is_some(&sponsor_addr) && 
            *std::option::borrow(&sponsor_addr) == state.relayer_address, 
            E_NOT_RELAYER
        );
        assert!(!table::contains(&state.commitments, c1), E_COMMITMENT_EXISTS);
        assert!(!table::contains(&state.commitments, c2), E_COMMITMENT_EXISTS);
        assert!(coin::value(&coin) == amount, E_ZERO_AMOUNT);

        let mut sigs = vector[];
        vector::push_back(&mut sigs, (amount as u256));
        vector::push_back(&mut sigs, c1);
        vector::push_back(&mut sigs, c2);
        vector::push_back(&mut sigs, state.relayer_zk_pubkey);

        assert!(verifier::verify_deposit(config, &proof_bytes, &sigs), E_PROOF_FAILED);

        let coin_balance = coin::into_balance(coin);
        balance::join(&mut state.balance, coin_balance);
        state.locked_balance = state.locked_balance + amount;

        let r1 = merkle_tree::insert(&mut state.forest, c1, new_root_1);
        table::add(&mut state.commitments, c1, true);
        event::emit(NoteCreatedEvent {
            pool_id:        merkle_tree::insert_result_pool_idx(&r1),
            commitment:     c1,
            encrypted_note: encrypted_note1,
        });

        let r2 = merkle_tree::insert(&mut state.forest, c2, new_root_2);
        table::add(&mut state.commitments, c2, true);
        event::emit(NoteCreatedEvent {
            pool_id:        merkle_tree::insert_result_pool_idx(&r2),
            commitment:     c2,
            encrypted_note: encrypted_note2,
        });
    }

    public entry fun transfer(
        state:           &mut PoolState,
        config:          &VerifierConfig,
        proof_bytes:     vector<u8>,
        enabled:         vector<u8>,
        pool_ids:        vector<u64>,
        roots:           vector<u256>,
        nullifiers:      vector<u256>,
        output_enabled:  vector<u8>,
        c_outs:          vector<u256>,
        output_roots:    vector<u256>,
        encrypted_note1: vector<u8>,
        encrypted_note2: vector<u8>,
        encrypted_note3: vector<u8>,
        ctx:             &mut sui::tx_context::TxContext,
    ) {
        assert!(
            vector::length(&enabled)    == MAX_INPUTS &&
            vector::length(&pool_ids)   == MAX_INPUTS &&
            vector::length(&roots)      == MAX_INPUTS &&
            vector::length(&nullifiers) == MAX_INPUTS,
            E_BAD_INPUT_LEN
        );
        assert!(vector::length(&output_enabled) == 3 && vector::length(&c_outs) == 3, E_BAD_INPUT_LEN);

        assert_relayer(state, ctx);
        verify_inputs(state, &enabled, &pool_ids, &roots, &nullifiers);

        let mut out_cmxs           = vector[];
        let mut out_roots_filtered = vector[];
        let mut i = 0u64;
        while (i < 3) {
            if (*vector::borrow(&output_enabled, i) == 1u8) {
                let c = *vector::borrow(&c_outs, i);
                assert!(c != ZERO_COMMITMENT, E_INVALID_COMMITMENT);
                assert!(!table::contains(&state.commitments, c), E_COMMITMENT_EXISTS);
                vector::push_back(&mut out_cmxs, c);
                vector::push_back(&mut out_roots_filtered, *vector::borrow(&output_roots, i));
            };
            i = i + 1;
        };
        assert!(vector::length(&out_cmxs) > 0, E_NO_OUTPUTS);

        let enabled_hash = poseidon::hash4(
            (*vector::borrow(&enabled, 0) as u256),
            (*vector::borrow(&enabled, 1) as u256),
            (*vector::borrow(&enabled, 2) as u256),
            (*vector::borrow(&enabled, 3) as u256)
        );
        let roots_hash = poseidon::hash4(
            *vector::borrow(&roots, 0),
            *vector::borrow(&roots, 1),
            *vector::borrow(&roots, 2),
            *vector::borrow(&roots, 3)
        );
        let nullifiers_hash = poseidon::hash4(
            *vector::borrow(&nullifiers, 0),
            *vector::borrow(&nullifiers, 1),
            *vector::borrow(&nullifiers, 2),
            *vector::borrow(&nullifiers, 3)
        );
        let output_enabled_hash = poseidon::hash3(
            (*vector::borrow(&output_enabled, 0) as u256),
            (*vector::borrow(&output_enabled, 1) as u256),
            (*vector::borrow(&output_enabled, 2) as u256)
        );
        let c_outs_hash = poseidon::hash3(
            *vector::borrow(&c_outs, 0),
            *vector::borrow(&c_outs, 1),
            *vector::borrow(&c_outs, 2)
        );

        let mut sigs = vector[];
        vector::push_back(&mut sigs, state.relayer_zk_pubkey);
        vector::push_back(&mut sigs, enabled_hash);
        vector::push_back(&mut sigs, roots_hash);
        vector::push_back(&mut sigs, nullifiers_hash);
        vector::push_back(&mut sigs, output_enabled_hash);
        vector::push_back(&mut sigs, c_outs_hash);

        assert!(verifier::verify_transfer(config, &proof_bytes, &sigs), E_PROOF_FAILED);

        spend_nullifiers(state, &enabled, &nullifiers);

        let inserted = merkle_tree::insert_batch(&mut state.forest, out_cmxs, out_roots_filtered);
        let mut j = 0u64;
        while (j < vector::length(&inserted)) {
            let pool_id = merkle_tree::insert_result_pool_idx(vector::borrow(&inserted, j));
            let cmx     = *vector::borrow(&out_cmxs, j);
            table::add(&mut state.commitments, cmx, true);
            let enc =
                if (cmx == *vector::borrow(&c_outs, 0)) { copy encrypted_note1 }
                else if (cmx == *vector::borrow(&c_outs, 1)) { copy encrypted_note2 }
                else { copy encrypted_note3 };
            event::emit(NoteCreatedEvent { pool_id, commitment: cmx, encrypted_note: enc });
            j = j + 1;
        };
    }

    public entry fun withdraw(
        state:           &mut PoolState,
        config:          &VerifierConfig,
        proof_bytes:     vector<u8>,
        enabled:         vector<u8>,
        pool_ids:        vector<u64>,
        roots:           vector<u256>,
        nullifiers:      vector<u256>,
        receiver:        address,
        withdraw_amount: u64,
        out_enabled:     vector<u8>,
        c_outs:          vector<u256>,
        output_roots:    vector<u256>,
        encrypted_note1: vector<u8>,
        encrypted_note2: vector<u8>,
        ctx:             &mut sui::tx_context::TxContext,
    ) {
        assert!(
            vector::length(&enabled)    == MAX_INPUTS &&
            vector::length(&pool_ids)   == MAX_INPUTS &&
            vector::length(&roots)      == MAX_INPUTS &&
            vector::length(&nullifiers) == MAX_INPUTS,
            E_BAD_INPUT_LEN
        );
        assert!(vector::length(&out_enabled) == 2 && vector::length(&c_outs) == 2, E_BAD_INPUT_LEN);
        assert!(withdraw_amount > 0, E_ZERO_AMOUNT);

        assert_relayer(state, ctx);
        assert!(state.locked_balance >= withdraw_amount, E_INSUFFICIENT_BALANCE);
        verify_inputs(state, &enabled, &pool_ids, &roots, &nullifiers);

        let mut out_cmxs           = vector[];
        let mut out_roots_filtered = vector[];
        let mut i = 0u64;
        while (i < 2) {
            if (*vector::borrow(&out_enabled, i) == 1u8) {
                let c = *vector::borrow(&c_outs, i);
                assert!(c != ZERO_COMMITMENT, E_INVALID_COMMITMENT);
                assert!(!table::contains(&state.commitments, c), E_COMMITMENT_EXISTS);
                vector::push_back(&mut out_cmxs, c);
                vector::push_back(&mut out_roots_filtered, *vector::borrow(&output_roots, i));
            };
            i = i + 1;
        };

        let enabled_hash = poseidon::hash4(
            (*vector::borrow(&enabled, 0) as u256),
            (*vector::borrow(&enabled, 1) as u256),
            (*vector::borrow(&enabled, 2) as u256),
            (*vector::borrow(&enabled, 3) as u256)
        );
        let roots_hash = poseidon::hash4(
            *vector::borrow(&roots, 0),
            *vector::borrow(&roots, 1),
            *vector::borrow(&roots, 2),
            *vector::borrow(&roots, 3)
        );
        let nullifiers_hash = poseidon::hash4(
            *vector::borrow(&nullifiers, 0),
            *vector::borrow(&nullifiers, 1),
            *vector::borrow(&nullifiers, 2),
            *vector::borrow(&nullifiers, 3)
        );
        let withdraw_amount_hash = poseidon::hash2((withdraw_amount as u256), 0);
        let out_enabled_hash = poseidon::hash2(
            (*vector::borrow(&out_enabled, 0) as u256),
            (*vector::borrow(&out_enabled, 1) as u256)
        );
        let c_outs_hash = poseidon::hash2(
            *vector::borrow(&c_outs, 0),
            *vector::borrow(&c_outs, 1)
        );

        let mut sigs = vector[];
        vector::push_back(&mut sigs, address_to_u256_mod_p(receiver));
        vector::push_back(&mut sigs, state.relayer_zk_pubkey);
        vector::push_back(&mut sigs, enabled_hash);
        vector::push_back(&mut sigs, roots_hash);
        vector::push_back(&mut sigs, nullifiers_hash);
        vector::push_back(&mut sigs, withdraw_amount_hash);
        vector::push_back(&mut sigs, out_enabled_hash);
        vector::push_back(&mut sigs, c_outs_hash);

        assert!(verifier::verify_withdraw(config, &proof_bytes, &sigs), E_PROOF_FAILED);

        spend_nullifiers(state, &enabled, &nullifiers);

        if (vector::length(&out_cmxs) > 0) {
            let inserted = merkle_tree::insert_batch(&mut state.forest, out_cmxs, out_roots_filtered);
            let mut j = 0u64;
            while (j < vector::length(&inserted)) {
                let pool_id = merkle_tree::insert_result_pool_idx(vector::borrow(&inserted, j));
                let cmx     = *vector::borrow(&out_cmxs, j);
                table::add(&mut state.commitments, cmx, true);
                let enc = if (cmx == *vector::borrow(&c_outs, 0)) { copy encrypted_note1 } else { copy encrypted_note2 };
                event::emit(NoteCreatedEvent { pool_id, commitment: cmx, encrypted_note: enc });
                j = j + 1;
            };
        };

        state.locked_balance = state.locked_balance - withdraw_amount;
        let payout = coin::from_balance(balance::split(&mut state.balance, withdraw_amount), ctx);
        sui::transfer::public_transfer(payout, receiver);
    }

    fun verify_inputs(
        state:      &PoolState,
        enabled:    &vector<u8>,
        pool_ids:   &vector<u64>,
        roots:      &vector<u256>,
        nullifiers: &vector<u256>,
    ) {
        let n_pools = merkle_tree::pool_count(&state.forest);
        let mut i = 0u64;
        while (i < MAX_INPUTS) {
            let en = *vector::borrow(enabled, i);
            assert!(en == 0u8 || en == 1u8, E_BAD_INPUT_LEN);
            if (en == 0u8) { i = i + 1; continue };
            let pid  = *vector::borrow(pool_ids,   i);
            let root = *vector::borrow(roots,      i);
            let null = *vector::borrow(nullifiers, i);
            assert!(pid < n_pools, E_INVALID_POOL_ID);
            assert!(merkle_tree::is_valid_root(&state.forest, pid, root), E_INVALID_ROOT);
            assert!(!table::contains(&state.nullifiers, null), E_NULLIFIER_SPENT);
            let mut j = 0u64;
            while (j < i) {
                if (*vector::borrow(enabled, j) == 1u8) {
                    assert!(*vector::borrow(nullifiers, j) != null, E_DUPLICATE_NULLIFIER);
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
        let mut i = 0u64;
        while (i < MAX_INPUTS) {
            if (*vector::borrow(enabled, i) == 1u8) {
                let null = *vector::borrow(nullifiers, i);
                table::add(&mut state.nullifiers, null, true);
                event::emit(NullifierSpentEvent { nullifier: null });
            };
            i = i + 1;
        };
    }

    fun address_to_u256_mod_p(addr: address): u256 {
        let bytes = sui::bcs::to_bytes(&addr);
        poseidon::bytes32_to_u256(bytes) % BN254_P
    }


    public fun is_nullifier_spent(state: &PoolState, nullifier: u256): bool {
        table::contains(&state.nullifiers, nullifier)
    }

    public fun commitment_exists(state: &PoolState, c: u256): bool {
        table::contains(&state.commitments, c)
    }

    public fun locked_balance(state: &PoolState): u64 { state.locked_balance }

    public fun pool_count(state: &PoolState): u64 {
        merkle_tree::pool_count(&state.forest)
    }

    public fun current_root(state: &PoolState, pool_idx: u64): u256 {
        merkle_tree::current_root(&state.forest, pool_idx)
    }

    public fun relayer_address(state: &PoolState): address { state.relayer_address }
}
