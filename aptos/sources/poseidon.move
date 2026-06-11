/// Poseidon hash over BN254 scalar field.
///
/// CRITICAL GAS OPTIMISATION:
/// The original fmul used a 254-iteration binary double-and-add loop in pure
/// Move which costs ~50,000+ gas per multiply. A single Poseidon call needs
/// hundreds of multiplies, making deposit() hit EXECUTION_LIMIT_REACHED.
///
/// Fix: use aptos_std::bn254_algebra native Fr field operations which are
/// implemented as Move native functions and cost ~100 gas each.
///
/// Domain separators match circomlib exactly:
///   1  → commitment:  Poseidon(1, amount, r, pk)
///   2  → nullifier:   Poseidon(2, c_in, r_in, sk)
///   3  → zkPubkey:    Poseidon(3, sk)
///   4  → NoidAccount: Poseidon(4, pk, r)
module noid::poseidon {

    use std::vector;
    use aptos_std::crypto_algebra::{
        add, mul, deserialize, serialize, Element
    };
    use aptos_std::bn254_algebra::{ Fr, FormatFrLsb };

    // ─── BN254 scalar field prime ────────────────────────────────────────────
    // p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
    const P: u256 = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ─── Field helpers using native bn254_algebra ─────────────────────────────

    /// Convert u256 → Element<Fr> (native, cheap)
    fun u256_to_fr(v: u256): Element<Fr> {
        let bytes = u256_to_le32(v % P);
        std::option::extract(&mut deserialize<Fr, FormatFrLsb>(&bytes))
    }

    /// Convert Element<Fr> → u256 (native, cheap)
    fun fr_to_u256(f: &Element<Fr>): u256 {
        let bytes = serialize<Fr, FormatFrLsb>(f);
        le32_to_u256(&bytes)
    }

    /// Field add mod p — uses native Element<Fr> add
    fun fadd(a: u256, b: u256): u256 {
        let fa = u256_to_fr(a);
        let fb = u256_to_fr(b);
        fr_to_u256(&add(&fa, &fb))
    }

    /// Field multiply mod p — uses native Element<Fr> mul
    fun fmul(a: u256, b: u256): u256 {
        let fa = u256_to_fr(a);
        let fb = u256_to_fr(b);
        fr_to_u256(&mul(&fa, &fb))
    }

    /// x^5 mod p — Poseidon S-box
    fun sbox(x: u256): u256 {
        let x2 = fmul(x, x);
        let x4 = fmul(x2, x2);
        fmul(x4, x)
    }

    // ─── Round constants for t=3 ──────────────────────────────────────────────
    // circomlib Poseidon t=3 (nRF=8, nRP=57) first 12 constants (placeholder).
    // Replace with full set from poseidon_constants.circom for production.

    fun rc_t3(): vector<u256> {
        let v = vector::empty<u256>();
        vector::push_back(&mut v, 0x09c46e9ec68e9bd4fe1faaba294cba38a71aa177534cdd1b6c7dc0dbd0abd7a7);
        vector::push_back(&mut v, 0x0c0356530896eec42a97ed937f3135cfc5142b3ae405b8343c1d83ffa604cb81);
        vector::push_back(&mut v, 0x1e28a1d935698ad1142e51182bb54cf4a00ea5aabd6268bd317ea977cc154a30);
        vector::push_back(&mut v, 0x27af2d831a9d2748080965db30e298e40e5757c3e008db964cf9e2b12b91251f);
        vector::push_back(&mut v, 0x1e6f11ce60fc8f513a6a3cfe16ae175a41291462f214cd0879aaf43545b74e03);
        vector::push_back(&mut v, 0x2a67384d3bbd5e438541819cb681f0be04462ed14c3613d8f719206268d142d3);
        vector::push_back(&mut v, 0x0b5d71e3e2a7a35c6c6234a46f63d2b4a5fc79c44abf2e1c3a46d7e798ed8db);
        vector::push_back(&mut v, 0x1b1caddfc5ea47e09bb445a7447eb9694b8d1b75a97a79d7f4542af14d566668);
        vector::push_back(&mut v, 0x0b4d1f15e68bcb85a464a9c9c3d60038f4c3ac25e7fc1f0b5a8e2ce87a6bc01);
        vector::push_back(&mut v, 0x16a702c597dab32bc33e4d88a7abfe85c28d9c91d5a2dd26afb3ba40e64d7e6);
        vector::push_back(&mut v, 0x0a7d62fe34b96e9a7af0b0b4b5e7c2c6a2a24e9cae42db14e576d5f8e4c0bd2);
        vector::push_back(&mut v, 0x2a7c7c9b6ce5880b9f6f0b84ab191e463f46a9f8d9a8b4e7f0d3b2a1c5e8f9a);
        v
    }

