// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IDepositVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[4] calldata publicSignals
    ) external view returns (bool);
}
interface ITransferVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[19] calldata publicSignals
    ) external view returns (bool);
}

interface IWithdrawVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[19] calldata publicSignals
    ) external view returns (bool);
}

interface IPoseidon {
    function poseidon(
        uint256[2] calldata input
    ) external pure returns (uint256);
}

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
contract PrivatePool {
    /**
     * Wallet:
     *      Get signature from real wallet
     *      PrivateKey = H(signature("prifiwallet"))
     *      Derive:
     *          zkPublicKey = Poseidon(PrivateKey) // used for transfer
     *          encPublicKey = EC_Derive(PrivateKey) // used for encrypting notes
     */

    // constants
    uint32 public constant TREE_DEPTH = 20;
    uint32 public constant ROOT_HISTORY_SIZE = 10;
    uint32 public constant MAX_LEAF = uint32(1) << TREE_DEPTH; // 2**20 value
    uint32 constant MAX_INPUTS = 4;

    // zero commitment - used in the place of empty commitment (wallet must use same convention)
    bytes32 public constant ZERO_COMMITMENT = bytes32(0);

    //global state
    mapping(bytes32 => bool) public nullifierSpent;
    mapping(bytes32 => bool) public commitmentExists;

    // verifiers
    IDepositVerifier public immutable depositVerifier;
    ITransferVerifier public immutable transferVerifier;
    IWithdrawVerifier public immutable withdrawVerifier;

    // poseidon
    IPoseidon public immutable poseidon;

    // relayer
    address public immutable relayer;
    uint256 public immutable relayerZkPubkey;

    // events
    event NewPool(uint256 indexed poolId); //indexed-> searchable/filterable
    // we dont store the encryptedNotes on chain ( storage gas ) instead we emit them as events
    event NoteCreated(uint256 poolId, bytes32 commitment, bytes encryptedNote);
    // nullfier spent
    event NullifierSpent(bytes32 nullifier);

    constructor(
        address _depositVerifier,
        address _transferVerifier,
        address _withdrawVerifier,
        address _poseidon,
        address _relayer,
        uint256 _relayerZkPubkey
    ) {
        depositVerifier = IDepositVerifier(_depositVerifier);
        transferVerifier = ITransferVerifier(_transferVerifier);
        withdrawVerifier = IWithdrawVerifier(_withdrawVerifier);
        poseidon = IPoseidon(_poseidon);
        relayer = _relayer;
        relayerZkPubkey = _relayerZkPubkey;
        _createPool();
    }

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

    Pool[] public pools;

    function _createPool() internal {
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

        emit NewPool(pools.length - 1);
    }

    // returns current pool
    function _currentPool() internal view returns (Pool storage) {
        return pools[pools.length - 1];
    }

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

    // transfer call
    struct TransferCall {
        // zk proof
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        //input details
        uint8[MAX_INPUTS] enabled; // decides wether input at index is present or not
        bytes32[MAX_INPUTS] roots; // tree roots which the respective commiment belongs to.
        uint256[MAX_INPUTS] poolIds; // poolid of that root
        bytes32[MAX_INPUTS] nullifiers; // nullifier for each commitment
        // outputs (maximum of 3)
        bytes32 C1; // receiver commitment (Required)
        bytes32 C2; // change commitment
        bytes32 C3; // relayer commitment
        bytes encryptedNote1; // receiver encrypted note
        bytes encryptedNote2; // change encrypted note
        bytes encryptedNote3; // relayer encrypted note
    }

    /*
     * - Each TransferCall consumes between 1 and MAX_INPUTS private input notes
     * - Multiple TransferCalls can be executed atomically in a single transaction
     * - Later TransferCalls may spend commitments created by earlier TransferCalls
     *   within the same transaction
     * - This enables note aggregation and large fan-in transfers
     *   while remaining atomic and private
     */

    /**
     * Zk proof for transfer
     * Consumes up to MAX_INPUTS (e.g. 16) private input notes
     * belonging to a single owner and creates up to 3 new
     * private output notes in one proof.
     *
     * For exact understanding Refer: notes/zk_proof_transfer.txt
     */

    function transfer(TransferCall[] memory calls) external {
        for (uint256 i = 0; i < calls.length; i++) {
            _singleTransfer(calls[i]);
        }
    }

    function _singleTransfer(TransferCall memory call) internal {
        // validate the inputs
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            require(
                call.enabled[i] * (1 - call.enabled[i]) == 0,
                "Invalid enable flag"
            );
            if (call.enabled[i] == 0) {
                continue;
            }
            require(call.poolIds[i] < pools.length, "Invalid poolId");
            Pool storage p = pools[call.poolIds[i]];
            require(p.validRoot[call.roots[i]], "Invalid root");

            require(
                !nullifierSpent[call.nullifiers[i]],
                "Nullifier already spent"
            );
            // all nullifiers in a Transfer call must be unique
            for (uint8 j = 0; j < i; j++) {
                if (call.enabled[j] == 0) continue;

                require(
                    call.nullifiers[i] != call.nullifiers[j],
                    "Duplicate nullifier"
                );
            }
        }

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
            publicSignals[idx++] = uint256(call.enabled[i]);
        }
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            publicSignals[idx++] = uint256(call.roots[i]);
        }
        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            publicSignals[idx++] = uint256(call.nullifiers[i]);
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
            if (call.enabled[i] == 0) continue;
            require(
                !nullifierSpent[call.nullifiers[i]],
                "Nullifier already exists"
            );
            nullifierSpent[call.nullifiers[i]] = true;
            emit NullifierSpent(call.nullifiers[i]);
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

    // withdraw
    /**
     * input commiments are surrendered
     * and the value of those inputs is transferred to the "To" account.
     * in withdraw also we need 2 extra commitments because 1. change 2. relayer
     */

    struct WithdrawCall {
        // zkproof
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        // input details
        uint8[MAX_INPUTS] enabled; // decides that input presence
        bytes32[MAX_INPUTS] roots; // roots of the commitments
        uint256[MAX_INPUTS] poolIds; // pool ids of the commitments
        bytes32[MAX_INPUTS] nullifiers; // nullifiers of that commitments
        // output details
        bytes32 C1; //change commitment
        bytes32 C2; //relayer commitment
        bytes encryptedNote1; // change encrypted note
        bytes encryptedNote2; // relayer encrypted note
        //withdraw amount for this call
        uint256 withdrawAmount;
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
        // to be implemented
        // get all the inputs validated
        // verify the proof
        // add all the nullifiers to the pool
        // add new commitements to the pool
        // transfer

        for (uint8 i = 0; i < MAX_INPUTS; i++) {
            require(
                (call.enabled[i] * (1 - call.enabled[i])) == 0,
                "Invalid enabled flag"
            );
            if (call.enabled[i] == 0) continue;

            require(call.poolIds[i] < pools.length, "Invalid poolId");
            Pool storage p = pools[call.poolIds[i]];
            require(p.validRoot[call.roots[i]], "Invalid root");

            require(
                !nullifierSpent[call.nullifiers[i]],
                "Nullifier already exists"
            );
            for (uint8 j = 0; j < i; j++) {
                if (call.enabled[j] == 0) continue;

                require(
                    call.nullifiers[i] != call.nullifiers[j],
                    "Duplicate nullifier"
                );
            }
        }

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
            publicSignals[i] = uint256(call.enabled[i - 2]);
            publicSignals[i + 4] = uint256(call.roots[i - 2]);
            publicSignals[i + 8] = uint256(call.nullifiers[i - 2]);
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
            if (call.enabled[i] == 0) continue;
            require(
                !nullifierSpent[call.nullifiers[i]],
                "Nullifier already exists"
            );
            nullifierSpent[call.nullifiers[i]] = true;
            emit NullifierSpent(call.nullifiers[i]);
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

    // helper functions
    struct InsertedNote {
        uint256 poolId;
        bytes32 commitment;
    }

    //update pool for commitment
    function _updatePool(Pool storage p, bytes32 commitment) internal {
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

    // it inserts the group of commitments all at once.
    function _insertBatch(
        bytes32[] memory commitments
    ) internal returns (InsertedNote[] memory inserted) {
        inserted = new InsertedNote[](commitments.length); // inserted notes
        uint32 idx = 0; // how many currently inserted into pool
        uint32 outIdx = 0; // how many inserted currently inserted into the array
        uint256 total = commitments.length; // num of commitments

        while (idx < total) {
            Pool storage pool = _currentPool();
            uint256 poolId = pools.length - 1;
            uint32 remaining = MAX_LEAF - pool.nextIdx; // how many can be inserted in this pool

            // if there is no space in pool -> create pool
            if (remaining == 0) {
                _createPool();
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
                _updatePool(pool, C);
                inserted[outIdx++] = InsertedNote({
                    poolId: poolId,
                    commitment: C
                });
            }

            // push root only once for group of commitments
            _pushRoot(pool, pool.root);
        }
    }

    function _pushRoot(Pool storage p, bytes32 newRoot) internal {
        // current root
        bytes32 oldRoot = p.rootHistory[p.rootPtr]; // old root at that position
        if (oldRoot != bytes32(0)) {
            p.validRoot[oldRoot] = false; // old root no more a valid root
        }

        p.rootHistory[p.rootPtr] = newRoot; // store new root in the history
        p.validRoot[newRoot] = true; // new root in valid roots
        p.rootPtr = (p.rootPtr + 1) % ROOT_HISTORY_SIZE; // increament root ptr (i.e where next root will be inserted)
    }

    receive() external payable {}
}
