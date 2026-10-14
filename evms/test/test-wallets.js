const hre = require("hardhat");
const { ethers } = hre;
const { expect } = require("chai");

const { deployLocalSystem } = require("../helpers/deploy");
const { BABYJUB_SUBGROUP_ORDER, FIELD_SIZE } = require("../helpers/constants");
const {
    APP_ORIGIN,
    keyMessage,
    signKeyMessage,
    deriveKeysFromSignature,
    deriveWallet,
    userCommitmentOf,
    registerWallet,
    updateViewingKey,
    rotateKeys,
    resolveRecipient,
    assertRegisteredIdentity,
    fullViewingKey,
    incomingViewingKey,
    epochViewingKey,
    encodeViewingKey,
    decodeViewingKey
} = require("../helpers/wallets");
const { toBytes32 } = require("../helpers/commitments");

/**
 * v1-mainnet key system and registration.
 * No proofs here — see noidpool-test.js for deposit / transfer / withdraw.
 */
describe("Menoid v1-mainnet: keys & registration", function () {
    let pool;
    let signers;

    before(async function () {
        hre.upgrades.silenceWarnings();   // the linked-Poseidon-libraries notice is expected
        signers = await ethers.getSigners();
        ({ pool } = await deployLocalSystem(hre));
    });

    describe("key derivation", function () {
        it("derives the same keys from the same signature, every time", async function () {
            const [, signer] = signers;
            const first = await deriveWallet(signer);
            const second = await deriveWallet(signer);

            expect(first.address).to.equal(signer.address);
            expect(first.spend.sk).to.equal(second.spend.sk);
            expect(first.nullifierKey).to.equal(second.nullifierKey);
            expect(first.viewing.ivk).to.equal(second.viewing.ivk);
            expect(first.viewing.ovk).to.equal(second.viewing.ovk);
            expect(first.userCommitment).to.equal(second.userCommitment);

            expect(first.spend.sk < BABYJUB_SUBGROUP_ORDER).to.equal(true);
            expect(first.userCommitment < FIELD_SIZE).to.equal(true);
            expect(ethers.utils.arrayify(first.viewing.ivkPub)).to.have.length(65);
        });

        it("gives every key its own value", async function () {
            const wallet = await deriveWallet(signers[1]);
            const values = [
                wallet.spend.sk,
                wallet.nullifierKey,
                BigInt(wallet.incomingSecret),
                BigInt(wallet.outgoingSecret),
                BigInt(wallet.viewing.ivk),
                BigInt(wallet.viewing.ovk),
                wallet.userCommitment
            ];
            expect(new Set(values.map(String)).size).to.equal(values.length);
        });

        it("separates key indices and viewing epochs", async function () {
            const signer = signers[1];
            const index0 = await deriveWallet(signer, { keyIndex: 0 });
            const index1 = await deriveWallet(signer, { keyIndex: 1 });
            const epoch1 = await deriveWallet(signer, { keyIndex: 0, viewingEpoch: 1 });

            // a new key index is a different identity
            expect(index1.spend.sk).to.not.equal(index0.spend.sk);
            expect(index1.userCommitment).to.not.equal(index0.userCommitment);

            // a new viewing epoch keeps the identity and changes only the viewing keys
            expect(epoch1.userCommitment).to.equal(index0.userCommitment);
            expect(epoch1.nullifierKey).to.equal(index0.nullifierKey);
            expect(epoch1.viewing.ivk).to.not.equal(index0.viewing.ivk);
            expect(epoch1.viewing.ovk).to.not.equal(index0.viewing.ovk);
        });

        it("is unrelated to the V1 demo keys", async function () {
            const signer = signers[1];
            const v1m = await deriveWallet(signer);

            // V1 demo: sk = keccak("menoid/spend" ‖ sign("menoid_Wallet")) mod l
            const demoSignature = await signer.signMessage("menoid_Wallet");
            const demoSk =
                BigInt(ethers.utils.solidityKeccak256(["string", "bytes"], ["menoid/spend", demoSignature])) %
                BABYJUB_SUBGROUP_ORDER;

            expect(v1m.spend.sk).to.not.equal(demoSk);
        });

        it("binds the user commitment to the wallet address", async function () {
            const wallet = await deriveWallet(signers[1]);
            const sameKeyOtherAddress = userCommitmentOf(signers[2].address, wallet.spend.publicKey);
            expect(sameKeyOtherAddress).to.not.equal(wallet.userCommitment);
        });

        it("names the app and the key index in the message the user signs", function () {
            const message = keyMessage(3);
            expect(message).to.include(APP_ORIGIN);
            expect(message).to.include("Key index: 3");
            expect(message).to.include("Anyone holding this signature can spend your private balance.");
        });

        it("refuses a wallet that does not sign deterministically", async function () {
            // stands in for a smart-contract / passkey wallet
            const flaky = {
                getAddress: async () => signers[1].address,
                signMessage: async () => ethers.utils.hexlify(ethers.utils.randomBytes(65))
            };
            let error;
            try {
                await deriveWallet(flaky);
            } catch (e) {
                error = e;
            }
            expect(error && error.message).to.include("does not sign deterministically");
        });

        it("derives the same keys from a signature as from the signer", async function () {
            const signer = signers[1];
            const signature = await signKeyMessage(signer, 0);
            const fromSignature = await deriveKeysFromSignature(signer.address, signature);
            const fromSigner = await deriveWallet(signer);
            expect(fromSignature.userCommitment).to.equal(fromSigner.userCommitment);
        });
    });

    describe("viewing key export", function () {
        it("round-trips every kind of viewing key and catches a typo", async function () {
            const wallet = await deriveWallet(signers[1]);

            for (const key of [fullViewingKey(wallet), incomingViewingKey(wallet), epochViewingKey(wallet, 2)]) {
                const encoded = encodeViewingKey(key);
                expect(encoded.startsWith("menoid-vk1:")).to.equal(true);
                const decoded = decodeViewingKey(encoded);
                expect(decoded.kind).to.equal(key.kind);
                expect(decoded.userCommitment).to.equal(wallet.userCommitment);
            }

            // no viewing key carries the spending key
            for (const key of [fullViewingKey(wallet), incomingViewingKey(wallet), epochViewingKey(wallet, 0)]) {
                expect(JSON.stringify(key, (_, v) => (typeof v === "bigint" ? v.toString() : v))).to.not.include(
                    wallet.spend.sk.toString()
                );
            }

            const encoded = encodeViewingKey(fullViewingKey(wallet));
            const typo = encoded.slice(0, 20) + (encoded[20] === "A" ? "B" : "A") + encoded.slice(21);
            expect(() => decodeViewingKey(typo)).to.throw();
        });
    });

    describe("registration", function () {
        it("stores the user commitment and viewing key against the address", async function () {
            const signer = signers[3];
            const wallet = await deriveWallet(signer);

            await expect(pool.connect(signer).register(wallet.userCommitmentBytes32, wallet.viewing.ivkPub))
                .to.emit(pool, "Registered")
                .withArgs(signer.address, wallet.userCommitmentBytes32, wallet.viewing.ivkPub);

            const onChain = await resolveRecipient(pool, signer.address);
            expect(onChain.registered).to.equal(true);
            expect(onChain.userCommitment).to.equal(wallet.userCommitment);
            expect(onChain.viewingPublicKey).to.equal(wallet.viewing.ivkPub);
            expect(onChain.keyIndex).to.equal(0);
            expect(onChain.viewingEpoch).to.equal(0);
            expect(await pool.isRegistered(signer.address)).to.equal(true);
            expect(await pool.userCommitmentOwner(wallet.userCommitmentBytes32)).to.equal(signer.address);

            await assertRegisteredIdentity(pool, wallet);
        });

        it("answers an unregistered address with zeros instead of reverting", async function () {
            const stranger = ethers.Wallet.createRandom().address;
            const [uc, key, keyIndex, epoch] = await pool.registrationOf(stranger);
            expect(uc).to.equal(ethers.constants.HashZero);
            expect(key).to.equal("0x");
            expect(keyIndex).to.equal(0);
            expect(epoch).to.equal(0);
            expect(await pool.isRegistered(stranger)).to.equal(false);
        });

        it("rejects a second registration", async function () {
            const signer = signers[3];
            const wallet = await deriveWallet(signer, { keyIndex: 5 });
            await expect(
                pool.connect(signer).register(wallet.userCommitmentBytes32, wallet.viewing.ivkPub)
            ).to.be.revertedWith("Already registered");
        });

        it("rejects malformed values and a copied user commitment", async function () {
            const signer = signers[4];
            const wallet = await deriveWallet(signer);
            const victim = await deriveWallet(signers[3]);

            await expect(
                pool.connect(signer).register(wallet.userCommitmentBytes32, "0x1234")
            ).to.be.revertedWith("Invalid viewing public key");

            const compressed = ethers.utils.computePublicKey(wallet.viewing.ivkPub, true);
            await expect(
                pool.connect(signer).register(wallet.userCommitmentBytes32, compressed)
            ).to.be.revertedWith("Invalid viewing public key");

            await expect(
                pool.connect(signer).register(ethers.constants.HashZero, wallet.viewing.ivkPub)
            ).to.be.revertedWith("Invalid user commitment");

            await expect(
                pool.connect(signer).register(toBytes32(FIELD_SIZE), wallet.viewing.ivkPub)
            ).to.be.revertedWith("Invalid user commitment");

            // signers[3]'s commitment is already claimed: copying it is refused
            await expect(
                pool.connect(signer).register(victim.userCommitmentBytes32, wallet.viewing.ivkPub)
            ).to.be.revertedWith("User commitment already claimed");
        });

        it("moves to a new viewing epoch without changing the identity", async function () {
            const signer = signers[5];
            const wallet = await deriveWallet(signer);
            await registerWallet(pool, wallet);

            const next = await updateViewingKey(pool, wallet);
            const onChain = await resolveRecipient(pool, signer.address);

            expect(next.viewingEpoch).to.equal(1);
            expect(onChain.viewingEpoch).to.equal(1);
            expect(onChain.viewingPublicKey).to.equal(next.viewing.ivkPub);
            expect(onChain.userCommitment).to.equal(wallet.userCommitment);
        });

        it("rotates to a new identity under the next key index", async function () {
            const signer = signers[6];
            const wallet = await deriveWallet(signer);
            await registerWallet(pool, wallet);

            const rotated = await rotateKeys(pool, wallet);
            const onChain = await resolveRecipient(pool, signer.address);

            expect(rotated.keyIndex).to.equal(1);
            expect(onChain.keyIndex).to.equal(1);
            expect(onChain.viewingEpoch).to.equal(0);
            expect(onChain.userCommitment).to.equal(rotated.userCommitment);
            expect(onChain.userCommitment).to.not.equal(wallet.userCommitment);

            // the old identity no longer matches what senders resolve
            let error;
            try {
                await assertRegisteredIdentity(pool, wallet);
            } catch (e) {
                error = e;
            }
            expect(error && error.message).to.include("does not match");
            await assertRegisteredIdentity(pool, rotated);
        });

        it("only lets a registered address update or rotate keys", async function () {
            const signer = signers[7];
            const wallet = await deriveWallet(signer);
            await expect(
                pool.connect(signer).updateViewingKey(wallet.viewing.ivkPub)
            ).to.be.revertedWith("Not registered");
            await expect(
                pool.connect(signer).rotateKeys(wallet.userCommitmentBytes32, wallet.viewing.ivkPub)
            ).to.be.revertedWith("Not registered");
        });
    });
});
