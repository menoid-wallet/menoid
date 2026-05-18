// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./NoidAccount.sol";
import "./NoidPool.sol";

import "./libraries/Interfaces.sol";
import "./libraries/Types.sol";

contract NoidAccountManager {

    bytes32 public constant ZERO_COMMITMENT = bytes32(0);

    // core pool
    NoidPool public immutable noidPool;

    // verifiers
    ICreateNoidAccountVerifier public immutable createNoidAccountVerifier;
    IExecuteFunctionCallVerifier public immutable executeFunCallVerifier;
    INoidAccountOwnershipVerifier public immutable noidAccountOwnershipVerifier;

    // relayer
    uint256 public immutable relayerZkPubkey;

    // ownership commitments -> noid accounts
    mapping(bytes32 => address) public noidAccounts;

    // events
    event NoidAccountCreated(
        bytes32 commitment,
        bytes encryptedNote
    );

    constructor(
        address _noidPool,
        address _createNoidAccountVerifier,
        address _executeFunCallVerifier,
        address _ownershipVerifier,
        uint256 _relayerZkPubkey
    ) {
        noidPool = NoidPool(payable(_noidPool));

        createNoidAccountVerifier =
            ICreateNoidAccountVerifier(
                _createNoidAccountVerifier
            );

        executeFunCallVerifier =
            IExecuteFunctionCallVerifier(
                _executeFunCallVerifier
            );

        noidAccountOwnershipVerifier =
            INoidAccountOwnershipVerifier(
                _ownershipVerifier
            );

        relayerZkPubkey = _relayerZkPubkey;
    }

    function _singleCreateNACall(
        CreateNoidAccountCall calldata call, 
        bytes32 cmx
    ) 
    internal 
    {
        
     }

    function verifyCreateAccount(
        CreateNoidAccountCall calldata call ,
        bytes32 cmx
    ) external view returns (uint8, bytes32[] memory) {
        // public signals to be added
        // relayer, - 1
        // enabled, - MAX_INPUTS
        // roots,   - MAX_INPUTS
        // nullifiers, - MAX_INPUTS
        // out_enabled, - 2
        // c_outs - 2
        // cmx - 1

        uint256[18] memory publicSignals;
        uint8 idx = 0;
        publicSignals[idx++] = relayerZkPubkey;
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            publicSignals[idx++] = uint256(call.inputs.enabled[i]);
        }
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            publicSignals[idx++] = uint256(call.inputs.roots[i]);
        }
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            publicSignals[idx++] = uint256(call.inputs.nullifiers[i]);
        }

        // outputs enabled
        bytes32[] memory tempOutCmx = new bytes32[](2);
        uint8 cmxCount = 0;
        if (call.C1 != ZERO_COMMITMENT) {
            publicSignals[idx++] = 1;
            tempOutCmx[cmxCount++] = call.C1;
        } else {
            publicSignals[idx++] = 0;
        }

        if (call.C2 != ZERO_COMMITMENT) {
            publicSignals[idx++] = 1;
            tempOutCmx[cmxCount++] = call.C2;
        } else {
            publicSignals[idx++] = 0;
        }

        // c_outs
        publicSignals[idx++] = uint256(call.C1);
        publicSignals[idx++] = uint256(call.C2);

        // commitment of Noid Account
        publicSignals[idx++] = uint256(cmx);

        // proof verification
        require(
            createNoidAccountVerifier.verifyProof(call.a, call.b, call.c, publicSignals),
            "Noid Account creation proof verification failed"
        );

        return (cmxCount,tempOutCmx);
    }
}
