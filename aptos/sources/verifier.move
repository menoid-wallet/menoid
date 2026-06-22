/// Groth16 proof verifier for the noid privacy protocol.
///
/// Uses aptos_std::crypto_algebra + aptos_std::bn254_algebra which ARE
/// available on devnet/testnet/mainnet — identical pattern to the working
/// zkdemo::square module.
///
/// The original verifier.move used aptos_std::groth16_bn254 which does NOT
/// exist as a standalone module in the public framework.
///
/// Groth16 pairing check (standard):
///   e(A, B) == e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
///
/// where vk_x = IC[0] + sum_i( signal_i * IC[i+1] )
///
/// Public signals are passed as u256 scalars and converted to Fr field
/// elements using little-endian 32-byte encoding (matches snarkjs output).
///
/// Byte encoding convention (matches snarkjs + bn254_algebra):
///   G1 point : 64 bytes — x_le(32) || y_le(32)   little-endian
///   G2 point : 128 bytes — x0_le(32) || x1_le(32) || y0_le(32) || y1_le(32)
///   Fr scalar: 32 bytes — value_le(32)             little-endian
///
/// NOTE: snarkjs by default exports proof coordinates in big-endian.
///       The helper proofToBytes() in the test file already converts to
///       LITTLE-endian before passing to this contract — matching
///       bn254_algebra::FormatG1Uncompr / FormatG2Uncompr / FormatFrLsb.
module noid::verifier {

    use std::vector;
    use std::option;

    use aptos_std::crypto_algebra::{
        deserialize, from_u64, multi_scalar_mul, eq,
        pairing, add, zero
    };
    use aptos_std::bn254_algebra::{
        G1, G2, Gt, Fr,
        FormatG1Uncompr,
        FormatG2Uncompr,
        FormatFrLsb
    };

    // ─── Error codes ─────────────────────────────────────────────────────────

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_NOT_INITIALIZED: u64     = 2;
    const E_PROOF_FAILED: u64        = 3;
    const E_BAD_SIGNAL_COUNT: u64    = 4;

    // ─── Structs ──────────────────────────────────────────────────────────────

    /// Stores raw VK bytes for each circuit on-chain.
    /// We store bytes (not parsed points) so the resource can be updated
    /// without redeploying the module.
    struct VerificationKeys has key {
        // Deposit circuit (4 public signals → 5 IC points)
        dep_alpha: vector<u8>,   // G1, 64 bytes
        dep_beta:  vector<u8>,   // G2, 128 bytes
        dep_gamma: vector<u8>,   // G2, 128 bytes
        dep_delta: vector<u8>,   // G2, 128 bytes
        dep_ic:    vector<u8>,   // 5 * 64 = 320 bytes

        // Transfer circuit (19 public signals → 20 IC points)
        tra_alpha: vector<u8>,
        tra_beta:  vector<u8>,
        tra_gamma: vector<u8>,
        tra_delta: vector<u8>,
        tra_ic:    vector<u8>,   // 20 * 64 = 1280 bytes

        // Withdraw circuit (19 public signals → 20 IC points)
        wit_alpha: vector<u8>,
        wit_beta:  vector<u8>,
        wit_gamma: vector<u8>,
        wit_delta: vector<u8>,
        wit_ic:    vector<u8>,   // 20 * 64 = 1280 bytes

        // NewRoot circuit (43 public signals → 44 IC points)
        nr_alpha:  vector<u8>,
        nr_beta:   vector<u8>,
        nr_gamma:  vector<u8>,
        nr_delta:  vector<u8>,
        nr_ic:     vector<u8>,   // 44 * 64 = 2816 bytes
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initialization
    // ─────────────────────────────────────────────────────────────────────────

