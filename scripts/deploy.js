const hre = require("hardhat");

const {
    generatePrivateWallet
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



    // derive relayer wallet
    const relayerSignature =
        await relayerSigner.signMessage(
            "PriFi private financial dapp"
        );

    const relayerWallet =
        await generatePrivateWallet(
            relayerSignature
        );

    console.log("\n========== RELAYER ==========");
    console.log(relayerWallet);




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
    // Create Noid Account Verifier
    // =========================

    const CreateNoidAccountVerifier =
        await hre.ethers.getContractFactory(
            "CreateNoidAccountVerifier"
        );

    const createNoidAccountVerifier =
        await CreateNoidAccountVerifier.deploy();

    await createNoidAccountVerifier.deployed();

    console.log(
        "CreateNoidAccountVerifier:",
        createNoidAccountVerifier.address
    );




    // =========================
    // Execute Function Call Verifier
    // =========================

    const ExecuteFunctionCallVerifier =
        await hre.ethers.getContractFactory(
            "ExecuteFunctionCallVerifier"
        );

    const executeFunctionCallVerifier =
        await ExecuteFunctionCallVerifier.deploy();

    await executeFunctionCallVerifier.deployed();

    console.log(
        "ExecuteFunctionCallVerifier:",
        executeFunctionCallVerifier.address
    );




    // =========================
    // Noid Account Ownership Verifier
    // =========================

    const NoidAccountOwnershipVerifier =
        await hre.ethers.getContractFactory(
            "NoidAccountOwnershipVerifier"
        );

    const noidAccountOwnershipVerifier =
        await NoidAccountOwnershipVerifier.deploy();

    await noidAccountOwnershipVerifier.deployed();

    console.log(
        "NoidAccountOwnershipVerifier:",
        noidAccountOwnershipVerifier.address
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

            // relayer zk public key
            relayerWallet.zk.publicKey
        );

    await noidPool.deployed();

    console.log(
        "NoidPool:",
        noidPool.address
    );




    // =========================
    // Noid Account Manager
    // =========================

    const NoidAccountManager =
        await hre.ethers.getContractFactory(
            "NoidAccountManager"
        );

    const noidAccountManager =
        await NoidAccountManager.deploy(

            noidPool.address,

            createNoidAccountVerifier.address,

            executeFunctionCallVerifier.address,

            noidAccountOwnershipVerifier.address,

            relayerWallet.zk.publicKey
        );

    await noidAccountManager.deployed();

    console.log(
        "NoidAccountManager:",
        noidAccountManager.address
    );




    // =========================
    // Set Manager In Pool
    // =========================

    const tx =
        await noidPool.setNoidAccountManager(
            noidAccountManager.address
        );

    await tx.wait();

    console.log(
        "NoidAccountManager set inside NoidPool"
    );




    console.log("\n========== DEPLOYMENT DONE ==========");
}


main()
    .then(() => process.exit(0))
    .catch((error) => {

        console.error(error);

        process.exit(1);
    });

/*
Deploying with: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
0x047342c9d7eddcc5a0b02444cac3d4940c649b8d22f024ff6d00e08546b283e6bfd45442b05ad9fa8c49c8c949874cbf89fee56cc4fca7f2daf59dad7a9de19106|10268557976706044588094476139933715693040541178007860682204136266919241387488
========== RELAYER ==========
{
  privateWallet: {
    address: '0x30c4e4b19C889f2fAe750f9E89E853F8CbF7ba75',
    privateKey: '0x4e4c7393dfa53d4f5071d3683d71edede446d35e6dc2229426762da2155ed4d6',
    publicKey: '0x04dbaf8353dd317c2ce971fdca68e1d9cdf9e000521515fdd66259207e81fbd9c1f7c1b4431d50abc7e1d8ca0b96ddf7a8554632c8111bdfaaf69e8588be0afbdb'
  },
  zk: {
    secretKey: '35415480253912593114309205833580744011029402384713259246801032468506909529302',
    publicKey: '19419355756837366063940935872633702255385755990257795758973950206601037608501'
  }
}
PoseidonT3 Library: 0x5FbDB2315678afecb367f032d93F642f64180aa3
PoseidonHasher: 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
DepositVerifier: 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
TransferVerifier: 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
WithdrawVerifier: 0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9
CreateNoidAccountVerifier: 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
ExecuteFunctionCallVerifier: 0x0165878A594ca255338adfa4d48449f69242Eb8F
NoidAccountOwnershipVerifier: 0xa513E6E4b8f2a923D98304ec87F64353C4D5C853
NoidPool: 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6
NoidAccountManager: 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318
NoidAccountManager set inside NoidPool
*/