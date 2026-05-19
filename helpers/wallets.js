const { ethers } = require("ethers");
const circomlibjs = require("circomlibjs");

async function generatePrivateWallet(seedInput) {

    const poseidon = await circomlibjs.buildPoseidon();

    // deterministic seed
    const seed = ethers.utils.keccak256(ethers.utils.toUtf8Bytes( seedInput ));

    // derived private wallet
    const privateWallet = new ethers.Wallet(seed);

    // zk secret key
    const sk = ethers.BigNumber.from(
        privateWallet.privateKey
    ).toString();

    // zk public key
    const pk = poseidon.F.toString(
        poseidon([3, sk])
    );

    return {

        privateWallet: {
            address: privateWallet.address,
            privateKey: privateWallet.privateKey,
            publicKey: privateWallet.publicKey
        },

        zk: {
            secretKey: sk,
            publicKey: pk
        }
    };
}

module.exports = {
    generatePrivateWallet
};