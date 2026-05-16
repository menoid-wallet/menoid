// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract DemoToken is ERC20 {
    constructor() ERC20("DemoToken", "DTT") {}

    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }
}

contract DemoNFT is ERC721 {
    uint256 public nextTokenId;

    constructor() ERC721("DemoNFT", "DNFT") {}

    function mint() external {
        _mint(msg.sender, nextTokenId);
        nextTokenId++;
    }
}