// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Interfaces.sol";

library PoolLib {
    // constants
    uint32 public constant TREE_DEPTH = 20;
    uint32 public constant ROOT_HISTORY_SIZE = 10;
    uint32 public constant MAX_LEAF = uint32(1) << TREE_DEPTH; // 2**20 value

    struct Pool {
        bytes32[TREE_DEPTH] zeros; // the zeros are used to know the value of Z0, Z1, Z2 (i.e the zero hash value of each level)
        bytes32[TREE_DEPTH] filledSubtrees; // Stores the latest filled LEFT subtree hash at each tree level
        // its an optimistic approach to compute the root
        // explanantion of filled subtrees is provided at notes/filled_subtress.txt
        bytes32 root; //the current root
        bytes32[ROOT_HISTORY_SIZE] rootHistory; // stores the recent history of roots , so the system allows mempool delays to improve UX.
        uint32 rootPtr; // where next root is to be inserted in the circular root history
        uint32 nextIdx; // where next leaf insertion should happen
        mapping(bytes32 => bool) validRoot; //fast membership check for acceptable roots
        // O(1) lookup wether the root is still valid (i.e still in root history) or not
    }


    function createPool(        
        Pool[] storage pools,
        IPoseidon poseidon
        ) internal returns (uint256 poolId) {
        Pool storage p = pools.push();
        bytes32 zero = bytes32(0);

        for (uint8 i = 0; i < TREE_DEPTH; i++) {
            p.zeros[i] = zero; // the Z0,Z1,Z2 ...
            p.filledSubtrees[i] = zero; // inital zero tree
            zero = bytes32(poseidon.poseidon([uint256(zero), uint256(zero)])); // Z1 = hash(Z0,Z0) ... Z20 = hash(Z19,Z19)
        }

        p.root = zero; // Z20
        p.rootHistory[0] = zero;
        p.rootPtr = 0;
        p.nextIdx = 0;
        p.validRoot[zero] = true;

        return pools.length - 1;
    }

    // returns current pool
    function currentPool(
        Pool[] storage pools
    ) internal view returns (Pool storage) {
        return pools[pools.length - 1];
    }

        //update pool for commitment
    function updatePool(
        Pool storage p,
        bytes32 commitment,
        IPoseidon poseidon
        ) internal {
        bytes32 current = commitment;
        uint256 idx = p.nextIdx;
        require(p.nextIdx < MAX_LEAF, "Pool full");
        p.nextIdx++; // update the next index
        // compute the root
        for (uint16 i = 0; i < TREE_DEPTH; i++) {
            // idx & 1 -> extracts lsb and & 1 decides odd or even
            if ((idx & 1) == 0) {
                // even -> the current one is left
                // so add it to the subtree, compute hash with zero[i](i.e Zi -> refere notes/filled_subtrees.txt)
                p.filledSubtrees[i] = current;
                current = bytes32(
                    poseidon.poseidon([uint256(current), uint256(p.zeros[i])])
                );
            } else {
                // odd -> the current one is right
                // so hash it with present value of the subtree
                current = bytes32(
                    poseidon.poseidon(
                        [uint256(p.filledSubtrees[i]), uint256(current)]
                    )
                );
            }
            idx >>= 1; // shifts 1 bit
        }
        p.root = current; //update root
    }

    function pushRoot(Pool storage p, bytes32 newRoot) internal {
        // current root
        bytes32 oldRoot = p.rootHistory[p.rootPtr]; // old root at that position
        if (oldRoot != bytes32(0)) {
            p.validRoot[oldRoot] = false; // old root no more a valid root
        }

        p.rootHistory[p.rootPtr] = newRoot; // store new root in the history
        p.validRoot[newRoot] = true; // new root in valid roots
        p.rootPtr = (p.rootPtr + 1) % ROOT_HISTORY_SIZE; // increament root ptr (i.e where next root will be inserted)
    }
   
}