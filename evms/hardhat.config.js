require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

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
        hardhat: MONAD_FORK_URL ? { forking: { url: MONAD_FORK_URL } } : {},

        localhost: {
            url: "http://127.0.0.1:8545"
        },

        monad: {
            url: "https://testnet-rpc.monad.xyz",
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        },

        sepolia: {
            url: process.env.SEPOLIA_RPC_URL,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        },

        baseSepolia: {
            url: process.env.BASE_SEPOLIA_RPC_URL,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        }
    }
};
