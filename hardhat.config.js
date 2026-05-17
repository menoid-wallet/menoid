require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

module.exports = {
    solidity: {
        version: "0.8.20",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
            viaIR: true,
        },
    },

    networks: {
        localhost: {
            url: "http://127.0.0.1:8545"
        },

        monad: {
            url: "https://testnet-rpc.monad.xyz",
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
        }
    }
};