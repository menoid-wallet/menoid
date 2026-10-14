#!/usr/bin/env bash
#
# Builds the v1-mainnet circuits and Solidity verifiers.
#
#   circuits/transfer_proof.circom  -> contracts/TransferVerifier.sol
#   circuits/withdraw_proof.circom  -> contracts/WithdrawVerifier.sol
#
# Artifacts go to build/v1m/ so the V1 demo artifacts in build/ stay untouched.
#
# !! DEVELOPMENT SETUP ONLY !!
# The phase-2 step below is a single local contribution. Whoever runs it could
# forge proofs. Mainnet needs a multi-party phase-2 ceremony on these circuits
# (see notes/CircomToVerifiers.txt).
#
# Usage:  bash scripts/build_circuits.sh            (both circuits)
#         bash scripts/build_circuits.sh transfer   (one circuit)

set -euo pipefail
cd "$(dirname "$0")/.."

PTAU="ptau/powersOfTau28_hez_final_17.ptau"
OUT="build/v1m"
SNARKJS="npx --no-install snarkjs"

if [ ! -f "$PTAU" ]; then
    echo "missing $PTAU — see notes/CircomToVerifiers.txt (STEP 2)" >&2
    exit 1
fi

mkdir -p "$OUT"

build() {
    local name="$1"        # transfer | withdraw
    local contract="$2"    # TransferVerifier | WithdrawVerifier
    local circuit="${name}_proof"

    echo "==> compiling ${circuit}"
    # --O2 substitutes away every linear constraint (~60k -> ~27k): faster proving
    circom "circuits/${circuit}.circom" --O2 --r1cs --wasm --sym -o "$OUT"
    $SNARKJS r1cs info "$OUT/${circuit}.r1cs"

    echo "==> groth16 setup (${circuit})"
    $SNARKJS groth16 setup "$OUT/${circuit}.r1cs" "$PTAU" "$OUT/${circuit}_0000.zkey"

    echo "==> local phase-2 contribution (${circuit}) — development only"
    $SNARKJS zkey contribute "$OUT/${circuit}_0000.zkey" "$OUT/${circuit}_final.zkey" \
        --name="local development" -e="$(openssl rand -hex 32)"

    $SNARKJS zkey export verificationkey "$OUT/${circuit}_final.zkey" "$OUT/${name}_verification_key.json"
    $SNARKJS zkey export solidityverifier "$OUT/${circuit}_final.zkey" "contracts/${contract}.sol"

    # snarkjs names every verifier Groth16Verifier
    perl -pi -e "s/contract Groth16Verifier/contract ${contract}/" "contracts/${contract}.sol"

    rm -f "$OUT/${circuit}_0000.zkey"
    echo "==> ${contract}.sol written"
}

case "${1:-all}" in
    transfer) build transfer TransferVerifier ;;
    withdraw) build withdraw WithdrawVerifier ;;
    all)
        build transfer TransferVerifier
        build withdraw WithdrawVerifier
        ;;
    *) echo "usage: $0 [transfer|withdraw|all]" >&2; exit 1 ;;
esac
