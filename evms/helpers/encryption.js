const { encrypt, decrypt } = require("eciesjs");

const {
    arrayify,
    hexlify,
    toUtf8Bytes,
    toUtf8String
} = require("ethers/lib/utils");


// encrypt plaintext using public key
function encryptMessage(message, publicKey) {

    const messageBytes =
        toUtf8Bytes(message);

    const publicKeyBytes =
        arrayify(publicKey);

    const encrypted =
        encrypt(publicKeyBytes, messageBytes);

    return hexlify(encrypted);
}


// decrypt ciphertext using private key
function decryptMessage(ciphertextHex, privateKey) {

    const ciphertextBytes =
        arrayify(ciphertextHex);

    const privateKeyBytes =
        arrayify(privateKey);

    const decrypted =
        decrypt(privateKeyBytes, ciphertextBytes);

    return toUtf8String(decrypted);
}


module.exports = {

    encryptMessage,
    decryptMessage
};