    /// Register all three verification keys.
    /// Must be called once by the deployer after the trusted setup is done.
    public entry fun initialize_vks(
        admin:     &signer,
        dep_alpha: vector<u8>, dep_beta: vector<u8>,
        dep_gamma: vector<u8>, dep_delta: vector<u8>,
        dep_ic:    vector<u8>,
        tra_alpha: vector<u8>, tra_beta: vector<u8>,
        tra_gamma: vector<u8>, tra_delta: vector<u8>,
        tra_ic:    vector<u8>,
        wit_alpha: vector<u8>, wit_beta: vector<u8>,
        wit_gamma: vector<u8>, wit_delta: vector<u8>,
        wit_ic:    vector<u8>,
        nr_alpha:  vector<u8>, nr_beta: vector<u8>,
        nr_gamma:  vector<u8>, nr_delta: vector<u8>,
        nr_ic:     vector<u8>,
    ) {
        let addr = std::signer::address_of(admin);
        assert!(!exists<VerificationKeys>(addr), E_ALREADY_INITIALIZED);
        move_to(admin, VerificationKeys {
            dep_alpha, dep_beta, dep_gamma, dep_delta, dep_ic,
            tra_alpha, tra_beta, tra_gamma, tra_delta, tra_ic,
            wit_alpha, wit_beta, wit_gamma, wit_delta, wit_ic,
            nr_alpha, nr_beta, nr_gamma, nr_delta, nr_ic,
        });
    }

