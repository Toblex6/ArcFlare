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
        // Defaults to Circle's public mainnet endpoint (chain 5042). Any
        // deploy script still asserts eth_chainId === 5042, so a wrong URL
        // fails closed before a transaction. Deployer key MUST be a dedicated
        // mainnet deployer — never reuse a testnet key carrying unrelated funds.
        "arc-mainnet": {
            type: "http",
            url: process.env.ARC_MAINNET_RPC_URL || "https://rpc.mainnet.arc.io",
            accounts: process.env.MAINNET_DEPLOYER_KEY
                ? [process.env.MAINNET_DEPLOYER_KEY]
                : [],
        },
    },
};

export default config;