// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "poseidon-solidity/PoseidonT3.sol";

contract PoseidonHasher {
    function poseidon(
        uint256[2] calldata input
    ) external pure returns (uint256) {
        return PoseidonT3.hash([input[0], input[1]]);
    }
}
