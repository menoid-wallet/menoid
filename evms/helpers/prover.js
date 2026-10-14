const path = require("path");
const snarkjs = require("snarkjs");

/**
 * Groth16 proving for the two v1-mainnet circuits.
 * Artifacts come from scripts/build_circuits.sh (build/v1m/).
 */

const BUILD_DIR = path.join(__dirname, "..", "build", "v1m");

const CIRCUITS = {
    transfer: {
        wasm: path.join(BUILD_DIR, "transfer_proof_js", "transfer_proof.wasm"),
        zkey: path.join(BUILD_DIR, "transfer_proof_final.zkey"),
        vkey: path.join(BUILD_DIR, "transfer_verification_key.json")
    },
    withdraw: {
        wasm: path.join(BUILD_DIR, "withdraw_proof_js", "withdraw_proof.wasm"),
        zkey: path.join(BUILD_DIR, "withdraw_proof_final.zkey"),
        vkey: path.join(BUILD_DIR, "withdraw_verification_key.json")
    }
};

// snarkjs wants decimal strings
function stringify(value) {
    if (Array.isArray(value)) return value.map(stringify);
    if (typeof value === "bigint" || typeof value === "number") return value.toString();
    return value;
}

// snarkjs proof -> the (a, b, c) the Solidity verifier takes (G2 coordinates swapped)
function toSolidityProof(proof) {
    return {
        a: [proof.pi_a[0], proof.pi_a[1]],
        b: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]]
        ],
        c: [proof.pi_c[0], proof.pi_c[1]]
    };
}

// Throws if the witness does not satisfy the circuit (e.g. value not conserved).
async function prove(circuit, input) {
    const { wasm, zkey } = CIRCUITS[circuit];
    const circuitInput = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, stringify(v)]));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, wasm, zkey);
    return {
        proof: toSolidityProof(proof),
        rawProof: proof,
        publicSignals: publicSignals.map((s) => BigInt(s))
    };
}

// off-chain check, e.g. a relayer's gate before it pays gas
async function verifyOffChain(circuit, publicSignals, rawProof) {
    const vkey = require(CIRCUITS[circuit].vkey);
    return snarkjs.groth16.verify(vkey, publicSignals.map(String), rawProof);
}

// snarkjs keeps worker threads alive; release them so the process can exit
async function shutdownProver() {
    const curve = globalThis.curve_bn128;
    if (curve) {
        await curve.terminate();
        delete globalThis.curve_bn128;
    }
}

module.exports = {
    CIRCUITS,
    prove,
    verifyOffChain,
    shutdownProver
};
