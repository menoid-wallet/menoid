// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

/* 
NoirAccount is the Private Identity of the user. 
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

interface INoirAccountOwnershipVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[6] calldata publicSignals
    ) external view returns (bool);
}

contract NoirAccount is IERC721Receiver, IERC1155Receiver {
    bytes32 public commitment;
    uint256 public nonce; // to protect from the phishing using the same proof.
    INoirAccountOwnershipVerifier public immutable noirAccountOwnershipVerifier;
    uint256 internal constant SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function _verifyOwnership(
        bytes32 callCmx,  
        address target,
        uint256 value,
        bytes calldata data,       
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
        ) internal view  {
        uint256 dataHash = uint256(keccak256(data)) % SNARK_SCALAR_FIELD; 
        uint256[6] memory publicSignals; 
        publicSignals[0] = uint256(commitment); 
        publicSignals[1] = uint256(callCmx); 
        publicSignals[2] = nonce; 
        publicSignals[3] = uint256(uint160(target)); 
        publicSignals[4] = value; 
        publicSignals[5] = dataHash;

        require(noirAccountOwnershipVerifier.verifyProof(a, b, c, publicSignals),"Noir Account ownership verification failed");
    }


    event Executed(
        address indexed target,
        uint256 value,
        bytes data,
        bytes result
    );

    constructor(bytes32 _commitment, INoirAccountOwnershipVerifier _verifier) {
        commitment = _commitment;
        noirAccountOwnershipVerifier = _verifier;
    }

    function execute(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 callCommitment,
        // zkproof
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external payable returns (bytes memory result){
        require(target != address(0), "No address, Please provide valid address");
        _verifyOwnership(callCommitment,target,value,data,a,b,c);
        (bool success, bytes memory res) =
            target.call{value: value}(data);
        
        require(success, "Execution failed");

        emit Executed(target, value, data, res);
        nonce++;

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