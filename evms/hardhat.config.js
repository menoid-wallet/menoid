require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

// keys work with or without the 0x prefix
const withPrefix = (key) => (key && !key.startsWith("0x") ? `0x${key}` : key || "");
const PRIVATE_KEY = withPrefix(process.env.PRIVATE_KEY);
// the mainnet deployer / owner / relayer: never the testnet key
const MAINNET_PRIVATE_KEY = withPrefix(process.env.MAINNET_PRIVATE_KEY);

// MONAD_FORK_URL=https://rpc.monad.xyz npx hardhat test test/fork/monad-swap.fork.js
// runs the in-process network on a fork of Monad mainnet (real Uniswap V3, WMON, USDC).
const MONAD_FORK_URL = process.env.MONAD_FORK_URL;

module.exports = {
    solidity: {
    version: "0.8.20",
    settings: {
        optimizer: {
        enabled: true,
        runs: 200
        },
        viaIR: false
    }
    },

    // every transfer/withdraw test generates a Groth16 proof
    mocha: {
        timeout: 600000
    },

    networks: {
        // FORK_CHAIN_ID makes a forked node report the real chain id (143 for
        // Monad mainnet), so a rehearsal uses mainnet keys and verifiers
        hardhat: {
            ...(MONAD_FORK_URL ? { forking: { url: MONAD_FORK_URL } } : {}),
            ...(process.env.FORK_CHAIN_ID ? { chainId: Number(process.env.FORK_CHAIN_ID) } : {}),
            // a fork runs calls at its fork block with these rules (Hardhat has no history for these chains)
            chains: {
                143: { hardforkHistory: { cancun: 0 } },
                8453: { hardforkHistory: { cancun: 0 } }
            }
        },

        localhost: {
            url: "http://127.0.0.1:8545"
        },

        monad: {
            url: "https://testnet-rpc.monad.xyz",
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        },

        // v1-mainnet on Monad testnet. `monad` above is the V1 demo's network:
        // a separate name keeps their deployment records apart.
        monadTestnet: {
            url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
            chainId: 10143,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        },

        // a rehearsal on a local fork of Monad testnet; nothing reaches the chain:
        //   npx hardhat node --fork https://testnet-rpc.monad.xyz --port 8546
        monadTestnetFork: {
            url: "http://127.0.0.1:8546",
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        },

        sepolia: {
            url: process.env.SEPOLIA_RPC_URL,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        },

        baseSepolia: {
            url: process.env.BASE_SEPOLIA_RPC_URL,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        },

        // v1-mainnet on Monad MAINNET (chain 143). Its own key: MAINNET_PRIVATE_KEY
        // deploys, owns the pool (move ownership to a multisig before real use)
        // and is the relayer. PRIVATE_KEY above stays the testnet key.
        monadMainnet: {
            url: process.env.MONAD_MAINNET_RPC_URL || "https://rpc.monad.xyz",
            chainId: 143,
            accounts: MAINNET_PRIVATE_KEY ? [MAINNET_PRIVATE_KEY] : []
        },

        // a free rehearsal on a local fork of Monad mainnet (nothing reaches the chain):
        //   FORK_CHAIN_ID=143 npx hardhat node --fork https://rpc.monad.xyz --port 8547
        monadMainnetFork: {
            url: "http://127.0.0.1:8547",
            chainId: 143
        },

        // v1-mainnet on Base MAINNET (chain 8453): the same key as Monad mainnet
        // (MAINNET_PRIVATE_KEY deploys, owns and relays), Uniswap's own V3.
        baseMainnet: {
            url: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
            chainId: 8453,
            accounts: MAINNET_PRIVATE_KEY ? [MAINNET_PRIVATE_KEY] : [],
            // a fixed, Base-sized price (wei): base fee ~0.005 gwei + tip ~0.001.
            // Library defaults assume Ethereum's 1-2 gwei tips: hundreds of times
            // too much here, more than a small deployer balance can cover.
            gasPrice: Number(process.env.BASE_GAS_PRICE_WEI || 12000000)
        },

        // a free rehearsal on a local fork of Base mainnet (nothing reaches the chain):
        //   FORK_CHAIN_ID=8453 npx hardhat node --fork https://base-mainnet.public.blastapi.io --port 8548
        baseMainnetFork: {
            url: "http://127.0.0.1:8548",
            chainId: 8453
        },

        // v1-mainnet on Base Sepolia, against Uniswap's own V3 deployment.
        // `baseSepolia` above is the V1 demo's network: a separate name keeps
        // their deployment records apart.
        baseSepoliaV1m: {
            url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
            chainId: 84532,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        }
    }
};
