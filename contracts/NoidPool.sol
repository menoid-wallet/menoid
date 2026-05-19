// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./NoidAccount.sol";
import "./libraries/Interfaces.sol";
import "./libraries/poolLib.sol";
import "./libraries/Types.sol";
import "./NoidAccountManager.sol";
/**
 * ShieldedPool
 *
 * A ZK-based UTXO-style private ETH/EVM-based-coins pool.
 *
 * - ETH or Evm-based-coins (like monad) is locked in the contract
 * - Ownership is represented by commitments (cmx)
 * - Balances, senders, receivers, and amounts are hidden
 * - Merkle trees track note existence
 * - Nullifiers prevent double-spends
 *
 * All sensitive data is handled off-chain by wallets.
 * On-chain logic only verifies cryptographic correctness.
 */
contract NoidPool {
    using PoolLib for PoolLib.Pool;
    /**
     * Wallet:
     *      Get signature from real wallet
     *      PrivateKey = H(signature("prifiwallet"))
     *      Derive:
     *          zkPublicKey = Poseidon(PrivateKey) // used for transfer
     *          encPublicKey = EC_Derive(PrivateKey) // used for encrypting notes
     */
    // zero commitment - used in the place of empty commitment (wallet must use same convention)
    bytes32 public constant ZERO_COMMITMENT = bytes32(0);

    //global state
    mapping(bytes32 => bool) public nullifierSpent;
    mapping(bytes32 => bool) public commitmentExists;
    mapping(bytes32 => address) public NoidAccounts;

    // verifiers
    IDepositVerifier public immutable depositVerifier;
    ITransferVerifier public immutable transferVerifier;
    IWithdrawVerifier public immutable withdrawVerifier;
    ICreateNoidAccountVerifier public immutable createNoidAccountVerifier;
    INoidAccountOwnershipVerifier public immutable noidAccountOwnershipVerifier;
    IExecuteFunctionCallVerifier public immutable executeFunCallVerifier;


    NoidAccountManager public noidAccountManager;

    // poseidon
    IPoseidon public immutable poseidon;

    // relayer
    address public immutable relayer;
    uint256 public immutable relayerZkPubkey;

    // events
    event NewPool(uint256 indexed poolId); //indexed-> searchable/filterable
    // we dont store the encryptedNotes on chain ( storage gas ) instead we emit them as events
    event NoteCreated(uint256 poolId, bytes32 commitment, bytes encryptedNote);
    // event for Noid account creation
    event NoidAccountCreated(bytes32 commitment, bytes encryptedNote);
    // nullfier spent
    event NullifierSpent(bytes32 nullifier);

    constructor(
        address _depositVerifier,
        address _transferVerifier,
        address _withdrawVerifier,
        address _createNoidAccountVerifier,
        address _noidAccountOwnershipVerifier,
        address _executeCallVerifier,
        address _poseidon,
        address _relayer,
        uint256 _relayerZkPubkey
    ) {
        depositVerifier = IDepositVerifier(_depositVerifier);
        transferVerifier = ITransferVerifier(_transferVerifier);
        withdrawVerifier = IWithdrawVerifier(_withdrawVerifier);
        createNoidAccountVerifier = ICreateNoidAccountVerifier(_createNoidAccountVerifier);
        noidAccountOwnershipVerifier = INoidAccountOwnershipVerifier(_noidAccountOwnershipVerifier);
        executeFunCallVerifier = IExecuteFunctionCallVerifier(_executeCallVerifier);
        poseidon = IPoseidon(_poseidon);

        relayer = _relayer;
        relayerZkPubkey = _relayerZkPubkey;
        PoolLib.createPool(pools, poseidon);
    }

    function setNoidAccountManager(address _manager) 
    external { 
        require(msg.sender == relayer, "Not relayer"); 
        require(address(noidAccountManager) == address(0), "Already set"); 
        noidAccountManager = NoidAccountManager(_manager); 
    }

    PoolLib.Pool[] public pools;

    // Depsoit
    //  * Public entry into the shielded pool.
    //  *
    //  * - ETH is sent with the transaction
    //  * - One or two commitments are created
    //  * - Commitments are inserted into the current pool(s)
    //  * - Each commitment is logged with NoteCreated
    //  *
    //  * Wallet responsibilities (off-chain):
    //  * - Choose amount + randomness
    //  * - Compute commitment(s)
    //  * - Encrypt note(s)
    //  * - Track emitted poolId + leaf index
    function deposit(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        bytes32 C1, // First commitment (required)
        bytes32 C2, // 2nd commitment   relayer  (required)
        bytes calldata encryptedNote1, // encrypted (amount, randomness) for C1
        bytes calldata encryptedNote2 // Encrypted (amount, randomness) for C2
    ) external payable {
        require(msg.value != 0, "No ethereum");

        // zero commitments are only for transfer/withdraw calls
        require(C1 != ZERO_COMMITMENT, "Invalid commitment 1");
        require(C2 != ZERO_COMMITMENT, "Invalid commitment 2");

        // commitments already exists?
        require(
            !commitmentExists[C1],
            "Commitment 1 already existing, change r value"
        );
        require(
            !commitmentExists[C2],
            "Commitment 2 already existing, change r value"
        );
        // public signals
        // deposit amount
        // c1
        // c2
        // pk2 (relayerZkPubkey)
        uint256[4] memory publicSignals;
        publicSignals[0] = msg.value;
        publicSignals[1] = uint256(C1);
        publicSignals[2] = uint256(C2);
        publicSignals[3] = relayerZkPubkey;

        // in deposit we dont need to check merkle path
        // deposit zk , proves that the amounts that are in the commitments equals deposited amount
        require(
            depositVerifier.verifyProof(a, b, c, publicSignals),
            "Deposit proof verification failed"
        );

        bytes32[] memory commitments = new bytes32[](2);
        commitments[0] = C1;
        commitments[1] = C2;

        // addition of group of commitments to be added here
        InsertedNote[] memory notesInserted = _insertBatch(commitments);
        for (uint8 i = 0; i < 2; i++) {
            InsertedNote memory note = notesInserted[i];
            if (i == 0) {
                // emit the note created event
                emit NoteCreated(note.poolId, note.commitment, encryptedNote1);
            } else {
                emit NoteCreated(note.poolId, note.commitment, encryptedNote2);
            }
        }
    }

    function verifyInputs( 
        Inputs calldata inputs 
    ) external view { 
        _verifyInputs(inputs); 
    }

    // inputs validation helper function
    function _verifyInputs(Inputs memory inputs) view internal {
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            require(
                inputs.enabled[i] * (1 - inputs.enabled[i]) == 0,
                "Invalid enable flag"
            );
            if (inputs.enabled[i] == 0) {
                continue;
            }
            require(inputs.poolIds[i] < pools.length, "Invalid poolId");
            PoolLib.Pool storage p = pools[inputs.poolIds[i]];
            require(p.validRoot[inputs.roots[i]], "Invalid root");

            require(
                !nullifierSpent[inputs.nullifiers[i]],
                "Nullifier already spent"
            );
            // all nullifiers in a Transfer inputs must be unique
            for (uint8 j = 0; j < i; j++) {
                if (inputs.enabled[j] == 0) continue;

                require(
                    inputs.nullifiers[i] != inputs.nullifiers[j],
                    "Duplicate nullifier"
                );
            }
        }
    }

    function transfer(TransferCall[] memory calls) external {
        for (uint256 i = 0; i < calls.length; i++) {
            _singleTransfer(calls[i]);
        }
    }

    function _singleTransfer(TransferCall memory call) internal {
        // validate the inputs
        _verifyInputs(call.inputs);

        // commitments duplicate check
        if (call.C1 != ZERO_COMMITMENT && call.C2 != ZERO_COMMITMENT) {
            require(call.C1 != call.C2, "Duplicate commitments");
        }

        if (call.C1 != ZERO_COMMITMENT && call.C3 != ZERO_COMMITMENT) {
            require(call.C1 != call.C3, "Duplicate commitments");
        }

        if (call.C2 != ZERO_COMMITMENT && call.C3 != ZERO_COMMITMENT) {
            require(call.C2 != call.C3, "Duplicate commitments");
        }

        // zkproof

        //required public signals
        // relayer, - 1
        // enabled,  - MAX_INPUTS
        // roots,   - MAX_INPUTS
        // nullifiers,  - MAX_INPUTS
        // output_enabled, - 3
        // c_outs,  - 3

        uint256[19] memory publicSignals;
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

        uint8 cmxCount = 0;
        bytes32[] memory tempCmx = new bytes32[](3);
        // output enabled
        if (call.C1 != ZERO_COMMITMENT) {
            require(!commitmentExists[call.C1], "Commitment 1 already exists");
            publicSignals[idx++] = uint256(1);
            tempCmx[cmxCount++] = call.C1;
        } else {
            publicSignals[idx++] = uint256(0);
        }
        if (call.C2 != ZERO_COMMITMENT) {
            require(!commitmentExists[call.C2], "Commitment 2 already exists");
            publicSignals[idx++] = uint256(1);
            tempCmx[cmxCount++] = call.C2;
        } else {
            publicSignals[idx++] = uint256(0);
        }
        if (call.C3 != ZERO_COMMITMENT) {
            require(!commitmentExists[call.C3], "Commitment 3 already exists");
            publicSignals[idx++] = uint256(1);
            tempCmx[cmxCount++] = call.C3;
        } else {
            publicSignals[idx++] = uint256(0);
        }
        require(cmxCount != 0, "No commitments present in this Transfer call");
        //c_outs
        publicSignals[idx++] = uint256(call.C1);
        publicSignals[idx++] = uint256(call.C2);
        publicSignals[idx++] = uint256(call.C3);

        // proof verification
        require(
            transferVerifier.verifyProof(call.a, call.b, call.c, publicSignals),
            "Transfer proof verification failed"
        );

        bytes32[] memory commitments = new bytes32[](cmxCount);
        for (uint8 i = 0; i < cmxCount; i++) {
            commitments[i] = tempCmx[i];
        }

        // add nullifiers to the pool
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            if (call.inputs.enabled[i] == 0) continue;
            require(
                !nullifierSpent[call.inputs.nullifiers[i]],
                "Nullifier already exists"
            );
            nullifierSpent[call.inputs.nullifiers[i]] = true;
            emit NullifierSpent(call.inputs.nullifiers[i]);
        }

        // add commitments to the pool
        InsertedNote[] memory notesInserted = _insertBatch(commitments);
        for (uint8 i = 0; i < notesInserted.length; i++) {
            bytes memory enc;

            if (notesInserted[i].commitment == call.C1)
                enc = call.encryptedNote1;
            else if (notesInserted[i].commitment == call.C2)
                enc = call.encryptedNote2;
            else if (notesInserted[i].commitment == call.C3)
                enc = call.encryptedNote3;
            else revert("Unknown commitment");

            // emit the poolId , cmx , encryptedNote
            emit NoteCreated(
                notesInserted[i].poolId,
                notesInserted[i].commitment,
                enc
            );
        }
    }

    function withdraw(
        WithdrawCall[] calldata calls,
        address payable to
    ) external {
        uint256 totalWithdrawAmount = 0;
        for (uint256 i = 0; i < calls.length; i++) {
            _singleWithdraw(calls[i], to);
            totalWithdrawAmount += calls[i].withdrawAmount;
        }
        (bool success, ) = to.call{value: totalWithdrawAmount}("");
        require(success, "Withdraw failed");
    }

    function _singleWithdraw(WithdrawCall calldata call, address to) internal {

        _verifyInputs(call.inputs);

        //duplicate commitment check
        if (call.C1 != ZERO_COMMITMENT && call.C2 != ZERO_COMMITMENT) {
            require(call.C1 != call.C2, "Duplicate commitments");
        }

        // for zk proof rquired public inputs:
        /**
            receiver,
            relayer,
            enabled,
            roots,
            nullifiers,
            withdrawAmount,
            out_enabled,
            c_outs,
         */
        uint256[19] memory publicSignals;
        publicSignals[0] = uint256(uint160(to));
        publicSignals[1] = relayerZkPubkey;

        // enabled roots nullifier
        for (uint8 i = 2; i < MAX_INPUTS + 2; i++) {
            publicSignals[i] = uint256(call.inputs.enabled[i - 2]);
            publicSignals[i + 4] = uint256(call.inputs.roots[i - 2]);
            publicSignals[i + 8] = uint256(call.inputs.nullifiers[i - 2]);
        }
        // withdraw amount
        uint8 idx = 14;
        publicSignals[idx++] = call.withdrawAmount;

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

        // verify withdraw proof
        require(
            withdrawVerifier.verifyProof(call.a, call.b, call.c, publicSignals),
            "Withdraw proof verification failed"
        );

        // add nullifiers to the pool
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            if (call.inputs.enabled[i] == 0) continue;
            require(
                !nullifierSpent[call.inputs.nullifiers[i]],
                "Nullifier already exists"
            );
            nullifierSpent[call.inputs.nullifiers[i]] = true;
            emit NullifierSpent(call.inputs.nullifiers[i]);
        }

        // add commitments to the pool
        bytes32[] memory commitments = new bytes32[](cmxCount);
        for (uint8 i = 0; i < cmxCount; i++) {
            commitments[i] = tempOutCmx[i];
        }
        InsertedNote[] memory insertedNotes = _insertBatch(commitments);
        for (uint8 i = 0; i < insertedNotes.length; i++) {
            bytes memory enc;
            if (insertedNotes[i].commitment == call.C1)
                enc = call.encryptedNote1;
            else if (insertedNotes[i].commitment == call.C2)
                enc = call.encryptedNote2;
            else revert("Unknown commiment");

            emit NoteCreated(
                insertedNotes[i].poolId,
                insertedNotes[i].commitment,
                enc
            );
        }
    }

    function setNoidAccount(bytes32 cmx, address account, bytes memory eNote) external {
        require(msg.sender == address(noidAccountManager),"Not allowed");
        NoidAccounts[cmx] = account;
        emit NoidAccountCreated(cmx, eNote);
    }

    function addNullifiersSpent(Inputs memory input) external {
        require(msg.sender == address(noidAccountManager),"Not allowed");
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            if (input.enabled[i] == 0) continue;
            require(
                !nullifierSpent[input.nullifiers[i]],
                "Nullifier already exists"
            );
            nullifierSpent[input.nullifiers[i]] = true;
            emit NullifierSpent(input.nullifiers[i]);
        }
    }

    function noteCreated(uint256 poolId, bytes32 commitment , bytes memory enc) external{
        require(msg.sender == address(noidAccountManager),"Not allowed");
    
        emit NoteCreated(
            poolId,
            commitment,
            enc
        );
    }


    // function executeFunction(
    //     ExecuteFunctionCall[] calldata calls,
    //     address target,
    //     uint256 value,
    //     bytes calldata data,
    //     bytes32 commitment, // owndership commitment of the Noid account
    //     bytes32 callCommitment,
    //     // zkproof
    //     uint256[2] calldata a,
    //     uint256[2][2] calldata b,
    //     uint256[2] calldata c,
    //     address noidAccount
    // ) external {
    //     uint256 totalValue = 0;
    //     for (uint8 i = 0; i < calls.length ; i++) {
    //         totalValue += calls[i].callValue;
    //         _singleExecuteFunction(calls[i]);
    //     }
    //     require(totalValue == value,"Values mismatched");

    //     require(NoidAccounts[commitment] == noidAccount , "Noid account mismatch");

    //     NoidAccount(payable(noidAccount)).execute{value: value} (
    //         target,
    //         value,
    //         data,
    //         callCommitment,
    //         a,
    //         b,
    //         c
    //     );
    // }

    // function _singleExecuteFunction(ExecuteFunctionCall calldata call) internal {
    //     // validate the inputs
    //     _verifyInputs(call.inputs);

    //     //duplicate commitment check
    //     if (call.C1 != ZERO_COMMITMENT && call.C2 != ZERO_COMMITMENT) {
    //         require(call.C1 != call.C2, "Duplicate commitments");
    //     }

    //     /* Public signals
    //     relayer, - 1
    //     enabled, - MAX_INPUTS
    //     roots,   - MAX_INPUTS
    //     nullifiers, - MAX_INPUTS
    //     out_enabled, - 2
    //     c_outs, - 2
    //     callValue - 1
    //     */
    //     uint256[18] memory publicSignals;
    //     uint8 idx = 0;
    //     publicSignals[idx++] = relayerZkPubkey;
    //     for (uint8 i = 0; i < MAX_INPUTS; i++) {
    //         publicSignals[idx++] = uint256(call.inputs.enabled[i]);
    //     }
    //     for (uint8 i = 0; i < MAX_INPUTS; i++) {
    //         publicSignals[idx++] = uint256(call.inputs.roots[i]);
    //     }
    //     for (uint8 i = 0; i < MAX_INPUTS; i++) {
    //         publicSignals[idx++] = uint256(call.inputs.nullifiers[i]);
    //     }

    //     // outputs enabled
    //     bytes32[] memory tempOutCmx = new bytes32[](2);
    //     uint8 cmxCount = 0;
    //     if (call.C1 != ZERO_COMMITMENT) {
    //         publicSignals[idx++] = 1;
    //         tempOutCmx[cmxCount++] = call.C1;
    //     } else {
    //         publicSignals[idx++] = 0;
    //     }

    //     if (call.C2 != ZERO_COMMITMENT) {
    //         publicSignals[idx++] = 1;
    //         tempOutCmx[cmxCount++] = call.C2;
    //     } else {
    //         publicSignals[idx++] = 0;
    //     }

    //     // c_outs
    //     publicSignals[idx++] = uint256(call.C1);
    //     publicSignals[idx++] = uint256(call.C2);

    //     // callValue
    //     publicSignals[idx++] = call.callValue;

    //     require(executeFunCallVerifier.verifyProof(call.a, call.b, call.c, publicSignals),"Execute function call proof verification failed");

    //     // add nullifiers to the pool
    //     for (uint8 i = 0; i < MAX_INPUTS; i++) {
    //         if (call.inputs.enabled[i] == 0) continue;
    //         require(
    //             !nullifierSpent[call.inputs.nullifiers[i]],
    //             "Nullifier already exists"
    //         );
    //         nullifierSpent[call.inputs.nullifiers[i]] = true;
    //         emit NullifierSpent(call.inputs.nullifiers[i]);
    //     }

    //     // add commitments to the pool
    //     bytes32[] memory commitments = new bytes32[](cmxCount);
    //     for (uint8 i = 0; i < cmxCount; i++) {
    //         commitments[i] = tempOutCmx[i];
    //     }
    //     InsertedNote[] memory insertedNotes = _insertBatch(commitments);
    //     for (uint8 i = 0; i < insertedNotes.length; i++) {
    //         bytes memory enc;
    //         if (insertedNotes[i].commitment == call.C1)
    //             enc = call.encryptedNote1;
    //         else if (insertedNotes[i].commitment == call.C2)
    //             enc = call.encryptedNote2;
    //         else revert("Unknown commiment");

    //         emit NoteCreated(
    //             insertedNotes[i].poolId,
    //             insertedNotes[i].commitment,
    //             enc
    //         );
    //     }

    // }

    function insertCommitments( 
        bytes32[] calldata commitments 
    ) external returns ( 
        InsertedNote[] memory 
    ) { 
        return _insertBatch(commitments); 
    }

    // it inserts the group of commitments all at once.
    function _insertBatch(
        bytes32[] memory commitments
    ) internal returns (InsertedNote[] memory inserted) {
        inserted = new InsertedNote[](commitments.length); // inserted notes
        uint32 idx = 0; // how many currently inserted into pool
        uint32 outIdx = 0; // how many inserted currently inserted into the array
        uint256 total = commitments.length; // num of commitments

        while (idx < total) {
            PoolLib.Pool storage pool = PoolLib.currentPool(pools);
            uint256 poolId = pools.length - 1;
            uint32 remaining = PoolLib.MAX_LEAF - pool.nextIdx; // how many can be inserted in this pool

            // if there is no space in pool -> create pool
            if (remaining == 0) {
                PoolLib.createPool(pools,poseidon);
                continue;
            }

            uint32 left = uint32(total - idx); // how many left to be inserted
            uint32 toInsert = remaining < left ? remaining : left;

            // insert leafs without pushing the root here
            for (uint8 i = 0; i < toInsert; i++) {
                bytes32 C = commitments[idx++]; // commitment
                require(!commitmentExists[C], "Commitment already exists");
                commitmentExists[C] = true; //add commitment to commitment pool
                // update pool for the commitment
                PoolLib.updatePool(pool, C, poseidon);
                inserted[outIdx++] = InsertedNote({
                    poolId: poolId,
                    commitment: C
                });
            }

            // push root only once for group of commitments
            PoolLib.pushRoot(pool, pool.root);
        }
    }

    receive() external payable {}
}
