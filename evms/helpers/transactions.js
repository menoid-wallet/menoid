const { ethers } = require("ethers");

const { N_INS, TREE_DEPTH, EXT_DOMAIN, FIELD_SIZE } = require("./constants");
const {
    createNote,
    notePublicKey,
    noteCommitment,
    noteNullifier,
    randomFieldElement,
    tokenField,
    toBytes32
} = require("./commitments");
const { ACTION, encryptNote, encryptOutgoingRecord } = require("./encryption");
const { prove } = require("./prover");

/**
 * Builders for the three pool actions, as a wallet would run them.
 *
 *   recipient / relayer = { address, userCommitment, viewingPublicKey }
 *                         (wallets.resolveRecipient reads this from the chain)
 *   sender              = a wallet from wallets.deriveWallet
 *   notes               = unspent notes from scanner.scan
 *
 * Refer: notes/deposit.txt, transfer.txt, withdraw.txt
 */

// ─── deposit: no proof ───────────────────────────────────────────────────────

// The contract computes the commitment from (token, amount, npk) itself,
// so the wallet only sends npk and the encrypted note.
function buildDeposit({ token, amount, recipient }) {
    const note = createNote({ token, amount, owner: recipient.userCommitment });
    return {
        note,
        npk: toBytes32(note.npk),
        encryptedNote: encryptNote(recipient.viewingPublicKey, note)
    };
}

// ─── ext data — must match NoidPool.hashTransferExtData / hashWithdrawExtData ─

function hashTransferExtData(chainId, poolAddress, ext) {
    const encoded = ethers.utils.defaultAbiCoder.encode(
        ["uint256", "address", "bytes32", "tuple(bytes[3] encryptedOutputs, bytes outgoingRecord)"],
        [chainId, poolAddress, EXT_DOMAIN.TRANSFER, [ext.encryptedOutputs, ext.outgoingRecord]]
    );
    return BigInt(ethers.utils.keccak256(encoded)) % FIELD_SIZE;
}

function hashWithdrawExtData(chainId, poolAddress, ext) {
    const encoded = ethers.utils.defaultAbiCoder.encode(
        [
            "uint256",
            "address",
            "bytes32",
            "tuple(address recipient, bool unwrapNative, bytes[2] encryptedOutputs, bytes outgoingRecord)"
        ],
        [
            chainId,
            poolAddress,
            EXT_DOMAIN.WITHDRAW,
            [ext.recipient, ext.unwrapNative, ext.encryptedOutputs, ext.outgoingRecord]
        ]
    );
    return BigInt(ethers.utils.keccak256(encoded)) % FIELD_SIZE;
}

// ─── shared spend preparation ───────────────────────────────────────────────

/**
 * Fills the 4 input slots: the real notes first (slot 0 is always real — the
 * outgoing record is keyed by its nullifier), then zero-value dummies that
 * the circuit exempts from the Merkle check.
 */
function prepareInputs({ mirror, owner, notes, token }) {
    if (notes.length === 0 || notes.length > N_INS) {
        throw new Error(`a proof spends 1 to ${N_INS} notes`);
    }
    const treeId = notes[0].treeId;
    for (const note of notes) {
        if (note.treeId !== treeId) throw new Error("all inputs of one proof must be in the same tree");
        if (ethers.utils.getAddress(note.token) !== ethers.utils.getAddress(token)) {
            throw new Error("all inputs of one proof must be the same token");
        }
    }

    const root = mirror.root(treeId);

    const slots = notes.map((note) => {
        const path = mirror.merkleProof(treeId, note.leafIndex);
        if (path.leaf !== BigInt(note.commitment)) throw new Error(`leaf ${note.leafIndex} is not this note`);
        return {
            amount: BigInt(note.amount),
            randomness: BigInt(note.randomness),
            commitment: BigInt(note.commitment),
            pathElements: path.pathElements,
            pathIndices: path.pathIndices
        };
    });

    while (slots.length < N_INS) {
        const randomness = randomFieldElement();
        slots.push({
            amount: 0n,
            randomness,
            commitment: noteCommitment(token, 0n, notePublicKey(owner.userCommitment, randomness)),
            pathElements: new Array(TREE_DEPTH).fill(0n),
            pathIndices: new Array(TREE_DEPTH).fill(0)
        });
    }

    return {
        treeId,
        root,
        slots,
        nullifiers: slots.map((s) => noteNullifier(owner.nullifierKey, s.commitment, s.randomness)),
        total: notes.reduce((sum, note) => sum + BigInt(note.amount), 0n)
    };
}

