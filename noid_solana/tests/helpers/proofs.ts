const FQ = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");

export function toBE32(valStr: string): Buffer {
  const val = BigInt(valStr);
  const buf = Buffer.alloc(32);
  let temp = val;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return buf;
}

export function formatProofForSolana(proof: any) {
  // Negate Y coordinate of G1 point A
  const xA = BigInt(proof.pi_a[0]);
  const yA = BigInt(proof.pi_a[1]);
  const negYA = yA === 0n ? 0n : FQ - yA;
  const proofA = Buffer.concat([toBE32(xA.toString()), toBE32(negYA.toString())]);

  // G2 point B: [ [X0, X1], [Y0, Y1] ] -> X1, X0, Y1, Y0 (imaginary-first layout expected by Solana precompile)
  const proofB = Buffer.concat([
    toBE32(proof.pi_b[0][1]),
    toBE32(proof.pi_b[0][0]),
    toBE32(proof.pi_b[1][1]),
    toBE32(proof.pi_b[1][0]),
  ]);

  // G1 point C: [X, Y]
  const proofC = Buffer.concat([
    toBE32(proof.pi_c[0]),
    toBE32(proof.pi_c[1]),
  ]);

  return {
    proofA: Array.from(proofA),
    proofB: Array.from(proofB),
    proofC: Array.from(proofC),
  };
}
