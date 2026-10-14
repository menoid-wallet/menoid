// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../NoidPool.sol";

// Upgrade-test implementations — local network only.

// A well-formed next version: everything NoidPool has, plus one new variable
// appended after NoidPool's storage and a new function. The proxy was already
// initialized as v1 and v2 has nothing new to initialize, so it has no
// initializer of its own (a real v2 that needs setup adds `reinitializer(2)`).
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract NoidPoolV2Mock is NoidPool {
    uint256 public newFeatureValue;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address transferVerifier_, address withdrawVerifier_, address wrappedNative_)
        NoidPool(transferVerifier_, withdrawVerifier_, wrappedNative_)
    {}

    function version() external pure override returns (string memory) {
        return "2.0.0";
    }

    function setNewFeatureValue(uint256 value) external onlyOwner {
        newFeatureValue = value;
    }
}

// A broken next version: its base puts a new variable BEFORE NoidPool's
// storage, shifting every slot. The upgrades plugin must refuse it.
contract StorageShifter {
    uint256 public injected;
}

/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract NoidPoolBadLayoutMock is StorageShifter, NoidPool {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address transferVerifier_, address withdrawVerifier_, address wrappedNative_)
        NoidPool(transferVerifier_, withdrawVerifier_, wrappedNative_)
    {}
}
