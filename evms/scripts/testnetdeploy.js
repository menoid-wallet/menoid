const hre = require("hardhat");

require("dotenv").config();

const {
    generatePrivateWallet
} = require("../helpers/wallets");



// =========================
// Deployment Logger
// =========================

async function logDeployment(
    name,
    contract
) {

    const receipt =
        await contract.deployTransaction.wait();

    const deployment = {

        address:
            contract.address,

        txHash:
            contract.deployTransaction.hash,

        blockNumber:
            receipt.blockNumber
    };

    console.log(`\n${name}`);
    console.log(deployment);

    return deployment;
}



async function main() {

    // =========================
    // Provider
    // =========================

    const provider =
        new hre.ethers.providers.JsonRpcProvider(
            hre.network.config.url
        );


    // =========================
    // Relayer Signer
    // =========================

    const relayerSigner =
        new hre.ethers.Wallet(
            process.env.PRIVATE_KEY,
            provider
        );

    console.log(
        "\nDeploying with:",
        relayerSigner.address
    );



    // =========================
    // Balance
    // =========================

    const balance =
        await provider.getBalance(
            relayerSigner.address
        );

    console.log(
        "Balance:",
        hre.ethers.utils.formatEther(balance),
        "MON"
    );



    // =========================
    // Generate Relayer Wallet
    // =========================

    const relayerWallet =
        await generatePrivateWallet(

            process.env.PRIVATE_KEY +
            "Menoid wallet"
        );

    console.log(
        "\n========== RELAYER =========="
    );

    console.log(relayerWallet);




    // =========================
    // PoseidonT3
    // =========================

    const PoseidonT3 =
        await hre.ethers.getContractFactory(
            "PoseidonT3",
            relayerSigner
        );

    const poseidonLib =
        await PoseidonT3.deploy();

    await poseidonLib.deployed();

    const poseidonLibInfo =
        await logDeployment(
            "PoseidonT3",
            poseidonLib
        );




    // =========================
    // PoseidonHasher
    // =========================

    const PoseidonHasher =
        await hre.ethers.getContractFactory(
            "PoseidonHasher",
            {
                libraries: {
                    PoseidonT3:
                        poseidonLib.address
                },
                signer: relayerSigner
            }
        );

    const poseidon =
        await PoseidonHasher.deploy();

    await poseidon.deployed();

    const poseidonInfo =
        await logDeployment(
            "PoseidonHasher",
            poseidon
        );




    // =========================
    // DepositVerifier
    // =========================

    const DepositVerifier =
        await hre.ethers.getContractFactory(
            "DepositVerifier",
            relayerSigner
        );

    const depositVerifier =
        await DepositVerifier.deploy();

    await depositVerifier.deployed();

    const depositVerifierInfo =
        await logDeployment(
            "DepositVerifier",
            depositVerifier
        );




    // =========================
    // TransferVerifier
    // =========================

    const TransferVerifier =
        await hre.ethers.getContractFactory(
            "TransferVerifier",
            relayerSigner
        );

    const transferVerifier =
        await TransferVerifier.deploy();

    await transferVerifier.deployed();

    const transferVerifierInfo =
        await logDeployment(
            "TransferVerifier",
            transferVerifier
        );




    // =========================
    // WithdrawVerifier
    // =========================

    const WithdrawVerifier =
        await hre.ethers.getContractFactory(
            "WithdrawVerifier",
            relayerSigner
        );

    const withdrawVerifier =
        await WithdrawVerifier.deploy();

    await withdrawVerifier.deployed();

    const withdrawVerifierInfo =
        await logDeployment(
            "WithdrawVerifier",
            withdrawVerifier
        );




    // =========================
    // CreateNoidAccountVerifier
    // =========================

    const CreateNoidAccountVerifier =
        await hre.ethers.getContractFactory(
            "CreateNoidAccountVerifier",
            relayerSigner
        );

    const createNoidAccountVerifier =
        await CreateNoidAccountVerifier.deploy();

    await createNoidAccountVerifier.deployed();

    const createNoidAccountVerifierInfo =
        await logDeployment(
            "CreateNoidAccountVerifier",
            createNoidAccountVerifier
        );




    // =========================
    // ExecuteFunctionCallVerifier
    // =========================

    const ExecuteFunctionCallVerifier =
        await hre.ethers.getContractFactory(
            "ExecuteFunctionCallVerifier",
            relayerSigner
        );

    const executeFunctionCallVerifier =
        await ExecuteFunctionCallVerifier.deploy();

    await executeFunctionCallVerifier.deployed();

    const executeFunctionCallVerifierInfo =
        await logDeployment(
            "ExecuteFunctionCallVerifier",
            executeFunctionCallVerifier
        );




    // =========================
    // NoidAccountOwnershipVerifier
    // =========================

    const NoidAccountOwnershipVerifier =
        await hre.ethers.getContractFactory(
            "NoidAccountOwnershipVerifier",
            relayerSigner
        );

    const noidAccountOwnershipVerifier =
        await NoidAccountOwnershipVerifier.deploy();

    await noidAccountOwnershipVerifier.deployed();

    const noidAccountOwnershipVerifierInfo =
        await logDeployment(
            "NoidAccountOwnershipVerifier",
            noidAccountOwnershipVerifier
        );




    // =========================
    // NoidPool
    // =========================

    const NoidPool =
        await hre.ethers.getContractFactory(
            "NoidPool",
            relayerSigner
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

    const noidPoolInfo =
        await logDeployment(
            "NoidPool",
            noidPool
        );




    // =========================
    // NoidAccountManager
    // =========================

    const NoidAccountManager =
        await hre.ethers.getContractFactory(
            "NoidAccountManager",
            relayerSigner
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

    const noidAccountManagerInfo =
        await logDeployment(
            "NoidAccountManager",
            noidAccountManager
        );




    // =========================
    // Set Manager In Pool
    // =========================

    const tx =
        await noidPool.setNoidAccountManager(
            noidAccountManager.address
        );

    const setManagerReceipt =
        await tx.wait();

    console.log(
        "\nNoidAccountManager linked to NoidPool"
    );

    console.log({

        txHash:
            tx.hash,

        blockNumber:
            setManagerReceipt.blockNumber
    });




    // =========================
    // Deployment Summary
    // =========================

    console.log(
        "\n========== DEPLOYMENT COMPLETE =========="
    );

    console.log({

        PoseidonT3:
            poseidonLibInfo,

        PoseidonHasher:
            poseidonInfo,

        DepositVerifier:
            depositVerifierInfo,

        TransferVerifier:
            transferVerifierInfo,

        WithdrawVerifier:
            withdrawVerifierInfo,

        CreateNoidAccountVerifier:
            createNoidAccountVerifierInfo,

        ExecuteFunctionCallVerifier:
            executeFunctionCallVerifierInfo,

        NoidAccountOwnershipVerifier:
            noidAccountOwnershipVerifierInfo,

        NoidPool:
            noidPoolInfo,

        NoidAccountManager:
            noidAccountManagerInfo
    });
}



main()
    .then(() => process.exit(0))
    .catch((error) => {

        console.error(error);

        process.exit(1);
    });

//MONAD TESTNET

/*
========== DEPLOYMENT COMPLETE ==========
{
  PoseidonT3: {
    address: '0x14e774B1973Fa30D8CB7Bd744048FbeAbc528334',
    txHash: '0x8df759631386470acde4766f8df8e948e8cff4b1a3cee21546c6da9a5aebca5e',
    blockNumber: 32790173
  },
  PoseidonHasher: {
    address: '0x8324e9DE2C8c48282697deD5E33C5BCF058E3392',
    txHash: '0x3859a5865f7294758284a520d82df5a12e45ae85bc55e3556d74b4298f4cf389',
    blockNumber: 32790180
  },
  DepositVerifier: {
    address: '0xF088a71aB6e83A60e752D3d881d259de8848Fc07',
    txHash: '0x183ac406eb59d863f3f59dc357a26a95d2dd9b07ab69a043d0ee422e07a5af35',
    blockNumber: 32790196
  },
  TransferVerifier: {
    address: '0x23Dcab364680c35d9eA9471987C51E19d75f098d',
    txHash: '0x142f15dbc57a1b1cf3044f3c712f9974525e2b54933aef1567c4ce121af40249',
    blockNumber: 32790203
  },
  WithdrawVerifier: {
    address: '0x6f9ECFB4e81Ea842f270a3eA2dEeB30f04DaA7c9',
    txHash: '0xa35be2b6757d12abb777839d9baee6008c9da88ba99b599d7d91b73eb9a9e43c',
    blockNumber: 32790219
  },
  CreateNoidAccountVerifier: {
    address: '0xe0B4c4F731b4D913ae95031BE2d5277B4019c487',
    txHash: '0x24ffa3a89728869772a8ce1eadf7933f93323d4e07fbeac03483b21069208f55',
    blockNumber: 32790226
  },
  ExecuteFunctionCallVerifier: {
    address: '0x320D75d60759Ed7B95917F97925375c3855feeF4',
    txHash: '0x12b4d12f273453388f94bd5d240b39eba9948062d3a1e6504341eaccc2e70965',
    blockNumber: 32790232
  },
  NoidAccountOwnershipVerifier: {
    address: '0xAae171c7de409f6c37BA92a6c3B83d52bd5dEac5',
    txHash: '0xb854c5901182c627db3be0a9879657bdef1849e4f2265242a771818b60c8fa54',
    blockNumber: 32790238
  },
  NoidPool: {
    address: '0xCc0857d3526674048235948d0d250F812b938751',
    txHash: '0xe539f8ce7c4fceef01ad3787f54a402dea0b4f4592db40b04a372ab66ffe0007',
    blockNumber: 32790244
  },
  NoidAccountManager: {
    address: '0xD184D35c4Fe39ecC2aE86a9E34f0Fb9a40198E02',
    txHash: '0xbde7faf85bd2bfac455b9cf80d1251388d539bb35a63790931867edb97e2cd67',
    blockNumber: 32790252
  }
}

*/
















// SEPOLIA TESTNET
/*
========== DEPLOYMENT COMPLETE ==========
{
  PoseidonT3: {
    address: '0x6AB8891c8C939f6E5654A6C6b2597f8e37E8789f',
    txHash: '0xa4514b262d22fe1a03187eced84306d23f7c4c59ae11a182762d1465e6e94110',
    blockNumber: 10995548
  },
  PoseidonHasher: {
    address: '0xb1E39bA4b9A04B3c6f8b8555daf18Ba1C8938Ea2',
    txHash: '0x6a852d645359077f332dcdb8671a175aa24dd0617eb1b589dc6dc83e6c832c9f',
    blockNumber: 10995549
  },
  DepositVerifier: {
    address: '0x21D6aE367a8F3d2ED61A49E205BF22e34333cFeb',
    txHash: '0x808628115dcf726f1a169c0b7818ac72ae131d7e6cb7f5802143cf82d2fc6c73',
    blockNumber: 10995550
  },
  TransferVerifier: {
    address: '0x6a42B131e28ee3257339FB06dbFa296aF80135f0',
    txHash: '0xbfec033a32743661f6368387f7594b032fd452ea81744054dc1117bb6c77278d',
    blockNumber: 10995551
  },
  WithdrawVerifier: {
    address: '0xc7b23B23913A08895c234a30BB3E9b790c4F7453',
    txHash: '0xcb044cd0b13c2ffa0366b21e56937d6266133d1ed135fe577a60d8b669884534',
    blockNumber: 10995552
  },
  CreateNoidAccountVerifier: {
    address: '0x06E2102A2FA7fECffCD0d24737f38863C80827B8',
    txHash: '0xbe407661a1c57bfc81316453ba338a902121d09f56433b551c7ed7ede2408e5b',
    blockNumber: 10995553
  },
  ExecuteFunctionCallVerifier: {
    address: '0xA40058d68dbbBded64365088e8c52C8f1aBee09A',
    txHash: '0x9ca36b14873fd4e4b742e3387d2b04c70279cfb13a1b2804dba0c9a43515fd33',
    blockNumber: 10995554
  },
  NoidAccountOwnershipVerifier: {
    address: '0x456638Cae7bcba46806424CF559b61baB7A5CD0A',
    txHash: '0x366a83345f839760cd4e541ceaaa3075273592b17ea4e84a72ce9073bfa831be',
    blockNumber: 10995555
  },
  NoidPool: {
    address: '0x8EE55aC1710D02f9d6a696C053e9c39e47aaE08D',
    txHash: '0xe04afbcb8bffca870bb0cbf8e7a878b6050365f7d853832c212d64fccad4f17b',
    blockNumber: 10995556
  },
  NoidAccountManager: {
    address: '0x794B3cb8f9186b5B437e659C8ACa8e96bF663078',
    txHash: '0xa9289e5e2eeaa4cedfe59d4bbfc799d32ff81b008328d0ccbb9f4db8a3bc8083',
    blockNumber: 10995557
  }
}
*/













// BASESEPOLIA TESTNET
/*
{
  PoseidonT3: {
    address: '0x6AB8891c8C939f6E5654A6C6b2597f8e37E8789f',
    txHash: '0x0712ade38486851b7126b33b65585886dad1a16c13cc03f51611be0dbeecee6a',
    blockNumber: 42451561
  },
  PoseidonHasher: {
    address: '0xb1E39bA4b9A04B3c6f8b8555daf18Ba1C8938Ea2',
    txHash: '0xbe5e25e470eae54e625f5f6451a6acba3dc8c6deffd44b264518df71100a11e2',
    blockNumber: 42451563
  },
  DepositVerifier: {
    address: '0x21D6aE367a8F3d2ED61A49E205BF22e34333cFeb',
    txHash: '0x5f419078a6a7a1f64fe03c72a3ae7d3ca6123b721faad6d4b2efd3ef8342d1f3',
    blockNumber: 42451564
  },
  TransferVerifier: {
    address: '0x6a42B131e28ee3257339FB06dbFa296aF80135f0',
    txHash: '0xbd65da62bb1ec00ace969f1040c5238aa69721dff1b4512150262bbdccc1b29d',
    blockNumber: 42451564
  },
  WithdrawVerifier: {
    address: '0xc7b23B23913A08895c234a30BB3E9b790c4F7453',
    txHash: '0x4bfcdc81e0767808e42832a4d946b163ba8376104d55b82004921aabc9a064f8',
    blockNumber: 42451565
  },
  CreateNoidAccountVerifier: {
    address: '0x06E2102A2FA7fECffCD0d24737f38863C80827B8',
    txHash: '0x9836b5643d84c0de78a9ad77a5cf01f476a31c728240ca2e69f5228f921557a7',
    blockNumber: 42451568
  },
  ExecuteFunctionCallVerifier: {
    address: '0xA40058d68dbbBded64365088e8c52C8f1aBee09A',
    txHash: '0x9df35f069183aefe9a6833f0fa3b625483397772d8a37035ccda6bdf245db5a0',
    blockNumber: 42451570
  },
  NoidAccountOwnershipVerifier: {
    address: '0x456638Cae7bcba46806424CF559b61baB7A5CD0A',
    txHash: '0xf1721935237e0afff39566753c20acec8be916330ee47013affc7a5910d16727',
    blockNumber: 42451573
  },
  NoidPool: {
    address: '0x8EE55aC1710D02f9d6a696C053e9c39e47aaE08D',
    txHash: '0xc733723e6170355b82d952b0b372a8d129034afe9d32e7d601525f4d0192430b',
    blockNumber: 42451574
  },
  NoidAccountManager: {
    address: '0x794B3cb8f9186b5B437e659C8ACa8e96bF663078',
    txHash: '0xf20364ec0cc39b2f27782dabb3c7d4086c254c6955d684186baff689a48f0124',
    blockNumber: 42451574
  }
}
*/