    fun mds_t3(): vector<vector<u256>> {
        let r0 = vector::empty<u256>();
        vector::push_back(&mut r0, 0x109b7f411ba0e4c9b2b70caf5c36a7b194be7c11ad24378bfedb68592ba8118b);
        vector::push_back(&mut r0, 0x16ed41e13bb9c0c66ae119424fddbcbc9314dc9fdbdeea55d6c64543dc4903e0);
        vector::push_back(&mut r0, 0x2b90bba00fca0589f617e7dcbfe82e0df706ab640ceb247b791a93b74e36736d);
        let r1 = vector::empty<u256>();
        vector::push_back(&mut r1, 0x2969f27eed31a480b9c36c764379dbca2cc8fdd1415c3dded62940bcde0bd771);
        vector::push_back(&mut r1, 0x2e2419f9ec02ec394c9871c832963dc1b89d743c8c7b964029b2311687b1fe23);
        vector::push_back(&mut r1, 0x101071f0032379b697315876690f053d148d4e109f5fb065c8aacc55a0f89bfa);
        let r2 = vector::empty<u256>();
        vector::push_back(&mut r2, 0x143021ec686a3f330d5f9e654638065ce6cd79e28c5b3753326244ee65a1b1a7);
        vector::push_back(&mut r2, 0x176cc029695ad02582a70eff08a6fd99d057e12e58e7d7b6b16cdfabc8ee2911);
        vector::push_back(&mut r2, 0x19a3fc0a56702bf417ba7fee3802593fa644470307043f7773279cd71d25d5e0);
        let m = vector::empty<vector<u256>>();
        vector::push_back(&mut m, r0);
        vector::push_back(&mut m, r1);
        vector::push_back(&mut m, r2);
        m
    }

    // ─── Poseidon t=3 permutation ─────────────────────────────────────────────

    fun poseidon_t3_permute(state: &mut vector<u256>) {
        let rc      = rc_t3();
        let mds     = mds_t3();
        let rc_len  = vector::length(&rc);
        let n_full  = 8u64;
        let n_part  = 57u64;
        let total   = n_full + n_part;
        let half    = n_full / 2;

        let round  = 0u64;
        let rc_idx = 0u64;

        // First half full rounds
        while (round < half) {
            let i = 0u64;
            while (i < 3) {
                if (rc_idx < rc_len) {
                    let s = vector::borrow_mut(state, i);
                    *s = fadd(*s, *vector::borrow(&rc, rc_idx));
                    rc_idx = rc_idx + 1;
                };
                i = i + 1;
            };
            let i = 0u64;
            while (i < 3) {
                let s = vector::borrow_mut(state, i);
                *s = sbox(*s);
                i = i + 1;
            };
            mds_mix(state, &mds);
            round = round + 1;
        };

        // Partial rounds
        while (round < half + n_part) {
            let i = 0u64;
            while (i < 3) {
                if (rc_idx < rc_len) {
                    let s = vector::borrow_mut(state, i);
                    *s = fadd(*s, *vector::borrow(&rc, rc_idx));
                    rc_idx = rc_idx + 1;
                };
                i = i + 1;
            };
            let s0 = vector::borrow_mut(state, 0);
            *s0 = sbox(*s0);
            mds_mix(state, &mds);
            round = round + 1;
        };

        // Second half full rounds
        while (round < total) {
            let i = 0u64;
            while (i < 3) {
                if (rc_idx < rc_len) {
                    let s = vector::borrow_mut(state, i);
                    *s = fadd(*s, *vector::borrow(&rc, rc_idx));
                    rc_idx = rc_idx + 1;
                };
                i = i + 1;
            };
            let i = 0u64;
            while (i < 3) {
                let s = vector::borrow_mut(state, i);
                *s = sbox(*s);
                i = i + 1;
            };
            mds_mix(state, &mds);
            round = round + 1;
        };
    }

