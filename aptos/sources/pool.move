/// NoidPool — caller-supplied Merkle roots (no on-chain Poseidon tree computation)
///
/// Key design decisions:
///   1. Pool funds are held at a RESOURCE ACCOUNT derived from the admin address.
///      A SignerCapability is stored inside PoolState so the module can sign on
///      behalf of the pool address at withdraw time without needing the admin key.
///
///   2. DEPOSIT: Alice (the user) is the transaction SENDER and pays the APT.
///      The relayer is the FEE-PAYER (sponsored/fee-payer transaction) and pays gas.
///      Alice calls deposit() directly; the relayer co-signs only for gas.
///      We no longer assert_relayer on the caller for deposit — the ZK proof
///      already binds relayer_zk_pubkey into the circuit, which is on-chain state.
///      Access control for Merkle root supply is: only the relayer address may call
///      transfer() and withdraw() (which do mutate internal state without a ZK root
///      commitment from Alice directly).
///
///   3. TRANSFER / WITHDRAW: still relayer-only (they supply roots + proof).
///      Withdraw sends APT from the pool resource account to the receiver.
module noid::pool {

    use std::signer;
    use std::vector;
    use std::error;
    use aptos_framework::coin;
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

    /// BN254 scalar field prime.
    /// All public signals passed to the verifier MUST be reduced mod this value.
    /// The verifier uses FormatFrLsb which requires: 0 <= value < BN254_P.
    /// Aptos addresses are 32-byte values that frequently exceed this prime,
    /// so address_to_u256() MUST reduce mod BN254_P before the value is packed
    /// into the public-signal vector.
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
    const E_BAD_INPUT_LEN: u64        = 20;
    const E_NOT_RELAYER: u64          = 21;

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

    // ── State ─────────────────────────────────────────────────────────────────

    struct PoolState has key {
        forest:              Forest,
        nullifiers:          Table<u256, bool>,
        commitments:         Table<u256, bool>,
        locked_balance:      u64,
        relayer_zk_pubkey:   u256,
        relayer_address:     address,
        admin:               address,
        pool_signer_cap:     SignerCapability,
        pool_resource_addr:  address,
    }

    // ── Initialization ────────────────────────────────────────────────────────

