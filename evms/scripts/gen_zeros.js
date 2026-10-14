/**
 * Prints the zero-subtree roots for the pool's Merkle tree as a Solidity
 * function, for contracts/libraries/poolLib.sol.
 *
 *   zeros(0)  = 0                      (an empty leaf)
 *   zeros(i)  = Poseidon(zeros(i-1), zeros(i-1))
 *
 * Re-run only if TREE_DEPTH or the hash changes:
 *
 *   node scripts/gen_zeros.js
 */
const circomlibjs = require("circomlibjs");

const TREE_DEPTH = 20;

async function main() {
    const poseidon = await circomlibjs.buildPoseidon();
    const hash = (a, b) => BigInt(poseidon.F.toString(poseidon([a, b])));

    const lines = [];
    let z = 0n;
    lines.push("    function zeros(uint256 level) internal pure returns (bytes32) {");
    for (let i = 0; i <= TREE_DEPTH; i++) {
        const hex = "0x" + z.toString(16).padStart(64, "0");
        lines.push(`        if (level == ${i}) return ${hex};`);
        z = hash(z, z);
    }
    lines.push('        revert("Level out of range");');
    lines.push("    }");
    console.log(lines.join("\n"));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
