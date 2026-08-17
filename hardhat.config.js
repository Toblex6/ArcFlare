import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import "dotenv/config";

const config = {
    plugins: [hardhatEthers],

    solidity: {
        version: "0.8.24",
    },

    networks: {
        "arc-testnet": {
            type: "http",
            url: process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network",
            accounts: process.env.PRIVATE_KEY
                ? [process.env.PRIVATE_KEY]
                : [],
        },
    },
};

export default config;