    public entry fun initialize(
        admin:             &signer,
        relayer_zk_pubkey: u256,
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
            relayer_zk_pubkey,
            relayer_address,
            admin:              admin_addr,
            pool_signer_cap,
            pool_resource_addr,
        });
    }

    public entry fun set_relayer(
        admin: &signer, pool_addr: address,
        relayer_zk_pubkey: u256, relayer_address: address,
    ) acquires PoolState {
        let state = borrow_global_mut<PoolState>(pool_addr);
        assert!(
            state.admin == signer::address_of(admin),
            error::permission_denied(E_NOT_INITIALIZED)
        );
        state.relayer_zk_pubkey = relayer_zk_pubkey;
        state.relayer_address   = relayer_address;
    }

    // ── Access control ────────────────────────────────────────────────────────

    fun assert_relayer(caller: &signer, state: &PoolState) {
        assert!(
            signer::address_of(caller) == state.relayer_address,
            error::permission_denied(E_NOT_RELAYER)
        );
    }

    // ── DEPOSIT ───────────────────────────────────────────────────────────────

    public entry fun deposit(
        caller:          &signer,
        pool_addr:       address,
        a_bytes:         vector<u8>,
        b_bytes:         vector<u8>,
        c_bytes:         vector<u8>,
        c1:              u256,
        c2:              u256,
        amount:          u64,
        new_root_1:      u256,
        new_root_2:      u256,
        encrypted_note1: vector<u8>,
        encrypted_note2: vector<u8>,
    ) acquires PoolState {
        assert!(amount > 0, error::invalid_argument(E_ZERO_AMOUNT));
        assert!(
            c1 != ZERO_COMMITMENT && c2 != ZERO_COMMITMENT,
            error::invalid_argument(E_INVALID_COMMITMENT)
        );
        assert!(c1 != c2, error::invalid_argument(E_DUPLICATE_COMMITMENT));

        let state = borrow_global_mut<PoolState>(pool_addr);

        assert!(
            !table::contains(&state.commitments, c1),
            error::already_exists(E_COMMITMENT_EXISTS)
        );
        assert!(
            !table::contains(&state.commitments, c2),
            error::already_exists(E_COMMITMENT_EXISTS)
        );

        let sigs = vector::empty<u256>();
        vector::push_back(&mut sigs, (amount as u256));
        vector::push_back(&mut sigs, c1);
        vector::push_back(&mut sigs, c2);
        vector::push_back(&mut sigs, state.relayer_zk_pubkey);

        assert!(
            verifier::verify_deposit(pool_addr, &a_bytes, &b_bytes, &c_bytes, &sigs),
            error::invalid_argument(E_PROOF_FAILED)
        );

        coin::transfer<AptosCoin>(caller, state.pool_resource_addr, amount);
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

    // ── TRANSFER ──────────────────────────────────────────────────────────────

    public entry fun transfer(
        caller:          &signer,
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
        output_roots:    vector<u256>,
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
        assert_relayer(caller, state);
        verify_inputs(state, &enabled, &pool_ids, &roots, &nullifiers);

        let out_cmxs           = vector::empty<u256>();
        let out_roots_filtered = vector::empty<u256>();
        let i = 0u64;
        while (i < 3) {
            if (*vector::borrow(&output_enabled, i) == 1u8) {
                let c = *vector::borrow(&c_outs, i);
                assert!(c != ZERO_COMMITMENT, error::invalid_argument(E_INVALID_COMMITMENT));
                assert!(
                    !table::contains(&state.commitments, c),
                    error::already_exists(E_COMMITMENT_EXISTS)
                );
                vector::push_back(&mut out_cmxs, c);
                vector::push_back(&mut out_roots_filtered, *vector::borrow(&output_roots, i));
            };
            i = i + 1;
        };
        assert!(vector::length(&out_cmxs) > 0, error::invalid_argument(E_NO_OUTPUTS));

        let sigs = vector::empty<u256>();
        vector::push_back(&mut sigs, state.relayer_zk_pubkey);
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

        let inserted = merkle_tree::insert_batch(&mut state.forest, out_cmxs, out_roots_filtered);
        let j = 0u64;
        while (j < vector::length(&inserted)) {
            let pool_id = merkle_tree::insert_result_pool_idx(vector::borrow(&inserted, j));
            let cmx     = *vector::borrow(&out_cmxs, j);
            table::add(&mut state.commitments, cmx, true);
            let enc = if (cmx == *vector::borrow(&c_outs, 0)) { copy encrypted_note1 }
                      else if (cmx == *vector::borrow(&c_outs, 1)) { copy encrypted_note2 }
                      else { copy encrypted_note3 };
            event::emit(NoteCreatedEvent { pool_id, commitment: cmx, encrypted_note: enc });
            j = j + 1;
        };
    }

    // ── WITHDRAW ──────────────────────────────────────────────────────────────
    //
    // CRITICAL: The receiver Aptos address is a 32-byte value that may exceed
    // the BN254 scalar field prime P. The verifier deserializes every public
    // signal as Fr (which requires value < P). We MUST reduce the address mod P
    // before packing it into the signals vector. The circom circuit does the same
    // reduction automatically (all arithmetic is mod P in circom). So both sides
    // produce address % P and the proof verification succeeds.

    public entry fun withdraw(
        caller:          &signer,
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
        output_roots:    vector<u256>,
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
        assert_relayer(caller, state);
        assert!(
            state.locked_balance >= withdraw_amount,
            error::invalid_argument(E_INSUFFICIENT_BALANCE)
        );
        verify_inputs(state, &enabled, &pool_ids, &roots, &nullifiers);

        let out_cmxs           = vector::empty<u256>();
        let out_roots_filtered = vector::empty<u256>();
        let i = 0u64;
        while (i < 2) {
            if (*vector::borrow(&out_enabled, i) == 1u8) {
                let c = *vector::borrow(&c_outs, i);
                assert!(c != ZERO_COMMITMENT, error::invalid_argument(E_INVALID_COMMITMENT));
                assert!(
                    !table::contains(&state.commitments, c),
                    error::already_exists(E_COMMITMENT_EXISTS)
                );
                vector::push_back(&mut out_cmxs, c);
                vector::push_back(&mut out_roots_filtered, *vector::borrow(&output_roots, i));
            };
            i = i + 1;
        };

        let sigs = vector::empty<u256>();
        // address_to_u256_mod_p reduces mod BN254_P so Fr deserialization never fails.
        vector::push_back(&mut sigs, address_to_u256_mod_p(receiver));
        vector::push_back(&mut sigs, state.relayer_zk_pubkey);
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

        if (vector::length(&out_cmxs) > 0) {
            let inserted = merkle_tree::insert_batch(
                &mut state.forest, out_cmxs, out_roots_filtered
            );
            let j = 0u64;
            while (j < vector::length(&inserted)) {
                let pool_id = merkle_tree::insert_result_pool_idx(vector::borrow(&inserted, j));
                let cmx     = *vector::borrow(&out_cmxs, j);
                table::add(&mut state.commitments, cmx, true);
                let enc = if (cmx == *vector::borrow(&c_outs, 0)) {
                    copy encrypted_note1
                } else {
                    copy encrypted_note2
                };
                event::emit(NoteCreatedEvent { pool_id, commitment: cmx, encrypted_note: enc });
                j = j + 1;
            };
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

    /// Convert an Aptos address to a BN254 scalar field element (u256 < BN254_P).
    ///
    /// WHY: Aptos addresses are 32-byte (256-bit) values. The BN254 prime P is
    /// approximately 2^254, so any address whose most-significant byte is >= 0x31
    /// will produce a u256 >= P. The verifier's groth16_verify() converts every
    /// public signal to Fr using FormatFrLsb, which ABORTS (EOPTION_NOT_SET) if
    /// the value >= P. About 81% of random Aptos addresses exceed P.
    ///
    /// CORRECTNESS: The circom withdraw circuit treats receiver as a field element,
    /// so circom automatically reduces it mod P. Taking % BN254_P here ensures both
    /// sides agree on the same value, making the proof verification succeed.
    ///
    /// NOTE: The actual `receiver: address` parameter is still used as-is for the
    /// aptos_account::transfer call — only the signal packed into the proof needs
    /// the reduction.
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

    // ── View functions ────────────────────────────────────────────────────────

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
    public fun relayer_address(pool_addr: address): address acquires PoolState {
        borrow_global<PoolState>(pool_addr).relayer_address
    }

    #[view]
    public fun pool_resource_addr(pool_addr: address): address acquires PoolState {
        borrow_global<PoolState>(pool_addr).pool_resource_addr
    }
}
