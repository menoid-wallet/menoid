pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

template MerklePath(depth){
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output computedRoot;

    component hasher[depth];

    signal left[depth];
    signal right[depth];

    signal leftA[depth];
    signal leftB[depth];

    signal rightA[depth];
    signal rightB[depth];


    signal cur[depth + 1];
    cur[0] <== leaf;

    for (var i = 0; i < depth; i++){
        hasher[i] = Poseidon(2);

        pathIndices[i] * (1 - pathIndices[i]) === 0; // constarint that checks path indices is either 0 or 1


        // if idx == 0:
        // left = cur
        // right = sibling
        //
        // if idx == 1:
        // left = sibling
        // right = cur

        leftA[i] <== (1 - pathIndices[i]) * cur[i];
        leftB[i] <== pathIndices[i] * pathElements[i];

        left[i] <== leftA[i] + leftB[i];

        rightA[i] <== pathIndices[i] * cur[i];
        rightB[i] <== (1 - pathIndices[i]) * pathElements[i];
        right[i] <== rightA[i] + rightB[i];

        hasher[i].inputs[0] <== left[i];
        hasher[i].inputs[1] <== right[i];

        cur[i + 1] <== hasher[i].out;
    }

    computedRoot <== cur[depth];
}
