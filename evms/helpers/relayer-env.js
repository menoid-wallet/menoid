const fs = require("fs");

/**
 * The relayer's keys as a comment block in .env, in the same shape the V1
 * demo used:
 *
 *   privateWallet   the real wallet address + the note-encryption key pair
 *                   (v1-mainnet: the incoming viewing key ivk / ivkPub, epoch 0)
 *   zk              the spending key sk + the user commitment
 *
 * v1-mainnet keys the demo did not have go in a third object, `v1m`.
 * Testnet only: a mainnet relayer's spending key does not belong in a file.
 */

const START = /^#\s*\/\*\s*RELAYER WALLET/;
const END = /^#\s*\*\/\s*$/;

const hex32 = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");

function relayerEnvBlock(wallet, { networkLabel }) {
    return [
        "# /* RELAYER WALLET",
        `# Menoid v1-mainnet relayer on ${networkLabel}. TESTNET keys: derived from`,
        "# PRIVATE_KEY's signature of the testnet key message (helpers/wallets.js).",
        "# privateWallet = wallet address + incoming viewing key pair (ivk, ivkPub; epoch 0)",
        "# zk            = spending key (sk) + user commitment",
        "# {",
        "#   privateWallet: {",
        `#     address: '${wallet.address}',`,
        `#     privateKey: '${wallet.viewing.ivk}',`,
        `#     publicKey: '${wallet.viewing.ivkPub}'`,
        "#   },",
        "#   zk: {",
        `#     secretKey: '${hex32(wallet.spend.sk)}',`,
        `#     publicKey: '${wallet.userCommitmentBytes32}'`,
        "#   },",
        "#   v1m: {",
        `#     network: '${wallet.network}',`,
        `#     keyIndex: ${wallet.keyIndex},`,
        `#     viewingEpoch: ${wallet.viewingEpoch},`,
        `#     nullifierKey: '${hex32(wallet.nullifierKey)}',`,
        `#     outgoingViewingKey: '${wallet.viewing.ovk}',`,
        `#     incomingSecret: '${wallet.incomingSecret}',`,
        `#     outgoingSecret: '${wallet.outgoingSecret}'`,
        "#   }",
        "# }",
        "# */"
    ];
}

// replaces the existing RELAYER WALLET block, or appends one
function writeRelayerEnvBlock(envFile, wallet, options) {
    if (wallet.network !== "testnet") throw new Error("only testnet relayer keys are written to .env");
    const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8").split("\n") : [];
    const block = relayerEnvBlock(wallet, options);

    const start = lines.findIndex((line) => START.test(line));
    const end = start === -1 ? -1 : lines.findIndex((line, i) => i > start && END.test(line));
    let next;
    if (start !== -1 && end !== -1) {
        next = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
    } else {
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        next = [...lines, "", ...block];
    }
    fs.writeFileSync(envFile, next.join("\n") + (next[next.length - 1] === "" ? "" : "\n"));
}

module.exports = { relayerEnvBlock, writeRelayerEnvBlock };
