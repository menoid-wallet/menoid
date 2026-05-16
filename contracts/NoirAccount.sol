// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

/* 
NoirAccount is created on behalf of the user privately. 
the owner of this contract is set as a commitment. (not an address)

User initially creates the NoirAccount privately by sending the commitment, private notes to the relayer.
Relayer deployes that NoirAccount on behalf of the user, collecting the fees privately.
User submits the targetContract, value, data (i.e pararmeters) , zkProof - proving he owns that commmitment.
to the Relayer.
Relayer calls the execute function with the required parameters + zkProof.
the modifier will check wether the proof binds correctly to the commitment or not (to check the ownership).
and the function gets executed.
*/

/* 
Testing NoirAccount,
For now its only public owner. 
*/

contract NoirAccount is IERC721Receiver, IERC1155Receiver {
    address public user; // this will be replaced by ownership commitment.


    modifier onlyUser() {
        require(msg.sender == user, "Not the user");// this will be replaced by proof verification for ownership commitment.
        _;
    }


    event Executed(
        address indexed target,
        uint256 value,
        bytes data,
        bytes result
    );

    constructor(address _user) {
        user = _user;
    }

    function executed(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyUser returns (bytes memory result){
        require(target != address(0), "No address, Please provide valid address");

        (bool success, bytes memory res) =
            target.call{value: value}(data);
        
        require(success, "Execution failed");

        emit Executed(target, value, data, result);

        return res;
    }

    function onERC721Received (
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) external pure override returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId;
    }

    receive() external payable {}
}