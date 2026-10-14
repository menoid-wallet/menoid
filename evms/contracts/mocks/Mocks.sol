// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Test tokens for the local network only — never deployed to a live chain.

// a plain ERC-20 with configurable decimals (e.g. a 6-decimal "USDC")
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// WETH9-style wrapped native coin
contract MockWrappedNative is ERC20 {
    constructor() ERC20("Wrapped Native", "WNATIVE") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Native transfer failed");
    }
}

// burns 1% on every transfer — the pool must refuse it
contract MockFeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = amount / 100;
        super._transfer(from, to, amount - fee);
        if (fee != 0) {
            _burn(from, fee);
        }
    }
}
