// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "poseidon-solidity/PoseidonT5.sol";

import "./libraries/Interfaces.sol";
import "./libraries/poolLib.sol";
import "./libraries/Types.sol";

/**
 * NoidPool — Menoid v1-mainnet shielded pool.
 *
 * One pool per chain holds every accepted token. Value lives in notes:
 *
 *      npk        = Poseidon(D_NPK, ownerUserCommitment, randomness)
 *      commitment = Poseidon(D_CM, token, amount, npk)
 *      nullifier  = Poseidon(D_NF, nullifierKey, commitment, randomness)
 *
 * Notes of every token share one Merkle tree. The token is a private field
 * inside the commitment, so a transfer does not reveal which token moved.
 *
 *   register   one-time binding: wallet address -> (user commitment, viewing public key)
 *   deposit    public funds in, one note out. No proof needed: the amount and
 *              token are public anyway, so the contract builds the commitment.
 *   transfer   notes -> notes (transfer proof). Token, amounts, sender and
 *              receiver stay hidden.
 *   withdraw   notes -> public funds at an address (withdraw proof).
 *
 * The owner can only choose which tokens are accepted for deposit and pause
 * deposits. Transfers and withdrawals can never be paused or blocked.
 *
 * Refer: notes/keys_and_registration.txt, deposit.txt, transfer.txt, withdraw.txt
 */
