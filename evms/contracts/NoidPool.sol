// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./libraries/Interfaces.sol";
import "./libraries/poolLib.sol";
import "./libraries/Types.sol";
/**
 * NoidPool
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
     *      Get signature from real wallet: sign("menoid_Wallet")
     *      spendingKeyPair = BabyJubJub keypair derived from the signature
     *      userCommitment  = Poseidon(walletAddress, spendingPubKey.x, spendingPubKey.y)
     *
     *      The user registers userCommitment on-chain (register()).
     *      Senders look up registered[receiverAddress] and lock notes to it:
     *          commitment = Poseidon(1, amount, randomness, userCommitment)
     *          nullifier  = Poseidon(2, commitment, randomness, spendingPrivateKey)
     */
    // zero commitment - used in the place of empty commitment (wallet must use same convention)
    bytes32 public constant ZERO_COMMITMENT = bytes32(0);

    //global state
    mapping(bytes32 => bool) public nullifierSpent;
    mapping(bytes32 => bool) public commitmentExists;

    // wallet address => user commitment (Poseidon(address, spendPk.x, spendPk.y))
    mapping(address => bytes32) public registered;

    // verifiers
    IDepositVerifier public immutable depositVerifier;
    ITransferVerifier public immutable transferVerifier;
    IWithdrawVerifier public immutable withdrawVerifier;

    // poseidon
    IPoseidon public immutable poseidon;

    // relayer
    address public immutable relayer;
    uint256 public immutable relayerCommitment; // relayer's user commitment

    // events
    event NewPool(uint256 indexed poolId); //indexed-> searchable/filterable
    // we dont store the encryptedNotes on chain ( storage gas ) instead we emit them as events
    event NoteCreated(uint256 poolId, bytes32 commitment, bytes encryptedNote);
    // nullfier spent
    event NullifierSpent(bytes32 nullifier);
    // wallet registration
    event WalletRegistered(address indexed wallet, bytes32 userCommitment);

    constructor(
        address _depositVerifier,
        address _transferVerifier,
        address _withdrawVerifier,
        address _poseidon,
        address _relayer,
        uint256 _relayerCommitment
    ) {
        depositVerifier = IDepositVerifier(_depositVerifier);
        transferVerifier = ITransferVerifier(_transferVerifier);
        withdrawVerifier = IWithdrawVerifier(_withdrawVerifier);
        poseidon = IPoseidon(_poseidon);

        relayer = _relayer;
        relayerCommitment = _relayerCommitment;
        PoolLib.createPool(pools, poseidon);
    }

    PoolLib.Pool[] public pools;

    // Register
    //  * One-time binding of a real wallet address to its user commitment.
    //  *
    //  * Wallet responsibilities (off-chain):
    //  * - Sign the message "menoid_Wallet" with the real wallet's private key
    //  * - Derive the BabyJubJub spending keypair from that signature
    //  * - Compute userCommitment = Poseidon(walletAddress, spendPk.x, spendPk.y)
    //  * - Call register(userCommitment) from the real wallet
    function register(bytes32 userCommitment) external {
        require(userCommitment != bytes32(0), "Invalid user commitment");
        require(registered[msg.sender] == bytes32(0), "Already registered");

        registered[msg.sender] = userCommitment;

        emit WalletRegistered(msg.sender, userCommitment);
    }

    // Depsoit
    //  * Public entry into the shielded pool.
    //  *
    //  * - ETH is sent with the transaction
    //  * - One or two commitments are created
    //  *   (C2 is the optional relayer fee note - may be zero)
    //  * - Commitments are inserted into the current pool(s)
    //  * - Each commitment is logged with NoteCreated
    //  *
    //  * Wallet responsibilities (off-chain):
    //  * - Fetch the receiver's registered user commitment
    //  * - Choose amount + randomness
    //  * - Compute commitment(s)
    //  * - Encrypt note(s)
    //  * - Track emitted poolId + leaf index
    function deposit(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        bytes32 C1, // First commitment (required)
        bytes32 C2, // 2nd commitment - relayer fee (optional, may be zero)
        bytes calldata encryptedNote1, // encrypted (amount, randomness) for C1
        bytes calldata encryptedNote2 // Encrypted (amount, randomness) for C2
    ) external payable {
        require(msg.value != 0, "No ethereum");

        // zero commitments are only for transfer/withdraw calls
        require(C1 != ZERO_COMMITMENT, "Invalid commitment 1");

        // commitments already exists?
        require(
            !commitmentExists[C1],
            "Commitment 1 already existing, change r value"
        );

        // C2 is the relayer fee note - it is optional
        uint256 c2Enabled = 0;
        if (C2 != ZERO_COMMITMENT) {
            require(
                !commitmentExists[C2],
                "Commitment 2 already existing, change r value"
            );
            c2Enabled = 1;
        }

        // public signals
        // deposit amount
        // c1
        // c2
        // c2 enabled flag
        // uc2 (relayerCommitment)
        uint256[5] memory publicSignals;
        publicSignals[0] = msg.value;
        publicSignals[1] = uint256(C1);
        publicSignals[2] = uint256(C2);
        publicSignals[3] = c2Enabled;
        publicSignals[4] = relayerCommitment;

        // in deposit we dont need to check merkle path
        // deposit zk , proves that the amounts that are in the commitments equals deposited amount
        require(
            depositVerifier.verifyProof(a, b, c, publicSignals),
            "Deposit proof verification failed"
        );

        uint256 count = 1 + c2Enabled;
        bytes32[] memory commitments = new bytes32[](count);
        commitments[0] = C1;
        if (c2Enabled == 1) {
            commitments[1] = C2;
        }

        // addition of group of commitments to be added here
        InsertedNote[] memory notesInserted = _insertBatch(commitments);
        for (uint8 i = 0; i < count; i++) {
            InsertedNote memory note = notesInserted[i];
            if (i == 0) {
                // emit the note created event
                emit NoteCreated(note.poolId, note.commitment, encryptedNote1);
            } else {
                emit NoteCreated(note.poolId, note.commitment, encryptedNote2);
            }
        }
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
        // relayer (user commitment), - 1
        // enabled,  - MAX_INPUTS
        // roots,   - MAX_INPUTS
        // nullifiers,  - MAX_INPUTS
        // output_enabled, - 3
        // c_outs,  - 3

        uint256[19] memory publicSignals;
        uint8 idx = 0;
        publicSignals[idx++] = relayerCommitment;
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
            relayer (user commitment),
            enabled,
            roots,
            nullifiers,
            withdrawAmount,
            out_enabled,
            c_outs,
         */
        uint256[19] memory publicSignals;
        publicSignals[0] = uint256(uint160(to));
        publicSignals[1] = relayerCommitment;

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
