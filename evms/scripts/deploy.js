const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const {
    deriveWallet
} = require("../helpers/wallets");

async function main() {

    const signers =
        await hre.ethers.getSigners();

    // relayer signer
    const relayerSigner = signers[0];

    console.log(
        "Deploying with:",
        relayerSigner.address
    );



    // derive relayer noid keys (spending keypair + user commitment)
    const relayerWallet =
        await deriveWallet(relayerSigner);

    console.log("\n========== RELAYER ==========");
    console.log({
        address: relayerWallet.address,
        spendPublicKey: relayerWallet.spend.publicKey,
        userCommitment: relayerWallet.userCommitment
    });




    // =========================
    // Poseidon Library
    // =========================

    const PoseidonT3 =
        await hre.ethers.getContractFactory(
            "PoseidonT3"
        );

    const poseidonLib =
        await PoseidonT3.deploy();

    await poseidonLib.deployed();

    console.log(
        "PoseidonT3 Library:",
        poseidonLib.address
    );




    // =========================
    // Poseidon Wrapper
    // =========================

    const PoseidonHasher =
        await hre.ethers.getContractFactory(
            "PoseidonHasher",
            {
                libraries: {
                    PoseidonT3:
                        poseidonLib.address
                }
            }
        );

    const poseidon =
        await PoseidonHasher.deploy();

    await poseidon.deployed();

    console.log(
        "PoseidonHasher:",
        poseidon.address
    );




    // =========================
    // Deposit Verifier
    // =========================

    const DepositVerifier =
        await hre.ethers.getContractFactory(
            "DepositVerifier"
        );

    const depositVerifier =
        await DepositVerifier.deploy();

    await depositVerifier.deployed();

    console.log(
        "DepositVerifier:",
        depositVerifier.address
    );




    // =========================
    // Transfer Verifier
    // =========================

    const TransferVerifier =
        await hre.ethers.getContractFactory(
            "TransferVerifier"
        );

    const transferVerifier =
        await TransferVerifier.deploy();

    await transferVerifier.deployed();

    console.log(
        "TransferVerifier:",
        transferVerifier.address
    );




    // =========================
    // Withdraw Verifier
    // =========================

    const WithdrawVerifier =
        await hre.ethers.getContractFactory(
            "WithdrawVerifier"
        );

    const withdrawVerifier =
        await WithdrawVerifier.deploy();

    await withdrawVerifier.deployed();

    console.log(
        "WithdrawVerifier:",
        withdrawVerifier.address
    );




    // =========================
    // Noid Pool
    // =========================

    const NoidPool =
        await hre.ethers.getContractFactory(
            "NoidPool"
        );

    const noidPool =
        await NoidPool.deploy(

            depositVerifier.address,

            transferVerifier.address,

            withdrawVerifier.address,

            poseidon.address,

            // relayer eth address
            relayerSigner.address,

            // relayer user commitment
            relayerWallet.userCommitment.decimal
        );

    await noidPool.deployed();

    // The block the pool landed in. The backend indexer and the wallet's note
    // scan both start from here — starting at genesis on Sepolia is minutes of
    // pointless eth_getLogs paging.
    const deployReceipt =
        await noidPool
            .deployTransaction
            .wait();

    console.log(
        "NoidPool:",
        noidPool.address,
        "(block",
        deployReceipt.blockNumber + ")"
    );




    // =========================
    // Register Relayer
    // =========================

    const registerTx =
        await noidPool
            .connect(relayerSigner)
            .register(
                relayerWallet.userCommitment.bytes32,
                relayerWallet.encryption.publicKey
            );

    await registerTx.wait();

    console.log(
        "Relayer registered:",
        relayerWallet.userCommitment.bytes32
    );




    // =========================
    // Save Deployment Addresses
    // =========================

    const deployments = {

        network: hre.network.name,

        poseidonT3: poseidonLib.address,

        poseidonHasher: poseidon.address,

        depositVerifier: depositVerifier.address,

        transferVerifier: transferVerifier.address,

        withdrawVerifier: withdrawVerifier.address,

        noidPool: noidPool.address,

        relayer: {
            address: relayerSigner.address,
            userCommitment: relayerWallet.userCommitment,
            encryptionPublicKey: relayerWallet.encryption.publicKey
        },

        // The block the pool was deployed in — the backend indexer and the
        // wallet's note scan both start here instead of at genesis.
        deployBlock: deployReceipt.blockNumber
    };

    const deploymentsDir =
        path.join(__dirname, "..", "deployments");

    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir);
    }

    const deploymentsFile =
        path.join(
            deploymentsDir,
            `${hre.network.name}.json`
        );

    fs.writeFileSync(
        deploymentsFile,
        JSON.stringify(deployments, null, 4)
    );

    console.log(
        "\nDeployment addresses written to:",
        deploymentsFile
    );

    console.log("\n========== DEPLOYMENT DONE ==========");
}


main()
    .then(() => process.exit(0))
    .catch((error) => {

        console.error(error);

        process.exit(1);
    });