// circuit inputs both circuits share
function spendInput({ owner, root, slots, nullifiers, outputs, relayer, extDataHash }) {
    return {
        root,
        nullifiers,
        outCommitments: outputs.map((o) => o.commitment),
        relayer: relayer.userCommitment,
        extDataHash,
        sk: owner.spend.sk,
        ownerAddress: BigInt(owner.address),
        inAmounts: slots.map((s) => s.amount),
        inRandomness: slots.map((s) => s.randomness),
        inPathElements: slots.map((s) => s.pathElements),
        inPathIndices: slots.map((s) => s.pathIndices),
        outAmounts: outputs.map((o) => o.amount),
        outRandomness: outputs.map((o) => o.randomness),
        outOwners: outputs.map((o) => o.owner)
    };
}

// ─── transfer ───────────────────────────────────────────────────────────────

async function buildTransfer({ pool, chainId, mirror, sender, notes, token, recipient, amount, relayer, fee = 0n }) {
    // never fall back to anything else: an unregistered address has no key to
    // encrypt to, and the caller must decide what to do (e.g. a withdrawal)
    if (!recipient.registered || recipient.userCommitment === 0n) {
        throw new Error(`${recipient.address} is not registered for private transfers`);
    }
    amount = BigInt(amount);
    fee = BigInt(fee);

    const { treeId, root, slots, nullifiers, total } = prepareInputs({ mirror, owner: sender, notes, token });
    const change = total - amount - fee;
    if (change < 0n) throw new Error(`notes hold ${total}, transfer needs ${amount + fee}`);

    const outputs = [
        createNote({ token, amount, owner: recipient.userCommitment }),
        createNote({ token, amount: change, owner: sender.userCommitment }),
        createNote({ token, amount: fee, owner: relayer.userCommitment })
    ];

    const ext = {
        encryptedOutputs: [
            encryptNote(recipient.viewingPublicKey, outputs[0]),
            encryptNote(sender.viewing.ivkPub, outputs[1]),
            encryptNote(relayer.viewingPublicKey, outputs[2])
        ],
        outgoingRecord: encryptOutgoingRecord(sender.viewing.ovk, nullifiers[0], {
            action: ACTION.TRANSFER,
            token,
            amount,
            fee,
            counterpartyAddress: recipient.address,
            counterpartyUserCommitment: recipient.userCommitment,
            counterpartyNoteRandomness: outputs[0].randomness
        })
    };
    const extDataHash = hashTransferExtData(chainId, pool.address, ext);

    const { proof, rawProof, publicSignals } = await prove("transfer", {
        ...spendInput({ owner: sender, root, slots, nullifiers, outputs, relayer, extDataHash }),
        token: tokenField(token)
    });

    return {
        call: {
            proof,
            treeId,
            root: toBytes32(root),
            nullifiers: nullifiers.map(toBytes32),
            outCommitments: outputs.map((o) => toBytes32(o.commitment)),
            relayer: toBytes32(relayer.userCommitment),
            ext
        },
        outputs,
        nullifiers,
        extDataHash,
        publicSignals,
        rawProof
    };
}

// ─── withdraw ───────────────────────────────────────────────────────────────

async function buildWithdraw({
    pool,
    chainId,
    mirror,
    sender,
    notes,
    token,
    amount,
    recipient,
    unwrapNative = false,
    relayer,
    fee = 0n
}) {
    amount = BigInt(amount);
    fee = BigInt(fee);

    const { treeId, root, slots, nullifiers, total } = prepareInputs({ mirror, owner: sender, notes, token });
    const change = total - amount - fee;
    if (change < 0n) throw new Error(`notes hold ${total}, withdrawal needs ${amount + fee}`);

    const outputs = [
        createNote({ token, amount: change, owner: sender.userCommitment }),
        createNote({ token, amount: fee, owner: relayer.userCommitment })
    ];

    const ext = {
        recipient: ethers.utils.getAddress(recipient),
        unwrapNative,
        encryptedOutputs: [
            encryptNote(sender.viewing.ivkPub, outputs[0]),
            encryptNote(relayer.viewingPublicKey, outputs[1])
        ],
        outgoingRecord: encryptOutgoingRecord(sender.viewing.ovk, nullifiers[0], {
            action: ACTION.WITHDRAW,
            token,
            amount,
            fee,
            counterpartyAddress: recipient
        })
    };
    const extDataHash = hashWithdrawExtData(chainId, pool.address, ext);

    const { proof, rawProof, publicSignals } = await prove("withdraw", {
        ...spendInput({ owner: sender, root, slots, nullifiers, outputs, relayer, extDataHash }),
        publicToken: tokenField(token),
        publicAmount: amount
    });

    return {
        call: {
            proof,
            treeId,
            root: toBytes32(root),
            nullifiers: nullifiers.map(toBytes32),
            outCommitments: outputs.map((o) => toBytes32(o.commitment)),
            relayer: toBytes32(relayer.userCommitment),
            token: ethers.utils.getAddress(token),
            amount,
            ext
        },
        outputs,
        nullifiers,
        extDataHash,
        publicSignals,
        rawProof
    };
}

module.exports = {
    buildDeposit,
    buildTransfer,
    buildWithdraw,
    hashTransferExtData,
    hashWithdrawExtData,
    prepareInputs,
    spendInput
};
