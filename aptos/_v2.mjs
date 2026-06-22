import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import * as fs from "fs";
const p = await buildPoseidon(); const F=p.F;
const H=(a,b)=>BigInt(F.toString(p([a,b])));
const D=20; let z=0n; const zeros=[]; for(let i=0;i<D;i++){zeros.push(z);z=H(z,z);}
const fold=(a)=>{let acc=a[0];for(let i=1;i<D;i++)acc=H(acc,a[i]);return acc;};
function insert(sub,leaf,idx){const ns=sub.slice();let cur=leaf;for(let i=0;i<D;i++){if(((idx>>i)&1)===0){ns[i]=cur;cur=H(cur,zeros[i]);}else{cur=H(sub[i],cur);}}return{newRoot:cur,newSub:ns};}
// insert leaf 555 at idx 0 (empty tree)
const sub=zeros.slice(), leaf=555n, idx=0;
const exp=insert(sub,leaf,idx);
const input={oldSubtreesHash:fold(sub).toString(),commitment:leaf.toString(),leafIndex:String(idx),oldSubtrees:sub.map(String)};
const {proof,publicSignals}=await snarkjs.groth16.fullProve(input,"zk_build/new_root_js/new_root.wasm","zk_build/new_root_final.zkey");
const vk=JSON.parse(fs.readFileSync("zk_build/new_root_verification_key.json"));
console.log("verify:", await snarkjs.groth16.verify(vk,publicSignals,proof));
console.log("len:", publicSignals.length, "(expect 5)");
console.log("[0] newRoot match:", publicSignals[0]===exp.newRoot.toString());
console.log("[1] newSubtreesHash match:", publicSignals[1]===fold(exp.newSub).toString());
console.log("[2] oldSubtreesHash match:", publicSignals[2]===fold(sub).toString());
console.log("[3] commitment:", publicSignals[3]===leaf.toString(), "[4] leafIndex:", publicSignals[4]===String(idx));
