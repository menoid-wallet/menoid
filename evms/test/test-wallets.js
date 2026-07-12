const { ethers } = require("hardhat");
const { expect } = require("chai");

const {
    deriveWallet,
    deriveNoidKeys,
    computeUserCommitment
} = require("../helpers/wallets");

describe("Menoid key derivation", function () {

    it("Should keep the real wallet address (no new wallet) and derive deterministic keys", async function () {

        const [signer] = await ethers.getSigners();

        const first =
            await deriveWallet(signer);

        const second =
            await deriveWallet(signer);

        // the user keeps their REAL wallet address
        expect(first.address).to.equal(signer.address);

        // derivation is deterministic
        expect(first.spend.privateKey).to.equal(second.spend.privateKey);
        expect(first.spend.publicKey.x).to.equal(second.spend.publicKey.x);
        expect(first.spend.publicKey.y).to.equal(second.spend.publicKey.y);
        expect(first.encryption.privateKey).to.equal(second.encryption.privateKey);
        expect(first.userCommitment.bytes32).to.equal(second.userCommitment.bytes32);

        console.log({
            address: first.address,
            spendPublicKey: first.spend.publicKey,
            userCommitment: first.userCommitment
        });
    });

    it("Should bind the user commitment to the wallet address", async function () {

        const [signer, other] = await ethers.getSigners();

        const signature =
            await signer.signMessage("menoid_Wallet");

        const keys =
            await deriveNoidKeys(signature);

        const ucSigner =
            await computeUserCommitment(
                signer.address,
                keys.spend.publicKey
            );

        const ucOther =
            await computeUserCommitment(
                other.address,
                keys.spend.publicKey
            );

        // same spending key but different address -> different user commitment
        expect(ucSigner.bytes32).to.not.equal(ucOther.bytes32);
    });

});
