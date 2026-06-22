import { buildPoseidon } from "circomlibjs";
import { IncrementalMerkleTree } from "@zk-kit/incremental-merkle-tree";
import * as snarkjs from "snarkjs";
import * as fs from "fs";

const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (a,b) => BigInt(F.toString(poseidon([a,b])));
const treeHash = (arr) => H(arr[0], arr[1]);
const DEPTH = 20;
let z = 0n; const zeros = [];
for (let i=0;i<DEPTH;i++){ zeros.push(z); z = H(z,z); }

function insert(subtrees, leaf, idx) {
  const newSub = subtrees.slice();
  let cur = leaf;
  for (let i=0;i<DEPTH;i++){
    if (((idx >> i) & 1) === 0) { newSub[i] = cur; cur = H(cur, zeros[i]); }
    else { cur = H(subtrees[i], cur); }
  }
  return { newRoot: cur, newSubtrees: newSub };
}

const zk = new IncrementalMerkleTree(treeHash, DEPTH, 0n, 2);
let subtrees = zeros.slice();
const leaves = [111n, 222n, 333n];
let okAll = true;
for (let i=0;i<leaves.length;i++){
  const r = insert(subtrees, leaves[i], i);
  zk.insert(leaves[i]);
  const match = r.newRoot === BigInt(zk.root.toString());
  okAll = okAll && match;
  console.log(`insert ${i}: jsRoot==zkRoot? ${match}`);
  subtrees = r.newSubtrees;
}
console.log("ALL js==zk:", okAll);

const leaf = 444n, idx = 3;
const expected = insert(subtrees, leaf, idx);
const input = { oldSubtrees: subtrees.map(String), commitment: leaf.toString(), leafIndex: String(idx) };
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  input, "zk_build/new_root_js/new_root.wasm", "zk_build/new_root_final.zkey");
const vkey = JSON.parse(fs.readFileSync("zk_build/new_root_verification_key.json"));
const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
console.log("\nproof verifies:", verified);
console.log("publicSignals.length:", publicSignals.length, "(expect 43)");
console.log("newRoot match :", publicSignals[0] === expected.newRoot.toString());
console.log("newSub[0] match:", publicSignals[1] === expected.newSubtrees[0].toString());
console.log("oldSub[0]@[21] :", publicSignals[21] === subtrees[0].toString());
console.log("commitment@[41]:", publicSignals[41] === leaf.toString());
console.log("leafIndex@[42] :", publicSignals[42] === String(idx));