    /// Re-register (overwrite) VKs — useful after a new trusted setup.
    public entry fun reinitialize_vks(
        admin:     &signer,
        dep_alpha: vector<u8>, dep_beta: vector<u8>,
        dep_gamma: vector<u8>, dep_delta: vector<u8>,
        dep_ic:    vector<u8>,
        tra_alpha: vector<u8>, tra_beta: vector<u8>,
        tra_gamma: vector<u8>, tra_delta: vector<u8>,
        tra_ic:    vector<u8>,
        wit_alpha: vector<u8>, wit_beta: vector<u8>,
        wit_gamma: vector<u8>, wit_delta: vector<u8>,
        wit_ic:    vector<u8>,
        nr_alpha:  vector<u8>, nr_beta: vector<u8>,
        nr_gamma:  vector<u8>, nr_delta: vector<u8>,
        nr_ic:     vector<u8>,
    ) acquires VerificationKeys {
        let addr = std::signer::address_of(admin);
        if (exists<VerificationKeys>(addr)) {
            let vks = borrow_global_mut<VerificationKeys>(addr);
            vks.dep_alpha = dep_alpha; vks.dep_beta = dep_beta;
            vks.dep_gamma = dep_gamma; vks.dep_delta = dep_delta;
            vks.dep_ic    = dep_ic;
            vks.tra_alpha = tra_alpha; vks.tra_beta = tra_beta;
            vks.tra_gamma = tra_gamma; vks.tra_delta = tra_delta;
            vks.tra_ic    = tra_ic;
            vks.wit_alpha = wit_alpha; vks.wit_beta = wit_beta;
            vks.wit_gamma = wit_gamma; vks.wit_delta = wit_delta;
            vks.wit_ic    = wit_ic;
            vks.nr_alpha  = nr_alpha; vks.nr_beta = nr_beta;
            vks.nr_gamma  = nr_gamma; vks.nr_delta = nr_delta;
            vks.nr_ic     = nr_ic;
        } else {
            move_to(admin, VerificationKeys {
                dep_alpha, dep_beta, dep_gamma, dep_delta, dep_ic,
                tra_alpha, tra_beta, tra_gamma, tra_delta, tra_ic,
                wit_alpha, wit_beta, wit_gamma, wit_delta, wit_ic,
                nr_alpha, nr_beta, nr_gamma, nr_delta, nr_ic,
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public verification entry points
    // ─────────────────────────────────────────────────────────────────────────

    /// Verify a deposit proof.
    /// public_signals = [depositAmount, c1, c2, relayerZkPubkey]  (4 signals)
    public fun verify_deposit(
        vks_addr:       address,
        a_bytes:        &vector<u8>,
        b_bytes:        &vector<u8>,
        c_bytes:        &vector<u8>,
        public_signals: &vector<u256>,
    ): bool acquires VerificationKeys {
        assert!(exists<VerificationKeys>(vks_addr), E_NOT_INITIALIZED);
        assert!(vector::length(public_signals) == 4, E_BAD_SIGNAL_COUNT);
        let vks = borrow_global<VerificationKeys>(vks_addr);
        groth16_verify(
            &vks.dep_alpha, &vks.dep_beta, &vks.dep_gamma, &vks.dep_delta, &vks.dep_ic,
            a_bytes, b_bytes, c_bytes,
            public_signals,
        )
    }

    /// Verify a transfer proof.
    /// public_signals has 19 elements.
    public fun verify_transfer(
        vks_addr:       address,
        a_bytes:        &vector<u8>,
        b_bytes:        &vector<u8>,
        c_bytes:        &vector<u8>,
        public_signals: &vector<u256>,
    ): bool acquires VerificationKeys {
        assert!(exists<VerificationKeys>(vks_addr), E_NOT_INITIALIZED);
        assert!(vector::length(public_signals) == 19, E_BAD_SIGNAL_COUNT);
        let vks = borrow_global<VerificationKeys>(vks_addr);
        groth16_verify(
            &vks.tra_alpha, &vks.tra_beta, &vks.tra_gamma, &vks.tra_delta, &vks.tra_ic,
            a_bytes, b_bytes, c_bytes,
            public_signals,
        )
    }

    /// Verify a withdraw proof.
    /// public_signals has 19 elements.
    public fun verify_withdraw(
        vks_addr:       address,
        a_bytes:        &vector<u8>,
        b_bytes:        &vector<u8>,
        c_bytes:        &vector<u8>,
        public_signals: &vector<u256>,
    ): bool acquires VerificationKeys {
        assert!(exists<VerificationKeys>(vks_addr), E_NOT_INITIALIZED);
        assert!(vector::length(public_signals) == 19, E_BAD_SIGNAL_COUNT);
        let vks = borrow_global<VerificationKeys>(vks_addr);
        groth16_verify(
            &vks.wit_alpha, &vks.wit_beta, &vks.wit_gamma, &vks.wit_delta, &vks.wit_ic,
            a_bytes, b_bytes, c_bytes,
            public_signals,
        )
    }

    /// Verify a new_root (incremental-insertion) proof.
    /// public_signals = [ newRoot, newSubtreesHash, oldSubtreesHash, commitment, leafIndex ]
    /// → 5 signals (subtrees committed as a hash to keep the IC set small).
    public fun verify_new_root(
        vks_addr:       address,
        a_bytes:        &vector<u8>,
        b_bytes:        &vector<u8>,
        c_bytes:        &vector<u8>,
        public_signals: &vector<u256>,
    ): bool acquires VerificationKeys {
        assert!(exists<VerificationKeys>(vks_addr), E_NOT_INITIALIZED);
        assert!(vector::length(public_signals) == 5, E_BAD_SIGNAL_COUNT);
        let vks = borrow_global<VerificationKeys>(vks_addr);
        groth16_verify(
            &vks.nr_alpha, &vks.nr_beta, &vks.nr_gamma, &vks.nr_delta, &vks.nr_ic,
            a_bytes, b_bytes, c_bytes,
            public_signals,
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core Groth16 pairing check
    // ─────────────────────────────────────────────────────────────────────────

    /// Generic Groth16 verification.
    ///
    /// Performs:
    ///   e(A, B) == e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
    ///
    /// where  vk_x = IC[0] + sum_i( signal_i * IC[i+1] )
    ///
    /// This is identical in structure to zkdemo::square::i_know_x, generalised
    /// to N public signals and a packed IC byte vector.
    fun groth16_verify(
        alpha_bytes: &vector<u8>,
        beta_bytes:  &vector<u8>,
        gamma_bytes: &vector<u8>,
        delta_bytes: &vector<u8>,
        ic_bytes:    &vector<u8>,
        a_bytes:     &vector<u8>,
        b_bytes:     &vector<u8>,
        c_bytes:     &vector<u8>,
        signals:     &vector<u256>,
    ): bool {
        // ── Deserialise VK points ─────────────────────────────────────────────
        let alpha = option::extract(&mut deserialize<G1, FormatG1Uncompr>(alpha_bytes));
        let beta  = option::extract(&mut deserialize<G2, FormatG2Uncompr>(beta_bytes));
        let gamma = option::extract(&mut deserialize<G2, FormatG2Uncompr>(gamma_bytes));
        let delta = option::extract(&mut deserialize<G2, FormatG2Uncompr>(delta_bytes));

        // ── Deserialise proof points ──────────────────────────────────────────
        let proof_a = option::extract(&mut deserialize<G1, FormatG1Uncompr>(a_bytes));
        let proof_b = option::extract(&mut deserialize<G2, FormatG2Uncompr>(b_bytes));
        let proof_c = option::extract(&mut deserialize<G1, FormatG1Uncompr>(c_bytes));

        // ── Parse IC points from packed bytes ─────────────────────────────────
        //   IC has (n_signals + 1) points, each 64 bytes.
        let n_signals = vector::length(signals);
        let n_ic      = n_signals + 1;
        let ic_points = vector::empty();
        let k = 0u64;
        while (k < n_ic) {
            let chunk = slice_64(ic_bytes, k * 64);
            let pt = option::extract(&mut deserialize<G1, FormatG1Uncompr>(&chunk));
            vector::push_back(&mut ic_points, pt);
            k = k + 1;
        };

        // ── Convert u256 signals → Fr scalars ────────────────────────────────
        //   Each signal is a BN254 scalar field element stored as u256.
        //   bn254_algebra::FormatFrLsb expects 32 bytes little-endian.
        let fr_scalars = vector::empty();
        // IC[0] is multiplied by the constant 1
        vector::push_back(&mut fr_scalars, from_u64<Fr>(1));
        let m = 0u64;
        while (m < n_signals) {
            let s = *vector::borrow(signals, m);
            let s_bytes = u256_to_le32(s);
            let fr = option::extract(&mut deserialize<Fr, FormatFrLsb>(&s_bytes));
            vector::push_back(&mut fr_scalars, fr);
            m = m + 1;
        };

        // ── Compute vk_x = multi_scalar_mul(IC, [1, s_0, s_1, ...]) ──────────
        let vk_x = multi_scalar_mul<G1, Fr>(&ic_points, &fr_scalars);

        // ── Pairing check ─────────────────────────────────────────────────────
        //   LHS = e(A, B)
        //   RHS = e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
        let lhs = pairing<G1, G2, Gt>(&proof_a, &proof_b);

        let rhs = zero<Gt>();
        let rhs = add(&rhs, &pairing<G1, G2, Gt>(&alpha,   &beta));
        let rhs = add(&rhs, &pairing<G1, G2, Gt>(&vk_x,   &gamma));
        let rhs = add(&rhs, &pairing<G1, G2, Gt>(&proof_c, &delta));

        eq<Gt>(&lhs, &rhs)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Byte helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// Extract 64 bytes starting at `offset` from a vector.
    fun slice_64(v: &vector<u8>, offset: u64): vector<u8> {
        let out = vector::empty<u8>();
        let i = 0u64;
        while (i < 64) {
            vector::push_back(&mut out, *vector::borrow(v, offset + i));
            i = i + 1;
        };
        out
    }

    /// Convert a u256 to a 32-byte little-endian vector.
    /// Matches FormatFrLsb expected by bn254_algebra.
    fun u256_to_le32(v: u256): vector<u8> {
        let out = vector::empty<u8>();
        let val = v;
        let i = 0u64;
        while (i < 32) {
            vector::push_back(&mut out, ((val & 0xFF) as u8));
            val = val >> 8;
            i = i + 1;
        };
        out
    }

    #[view]
    public fun is_initialized(addr: address): bool {
        exists<VerificationKeys>(addr)
    }
}
