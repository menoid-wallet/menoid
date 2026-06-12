/**
 * proofToBytes_FIX.ts
 *
 * Drop-in replacement for the `proofToBytes` function in noid_pool.test.ts.
 *
 * WHY: Sui's groth16::proof_points_from_bytes expects Arkworks
 * CanonicalSerialize COMPRESSED points (128 bytes total), the same
 * little-endian + flag rules as the verification key — NOT the 256-byte
 * uncompressed concatenation the old helper produced.
 *
 *   pi_a : G1 compressed  (32 bytes)
 *   pi_b : G2 compressed  (64 bytes)
 *   pi_c : G1 compressed  (32 bytes)
 *   total                 (128 bytes)
 *
 * Replace the existing `proofToBytes` (and its `ProofCalldata` usage stays
 * the same: it still returns { proofBytes: Uint8Array }). Nothing else in
 * the test file changes — the signal vectors you pass to pool::transfer /
 * pool::withdraw are untouched.
 */

// BN254 base-field prime Fq (point coordinates).
const FQ = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");

interface ProofCalldata {
  proofBytes: Uint8Array; // 128 bytes, Arkworks-compressed LE
}

function toLE32(val: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let v = val;
  for (let i = 0; i < 32; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}

function g1Compress(x: bigint, y: bigint): Buffer {
  const buf = toLE32(x);
  const yIsNeg = y > (FQ - y);
  buf[31] = (buf[31] & 0x3f) | (yIsNeg ? 0x80 : 0x00);
  return buf;
}

function g2Compress(xc0: bigint, xc1: bigint, yc0: bigint, yc1: bigint): Buffer {
  const negYc1 = yc1 === 0n ? 0n : FQ - yc1;
  const negYc0 = yc0 === 0n ? 0n : FQ - yc0;
  const yIsNeg = yc1 > negYc1 || (yc1 === negYc1 && yc0 > negYc0);
  const c0buf = toLE32(xc0);
  const c1buf = toLE32(xc1);
  c1buf[31] = (c1buf[31] & 0x3f) | (yIsNeg ? 0x80 : 0x00);
  return Buffer.concat([c0buf, c1buf]);
}

/**
 * Encode a snarkjs Groth16 proof for Sui.
 *
 * snarkjs proof shape:
 *   pi_a = [x, y, "1"]
 *   pi_b = [[x0, x1], [y0, y1], ["1","0"]]   (Fq2 elements)
 *   pi_c = [x, y, "1"]
 */
export function proofToBytes(proof: any): ProofCalldata {
  const a = g1Compress(BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1]));
  const b = g2Compress(
    BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1]),
    BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1]),
  );
  const c = g1Compress(BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1]));
  const out = Buffer.concat([a, b, c]); // 128 bytes
  return { proofBytes: new Uint8Array(out) };
}