contract NoidPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolLib for PoolLib.Tree;

    // ─── constants ───────────────────────────────────────────────────────────

    // BN254 scalar field: every circuit value lives below it
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // the circuits range-check every amount to 128 bits
    uint256 public constant MAX_AMOUNT = type(uint128).max;
    // commitment domain separator (circuits/note_lib.circom D_CM)
    uint256 internal constant D_CM = 4;

    bytes32 public constant TRANSFER_EXT_DOMAIN = keccak256("menoid.v1m.transfer");
    bytes32 public constant WITHDRAW_EXT_DOMAIN = keccak256("menoid.v1m.withdraw");

    // ─── identity ────────────────────────────────────────────────────────────

    struct Registration {
        bytes32 userCommitment;   // Poseidon(D_UC, address, spendPk.x, spendPk.y)
        uint32 keyIndex;          // bumped by rotateKeys (new spending identity)
        uint32 viewingEpoch;      // bumped by updateViewingKey (new viewing key, same identity)
        bytes viewingPublicKey;   // 65-byte uncompressed secp256k1 key senders encrypt notes to
    }

    mapping(address => Registration) private _registrations;
    // user commitment -> wallet that registered it (a commitment can be claimed once)
    mapping(bytes32 => address) public userCommitmentOwner;

    // ─── tokens ──────────────────────────────────────────────────────────────

    struct TokenConfig {
        bool depositsEnabled;
        uint256 maxDeposit;       // per-deposit cap (guarded launch)
    }

    mapping(address => TokenConfig) public tokenConfig;
    bool public depositsPaused;

    // ─── notes ───────────────────────────────────────────────────────────────

    mapping(bytes32 => bool) public nullifierSpent;
    mapping(bytes32 => bool) public commitmentExists;
    PoolLib.Tree[] private _trees;

    ITransferVerifier public immutable transferVerifier;
    IWithdrawVerifier public immutable withdrawVerifier;
    IWrappedNative public immutable wrappedNative;

    // ─── events ──────────────────────────────────────────────────────────────

    event Registered(address indexed wallet, bytes32 userCommitment, bytes viewingPublicKey);
    event ViewingKeyUpdated(address indexed wallet, bytes viewingPublicKey, uint32 viewingEpoch);
    event KeysRotated(address indexed wallet, bytes32 userCommitment, bytes viewingPublicKey, uint32 keyIndex);

    // encrypted notes are emitted, not stored: wallets scan these to find their notes
    event NoteCreated(uint256 indexed treeId, uint256 leafIndex, bytes32 commitment, bytes encryptedNote);
    event NullifierSpent(bytes32 indexed nullifier);
    // indexed by the spend's first nullifier: the owner's outgoing viewing key
    // derives the decryption key from it, so no trial decryption is needed
    event OutgoingRecord(bytes32 indexed firstNullifier, bytes record);

    event Deposited(address indexed depositor, address indexed token, uint256 amount, bytes32 commitment);
    event Withdrawn(address indexed token, address indexed recipient, uint256 amount);
    event NewTree(uint256 indexed treeId);

    event TokenConfigured(address indexed token, bool depositsEnabled, uint256 maxDeposit);
    event DepositsPausedSet(bool paused);

    constructor(address transferVerifier_, address withdrawVerifier_, address wrappedNative_) {
        require(
            transferVerifier_ != address(0) && withdrawVerifier_ != address(0) && wrappedNative_ != address(0),
            "Zero address"
        );
        transferVerifier = ITransferVerifier(transferVerifier_);
        withdrawVerifier = IWithdrawVerifier(withdrawVerifier_);
        wrappedNative = IWrappedNative(wrappedNative_);
        _newTree();
    }

    // only the wrapped native token sends coins here (when unwrapping a withdrawal)
    receive() external payable {
        require(msg.sender == address(wrappedNative), "Direct payments not accepted");
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Registration
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * One-time binding of msg.sender to its private identity.
     *
     * Off-chain, the wallet signs the key message, derives the spending key,
     * nullifier key and viewing keys from that signature, and computes
     *      userCommitment = Poseidon(D_UC, address, spendPk.x, spendPk.y)
     * Senders resolve both values with registrationOf(address).
     */
    function register(bytes32 userCommitment, bytes calldata viewingPublicKey) external {
        require(_registrations[msg.sender].userCommitment == bytes32(0), "Already registered");
        _claimUserCommitment(userCommitment);
        _checkViewingKey(viewingPublicKey);

        Registration storage reg = _registrations[msg.sender];
        reg.userCommitment = userCommitment;
        reg.viewingPublicKey = viewingPublicKey;

        emit Registered(msg.sender, userCommitment, viewingPublicKey);
    }

    /**
     * New viewing key, same identity (viewing epoch + 1).
     * Senders encrypt to the new key from now on. Notes received earlier stay
     * readable with the old epoch's key, which lets a user share a key that
     * covers one period only.
     */
    function updateViewingKey(bytes calldata viewingPublicKey) external {
        Registration storage reg = _registrations[msg.sender];
        require(reg.userCommitment != bytes32(0), "Not registered");
        _checkViewingKey(viewingPublicKey);

        reg.viewingPublicKey = viewingPublicKey;
        reg.viewingEpoch += 1;

        emit ViewingKeyUpdated(msg.sender, viewingPublicKey, reg.viewingEpoch);
    }

    /**
     * New spending identity (key index + 1), for when the key signature leaks.
     * Notes locked to the old user commitment stay spendable with the old keys
     * and must be swept to the new identity.
     */
    function rotateKeys(bytes32 newUserCommitment, bytes calldata viewingPublicKey) external {
        Registration storage reg = _registrations[msg.sender];
        require(reg.userCommitment != bytes32(0), "Not registered");
        _claimUserCommitment(newUserCommitment);
        _checkViewingKey(viewingPublicKey);

        reg.userCommitment = newUserCommitment;
        reg.viewingPublicKey = viewingPublicKey;
        reg.keyIndex += 1;
        reg.viewingEpoch = 0;

        emit KeysRotated(msg.sender, newUserCommitment, viewingPublicKey, reg.keyIndex);
    }

    // Everything a sender needs about a receiver, in one call.
    // An unregistered address answers (0, "", 0, 0): it never reverts, so
    // "not registered" stays distinguishable from "the node did not answer".
    function registrationOf(address wallet)
        external
        view
        returns (bytes32 userCommitment, bytes memory viewingPublicKey, uint32 keyIndex, uint32 viewingEpoch)
    {
        Registration storage reg = _registrations[wallet];
        return (reg.userCommitment, reg.viewingPublicKey, reg.keyIndex, reg.viewingEpoch);
    }

    function isRegistered(address wallet) external view returns (bool) {
        return _registrations[wallet].userCommitment != bytes32(0);
    }

    function _claimUserCommitment(bytes32 userCommitment) private {
        require(
            userCommitment != bytes32(0) && uint256(userCommitment) < FIELD_SIZE,
            "Invalid user commitment"
        );
        // a commitment contains its owner's address, so an honest wallet never
        // collides; this stops someone re-registering a copied commitment
        require(userCommitmentOwner[userCommitment] == address(0), "User commitment already claimed");
        userCommitmentOwner[userCommitment] = msg.sender;
    }

    function _checkViewingKey(bytes calldata viewingPublicKey) private pure {
        require(
            viewingPublicKey.length == 65 && viewingPublicKey[0] == 0x04,
            "Invalid viewing public key"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Deposit
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Deposit an accepted ERC-20.
     *
     * npk = Poseidon(D_NPK, receiverUserCommitment, randomness) hides who the
     * note belongs to; encryptedNote carries (token, amount, randomness) to the
     * receiver. The receiver may be anyone, not only msg.sender.
     */
    function deposit(address token, uint256 amount, bytes32 npk, bytes calldata encryptedNote)
        external
        nonReentrant
    {
        _checkDeposit(token, amount);

        IERC20 erc20 = IERC20(token);
        uint256 balanceBefore = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), amount);
        // a note must be backed 1:1 (rejects fee-on-transfer tokens)
        require(erc20.balanceOf(address(this)) - balanceBefore == amount, "Token transfer amount mismatch");

        _depositNote(token, amount, npk, encryptedNote);
    }

    // Deposit the native coin. It is wrapped, so the note's token is the
    // wrapped native token: native and wrapped deposits are the same asset.
    function depositNative(bytes32 npk, bytes calldata encryptedNote) external payable nonReentrant {
        address token = address(wrappedNative);
        _checkDeposit(token, msg.value);
        wrappedNative.deposit{value: msg.value}();
        _depositNote(token, msg.value, npk, encryptedNote);
    }

    function _checkDeposit(address token, uint256 amount) private view {
        require(!depositsPaused, "Deposits paused");
        TokenConfig storage config = tokenConfig[token];
        require(config.depositsEnabled, "Token not accepted");
        require(amount != 0, "Zero amount");
        require(amount <= config.maxDeposit, "Deposit above cap");
    }

    function _depositNote(address token, uint256 amount, bytes32 npk, bytes calldata encryptedNote) private {
        require(npk != bytes32(0) && uint256(npk) < FIELD_SIZE, "Invalid note public key");

        bytes32 commitment = bytes32(
            PoseidonT5.hash([D_CM, uint256(uint160(token)), amount, uint256(npk)])
        );

        bytes32[4] memory chunk;
        chunk[0] = commitment;
        (uint256 treeId, uint256 startIndex) = _insertChunk(chunk, 1);

        emit NoteCreated(treeId, startIndex, commitment, encryptedNote);
        emit Deposited(msg.sender, token, amount, commitment);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Transfer
    // ═════════════════════════════════════════════════════════════════════════

    // Several independent calls may share one transaction. They are relayed,
    // so msg.sender is the relayer, never the user.
    function transfer(TransferCall[] calldata calls) external nonReentrant {
        require(calls.length != 0, "No calls");
        for (uint256 i = 0; i < calls.length; i++) {
            _transfer(calls[i]);
        }
    }

    function _transfer(TransferCall calldata call) private {
        _checkInputs(call.treeId, call.root, call.nullifiers);

        require(
            transferVerifier.verifyProof(call.proof.a, call.proof.b, call.proof.c, _transferSignals(call)),
            "Invalid transfer proof"
        );

        _spendNullifiers(call.nullifiers);

        bytes32[4] memory chunk;
        for (uint256 i = 0; i < TRANSFER_OUTS; i++) {
            chunk[i] = call.outCommitments[i];
        }
        (uint256 treeId, uint256 startIndex) = _insertChunk(chunk, TRANSFER_OUTS);
        for (uint256 i = 0; i < TRANSFER_OUTS; i++) {
            emit NoteCreated(treeId, startIndex + i, chunk[i], call.ext.encryptedOutputs[i]);
        }

        emit OutgoingRecord(call.nullifiers[0], call.ext.outgoingRecord);
    }

    // order must match circuits/transfer_proof.circom
    function _transferSignals(TransferCall calldata call) private view returns (uint256[10] memory signals) {
        signals[0] = uint256(call.root);
        for (uint256 i = 0; i < N_INS; i++) {
            signals[1 + i] = uint256(call.nullifiers[i]);
        }
        for (uint256 i = 0; i < TRANSFER_OUTS; i++) {
            signals[5 + i] = uint256(call.outCommitments[i]);
        }
        signals[8] = uint256(call.relayer);
        signals[9] = hashTransferExtData(call.ext);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Withdraw
    // ═════════════════════════════════════════════════════════════════════════

    function withdraw(WithdrawCall[] calldata calls) external nonReentrant {
        require(calls.length != 0, "No calls");
        for (uint256 i = 0; i < calls.length; i++) {
            _withdraw(calls[i]);
        }
    }

    function _withdraw(WithdrawCall calldata call) private {
        require(call.amount != 0 && call.amount <= MAX_AMOUNT, "Invalid amount");
        require(call.token != address(0), "Invalid token");
        require(call.ext.recipient != address(0), "Invalid recipient");
        require(
            !call.ext.unwrapNative || call.token == address(wrappedNative),
            "Only the wrapped native token can be unwrapped"
        );
        _checkInputs(call.treeId, call.root, call.nullifiers);

        require(
            withdrawVerifier.verifyProof(call.proof.a, call.proof.b, call.proof.c, _withdrawSignals(call)),
            "Invalid withdraw proof"
        );

        _spendNullifiers(call.nullifiers);

        bytes32[4] memory chunk;
        for (uint256 i = 0; i < WITHDRAW_OUTS; i++) {
            chunk[i] = call.outCommitments[i];
        }
        (uint256 treeId, uint256 startIndex) = _insertChunk(chunk, WITHDRAW_OUTS);
        for (uint256 i = 0; i < WITHDRAW_OUTS; i++) {
            emit NoteCreated(treeId, startIndex + i, chunk[i], call.ext.encryptedOutputs[i]);
        }

        emit OutgoingRecord(call.nullifiers[0], call.ext.outgoingRecord);

        // all state is final before any external call
        _payout(call.token, call.amount, call.ext.recipient, call.ext.unwrapNative);
        emit Withdrawn(call.token, call.ext.recipient, call.amount);
    }

    // order must match circuits/withdraw_proof.circom
    function _withdrawSignals(WithdrawCall calldata call) private view returns (uint256[11] memory signals) {
        signals[0] = uint256(call.root);
        for (uint256 i = 0; i < N_INS; i++) {
            signals[1 + i] = uint256(call.nullifiers[i]);
        }
        for (uint256 i = 0; i < WITHDRAW_OUTS; i++) {
            signals[5 + i] = uint256(call.outCommitments[i]);
        }
        signals[7] = uint256(call.relayer);
        signals[8] = uint256(uint160(call.token));
        signals[9] = call.amount;
        signals[10] = hashWithdrawExtData(call.ext);
    }

    function _payout(address token, uint256 amount, address recipient, bool unwrapNative) private {
        if (unwrapNative) {
            wrappedNative.withdraw(amount);
            (bool ok, ) = payable(recipient).call{value: amount}("");
            require(ok, "Native transfer failed");
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  External data binding
    // ═════════════════════════════════════════════════════════════════════════

    // The proof commits to this hash, so the relayer cannot swap ciphertexts,
    // strip the outgoing record, or replay the proof on another chain or pool.
    function hashTransferExtData(TransferExtData calldata ext) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), TRANSFER_EXT_DOMAIN, ext))) % FIELD_SIZE;
    }

    // Same for withdrawals; the recipient is bound here.
    function hashWithdrawExtData(WithdrawExtData calldata ext) public view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, address(this), WITHDRAW_EXT_DOMAIN, ext))) % FIELD_SIZE;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Shared spend checks + tree
    // ═════════════════════════════════════════════════════════════════════════

    function _checkInputs(uint256 treeId, bytes32 root, bytes32[N_INS] calldata nullifiers) private view {
        require(treeId < _trees.length, "Unknown tree");
        require(_trees[treeId].isKnownRoot(root), "Unknown root");
        for (uint256 i = 0; i < N_INS; i++) {
            require(!nullifierSpent[nullifiers[i]], "Nullifier already spent");
            // the circuit sums every input slot, so the same note twice in one
            // proof would count twice; only distinct nullifiers are accepted
            for (uint256 j = 0; j < i; j++) {
                require(nullifiers[i] != nullifiers[j], "Duplicate nullifier");
            }
        }
    }

    function _spendNullifiers(bytes32[N_INS] calldata nullifiers) private {
        for (uint256 i = 0; i < N_INS; i++) {
            nullifierSpent[nullifiers[i]] = true;
            emit NullifierSpent(nullifiers[i]);
        }
    }

    // marks the first `count` leaves as existing commitments and inserts the
    // whole 4-leaf chunk (the rest are zero padding)
    function _insertChunk(bytes32[4] memory chunk, uint256 count)
        private
        returns (uint256 treeId, uint256 startIndex)
    {
        for (uint256 i = 0; i < count; i++) {
            bytes32 commitment = chunk[i];
            require(commitment != bytes32(0), "Zero commitment");
            require(!commitmentExists[commitment], "Commitment already exists");
            commitmentExists[commitment] = true;
        }

        treeId = _trees.length - 1;
        if (_trees[treeId].isFull()) {
            treeId = _newTree();
        }
        startIndex = _trees[treeId].insertChunk(chunk);
    }

    function _newTree() private returns (uint256 treeId) {
        treeId = _trees.length;
        _trees.push().init();
        emit NewTree(treeId);
    }

    // ─── views ───────────────────────────────────────────────────────────────

    function treeCount() external view returns (uint256) {
        return _trees.length;
    }

    function treeInfo(uint256 treeId) external view returns (bytes32 root, uint256 nextIndex) {
        require(treeId < _trees.length, "Unknown tree");
        PoolLib.Tree storage tree = _trees[treeId];
        return (tree.root, tree.nextIndex);
    }

    function isKnownRoot(uint256 treeId, bytes32 root) external view returns (bool) {
        return treeId < _trees.length && _trees[treeId].isKnownRoot(root);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Admin — deposit policy only; cannot touch notes or funds
    // ═════════════════════════════════════════════════════════════════════════

    function configureToken(address token, bool depositsEnabled, uint256 maxDeposit) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(maxDeposit <= MAX_AMOUNT, "Cap above 128 bits");
        tokenConfig[token] = TokenConfig(depositsEnabled, maxDeposit);
        emit TokenConfigured(token, depositsEnabled, maxDeposit);
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }
}
