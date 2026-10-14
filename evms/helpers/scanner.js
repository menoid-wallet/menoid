const { deriveIncomingViewingKey, deriveOutgoingViewingKey } = require("./wallets");
const { notePublicKey, noteCommitment, noteNullifier } = require("./commitments");
const { tryDecryptNote, tryDecryptOutgoingRecord } = require("./encryption");

/**
 * The viewing-key scanner — what a wallet or an auditor runs.
 *
 *   ivk  -> try to decrypt every NoteCreated; a success that rebuilds the
 *           on-chain commitment is one of the user's notes          (incoming)
 *   nk   -> nullifier = Poseidon(D_NF, nk, commitment, randomness);
 *           present on-chain means spent                             (spends)
 *   ovk  -> for each spent note's nullifier, open the OutgoingRecord
 *           of the transaction that spent it                         (outgoing)
 *
 * A viewer is { userCommitment, ivks: [{epoch, ivk}], ovks: [{epoch, ovk}], nullifierKey? }.
 * Build one from a wallet or from a viewing key with the functions below.
 *
 * Refer: notes/viewing_keys.txt
 */

function epochsUpTo(lastEpoch) {
    return Array.from({ length: lastEpoch + 1 }, (_, epoch) => epoch);
}

function ivksUpTo(incomingSecret, lastEpoch) {
    return epochsUpTo(lastEpoch).map((epoch) => ({ epoch, ivk: deriveIncomingViewingKey(incomingSecret, epoch).ivk }));
}

function ovksUpTo(outgoingSecret, lastEpoch) {
    return epochsUpTo(lastEpoch).map((epoch) => ({ epoch, ovk: deriveOutgoingViewingKey(outgoingSecret, epoch) }));
}

// the wallet's own view, across viewing epochs 0..lastEpoch
function viewerFromWallet(wallet, lastEpoch = wallet.viewingEpoch) {
    return {
        userCommitment: wallet.userCommitment,
        ivks: ivksUpTo(wallet.incomingSecret, lastEpoch),
        ovks: ovksUpTo(wallet.outgoingSecret, lastEpoch),
        nullifierKey: wallet.nullifierKey
    };
}

/**
 * A viewer from a key someone shared (wallets.js fullViewingKey /
 * incomingViewingKey / epochViewingKey). lastEpoch is the address's current
 * viewing epoch, read from registrationOf.
 */
function viewerFromViewingKey(viewingKey, lastEpoch = 0) {
    switch (viewingKey.kind) {
        case "full":
            return {
                userCommitment: viewingKey.userCommitment,
                ivks: ivksUpTo(viewingKey.incomingSecret, lastEpoch),
                ovks: ovksUpTo(viewingKey.outgoingSecret, lastEpoch),
                nullifierKey: viewingKey.nullifierKey
            };
        case "incoming":
            // no outgoing secret and no nullifier key: incoming notes only
            return {
                userCommitment: viewingKey.userCommitment,
                ivks: ivksUpTo(viewingKey.incomingSecret, lastEpoch),
                ovks: []
            };
        case "epoch":
            return {
                userCommitment: viewingKey.userCommitment,
                ivks: [{ epoch: viewingKey.epoch, ivk: viewingKey.ivk }],
                ovks: [{ epoch: viewingKey.epoch, ovk: viewingKey.ovk }],
                nullifierKey: viewingKey.nullifierKey
            };
        default:
            throw new Error(`Unknown viewing key kind: ${viewingKey.kind}`);
    }
}

function scan(mirror, viewer) {
    const canSeeSpends = viewer.nullifierKey !== undefined;
    const notes = [];

    for (const event of mirror.notes) {
        for (const { epoch, ivk } of viewer.ivks) {
            const plain = tryDecryptNote(ivk, event.encryptedNote);
            if (!plain) continue;

            // a ciphertext anyone could have encrypted to us: only accept it if
            // it opens to the commitment the chain actually stored
            const npk = notePublicKey(viewer.userCommitment, plain.randomness);
            if (noteCommitment(plain.token, plain.amount, npk) !== event.commitment) break;

            // zero-value notes are the dummy outputs of fixed-shape spends
            if (plain.amount === 0n) break;

            const note = { ...event, token: plain.token, amount: plain.amount, randomness: plain.randomness, epoch };
            if (canSeeSpends) {
                note.nullifier = noteNullifier(viewer.nullifierKey, note.commitment, note.randomness);
                note.spent = mirror.isSpent(note.nullifier);
            }
            notes.push(note);
            break;
        }
    }

    const received = {};
    const balances = canSeeSpends ? {} : null;
    for (const note of notes) {
        received[note.token] = (received[note.token] ?? 0n) + note.amount;
        if (canSeeSpends && !note.spent) {
            balances[note.token] = (balances[note.token] ?? 0n) + note.amount;
        }
    }

    // outgoing records are keyed by the spend's first nullifier
    const outgoing = [];
    if (canSeeSpends && viewer.ovks.length) {
        for (const note of notes) {
            if (!note.spent) continue;
            const entry = mirror.outgoing.get(note.nullifier.toString());
            if (!entry) continue;   // this note was not in slot 0 of its spend
            for (const { epoch, ovk } of viewer.ovks) {
                const record = tryDecryptOutgoingRecord(ovk, note.nullifier, entry.record);
                if (record) {
                    outgoing.push({ ...record, epoch, txHash: entry.txHash });
                    break;
                }
            }
        }
    }

    return {
        notes,
        unspent: canSeeSpends ? notes.filter((n) => !n.spent) : null,
        received,     // everything ever received (an upper bound without nk)
        balances,     // unspent per token, only when spends are visible
        outgoing
    };
}

module.exports = {
    viewerFromWallet,
    viewerFromViewingKey,
    scan
};
