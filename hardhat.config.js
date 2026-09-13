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
        // Mainnet preparation (no mainnet deployment yet — do NOT use until
        // the Arc mainnet RPC + chain ID are confirmed and deployment scripts
        // have been reviewed for mainnet constructor args/fees).
        // Requires ARC_MAINNET_RPC_URL; fails closed when unset (empty URL =
        // Hardhat refuses to connect rather than silently targeting testnet).
        // Deployer key MUST be a dedicated mainnet deployer — never reuse a
        // testnet key carrying unrelated funds.
        "arc-mainnet": {
            type: "http",
            url: process.env.ARC_MAINNET_RPC_URL || "",
            accounts: process.env.MAINNET_DEPLOYER_KEY
                ? [process.env.MAINNET_DEPLOYER_KEY]
                : [],
        },
    },
};

export default config;