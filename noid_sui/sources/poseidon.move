/// Poseidon hash over BN254 scalar field — Sui port.
module noid::poseidon {

    use std::vector;

    public fun hash2(a: u256, b: u256): u256 {
        let mut inputs = vector[];
        vector::push_back(&mut inputs, a);
        vector::push_back(&mut inputs, b);
        sui::poseidon::poseidon_bn254(&inputs)
    }

    public fun hash3(a: u256, b: u256, c: u256): u256 {
        hash2(hash2(a, b), c)
    }

    public fun hash4(a: u256, b: u256, c: u256, d: u256): u256 {
        hash2(hash2(a, b), hash2(c, d))
    }

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

    public fun u256_to_le32(v: u256): vector<u8> {
        let mut out = vector[];
        let mut val = v;
        let mut i = 0u64;
        while (i < 32) {
            vector::push_back(&mut out, ((val & 0xFF) as u8));
            val = val >> 8;
            i = i + 1;
        };
        out
    }

    public fun le32_to_u256(b: &vector<u8>): u256 {
        let mut result: u256 = 0;
        let mut i = 32u64;
        while (i > 0) {
            i = i - 1;
            result = (result << 8) | (*vector::borrow(b, i) as u256);
        };
        result
    }

    public fun u256_to_bytes32(v: u256): vector<u8> {
        let mut result = vector[];
        let mut i = 0u64;
        while (i < 32) {
            vector::push_back(&mut result, 0u8);
            i = i + 1;
        };
        let mut i = 31u64;
        let mut val = v;
        loop {
            *vector::borrow_mut(&mut result, i) = ((val & 0xFF) as u8);
            val = val >> 8;
            if (i == 0) break;
            i = i - 1;
        };
        result
    }

    public fun bytes32_to_u256(b: vector<u8>): u256 {
        assert!(vector::length(&b) == 32, 0);
        let mut result: u256 = 0;
        let mut i = 0u64;
        while (i < 32) {
            result = (result << 8) | (*vector::borrow(&b, i) as u256);
            i = i + 1;
        };
        result
    }

    #[test]
    fun test_native_poseidon() {
        let a = 12345u256;
        let b = 67890u256;

        let mut inputs = vector[];
        vector::push_back(&mut inputs, a);
        vector::push_back(&mut inputs, b);
        let h_native = sui::poseidon::poseidon_bn254(&inputs);

        let expected = 11344094074881186137859743404234365978119253787583526441303892667757095072923u256;
        std::debug::print(&h_native);
        assert!(h_native == expected, 101);
    }
}