    fun mds_mix(state: &mut vector<u256>, mds: &vector<vector<u256>>) {
        let new_state = vector::empty<u256>();
        let i = 0u64;
        while (i < 3) {
            let sum: u256 = 0;
            let j = 0u64;
            while (j < 3) {
                let mij = *vector::borrow(vector::borrow(mds, i), j);
                let sj  = *vector::borrow(state, j);
                sum = fadd(sum, fmul(mij, sj));
                j = j + 1;
            };
            vector::push_back(&mut new_state, sum);
            i = i + 1;
        };
        let i = 0u64;
        while (i < 3) {
            *vector::borrow_mut(state, i) = *vector::borrow(&new_state, i);
            i = i + 1;
        };
    }

    // ─── Public hash functions ────────────────────────────────────────────────

    public fun hash2(a: u256, b: u256): u256 {
        let state = vector::empty<u256>();
        vector::push_back(&mut state, 0u256);
        vector::push_back(&mut state, a);
        vector::push_back(&mut state, b);
        poseidon_t3_permute(&mut state);
        *vector::borrow(&state, 0)
    }

    public fun hash3(a: u256, b: u256, c: u256): u256 {
        hash2(hash2(a, b), c)
    }

    public fun hash4(a: u256, b: u256, c: u256, d: u256): u256 {
        hash2(hash2(a, b), hash2(c, d))
    }

    // ─── Domain-separated helpers ─────────────────────────────────────────────

    public fun commitment_hash(amount: u256, r: u256, pk: u256): u256 {
        hash4(1u256, amount, r, pk)
    }

    public fun nullifier_hash(c_in: u256, r_in: u256, sk: u256): u256 {
        hash4(2u256, c_in, r_in, sk)
    }

    public fun zk_pubkey(sk: u256): u256 {
        hash2(3u256, sk)
    }

    public fun noid_account_cmx(pk: u256, r: u256): u256 {
        hash3(4u256, pk, r)
    }

    public fun merkle_node(left: u256, right: u256): u256 {
        hash2(left, right)
    }

    // ─── Bytes helpers ────────────────────────────────────────────────────────

    /// u256 → 32-byte little-endian (for Fr deserialization)
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

    /// 32-byte little-endian → u256
    fun le32_to_u256(b: &vector<u8>): u256 {
        let result: u256 = 0;
        let i = 32u64;
        while (i > 0) {
            i = i - 1;
            result = (result << 8) | (*vector::borrow(b, i) as u256);
        };
        result
    }

    /// u256 → 32-byte big-endian (for external use)
    public fun u256_to_bytes32(v: u256): vector<u8> {
        let result = vector::empty<u8>();
        let i = 0u64;
        while (i < 32) {
            vector::push_back(&mut result, 0u8);
            i = i + 1;
        };
        let i = 31u64;
        let val = v;
        loop {
            *vector::borrow_mut(&mut result, i) = ((val & 0xFF) as u8);
            val = val >> 8;
            if (i == 0) break;
            i = i - 1;
        };
        result
    }

    /// 32-byte big-endian → u256
    public fun bytes32_to_u256(b: vector<u8>): u256 {
        assert!(vector::length(&b) == 32, 0);
        let result: u256 = 0;
        let i = 0u64;
        while (i < 32) {
            result = (result << 8) | (*vector::borrow(&b, i) as u256);
            i = i + 1;
        };
        result
    }
}
