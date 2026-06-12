/// Groth16 proof verifier for the noid privacy protocol — Sui port.
module noid::verifier {

    use std::vector;
    use sui::groth16;

    const E_NOT_INITIALIZED: u64 = 2;
    const E_BAD_SIGNAL_COUNT: u64 = 4;

    public struct VerifierConfig has key {
        id:           sui::object::UID,
        admin:        address,
        dep_pvk:      groth16::PreparedVerifyingKey,
        tra_pvk:      groth16::PreparedVerifyingKey,
        wit_pvk:      groth16::PreparedVerifyingKey,
    }

    public entry fun initialize_vks(
        dep_vk_bytes: vector<u8>,
        tra_vk_bytes: vector<u8>,
        wit_vk_bytes: vector<u8>,
        ctx:          &mut sui::tx_context::TxContext,
    ) {
        let curve  = groth16::bn254();
        let dep_pvk = groth16::prepare_verifying_key(&curve, &dep_vk_bytes);
        let tra_pvk = groth16::prepare_verifying_key(&curve, &tra_vk_bytes);
        let wit_pvk = groth16::prepare_verifying_key(&curve, &wit_vk_bytes);
        let config  = VerifierConfig {
            id:      sui::object::new(ctx),
            admin:   sui::tx_context::sender(ctx),
            dep_pvk,
            tra_pvk,
            wit_pvk,
        };
        sui::transfer::share_object(config);
    }

    public entry fun reinitialize_vks(
        config:       &mut VerifierConfig,
        dep_vk_bytes: vector<u8>,
        tra_vk_bytes: vector<u8>,
        wit_vk_bytes: vector<u8>,
        ctx:          &sui::tx_context::TxContext,
    ) {
        assert!(config.admin == sui::tx_context::sender(ctx), E_NOT_INITIALIZED);
        let curve   = groth16::bn254();
        config.dep_pvk = groth16::prepare_verifying_key(&curve, &dep_vk_bytes);
        config.tra_pvk = groth16::prepare_verifying_key(&curve, &tra_vk_bytes);
        config.wit_pvk = groth16::prepare_verifying_key(&curve, &wit_vk_bytes);
    }

    public fun verify_deposit(
        config:         &VerifierConfig,
        proof_bytes:    &vector<u8>,
        public_signals: &vector<u256>,
    ): bool {
        assert!(vector::length(public_signals) == 4, E_BAD_SIGNAL_COUNT);
        let curve         = groth16::bn254();
        let inputs_bytes  = pack_signals(public_signals);
        let public_inputs = groth16::public_proof_inputs_from_bytes(inputs_bytes);
        let proof_points  = groth16::proof_points_from_bytes(*proof_bytes);
        groth16::verify_groth16_proof(&curve, &config.dep_pvk, &public_inputs, &proof_points)
    }

    public fun verify_transfer(
        config:         &VerifierConfig,
        proof_bytes:    &vector<u8>,
        public_signals: &vector<u256>,
    ): bool {
        assert!(vector::length(public_signals) == 6, E_BAD_SIGNAL_COUNT);
        let curve         = groth16::bn254();
        let inputs_bytes  = pack_signals(public_signals);
        let public_inputs = groth16::public_proof_inputs_from_bytes(inputs_bytes);
        let proof_points  = groth16::proof_points_from_bytes(*proof_bytes);
        groth16::verify_groth16_proof(&curve, &config.tra_pvk, &public_inputs, &proof_points)
    }

    public fun verify_withdraw(
        config:         &VerifierConfig,
        proof_bytes:    &vector<u8>,
        public_signals: &vector<u256>,
    ): bool {
        assert!(vector::length(public_signals) == 8, E_BAD_SIGNAL_COUNT);
        let curve         = groth16::bn254();
        let inputs_bytes  = pack_signals(public_signals);
        let public_inputs = groth16::public_proof_inputs_from_bytes(inputs_bytes);
        let proof_points  = groth16::proof_points_from_bytes(*proof_bytes);
        groth16::verify_groth16_proof(&curve, &config.wit_pvk, &public_inputs, &proof_points)
    }

    fun pack_signals(signals: &vector<u256>): vector<u8> {
        let mut out = vector[];
        let mut i   = 0u64;
        let n       = vector::length(signals);
        while (i < n) {
            let s    = *vector::borrow(signals, i);
            let bytes = u256_to_le32(s);
            let mut j = 0u64;
            while (j < 32) {
                vector::push_back(&mut out, *vector::borrow(&bytes, j));
                j = j + 1;
            };
            i = i + 1;
        };
        out
    }

    fun u256_to_le32(v: u256): vector<u8> {
        let mut out = vector[];
        let mut val = v;
        let mut i   = 0u64;
        while (i < 32) {
            vector::push_back(&mut out, ((val & 0xFF) as u8));
            val = val >> 8;
            i   = i + 1;
        };
        out
    }
}
