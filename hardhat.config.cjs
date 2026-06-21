require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config({ path: '.env.local' });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: '0.8.20',
  networks: {
    'arc-testnet': {
      url: process.env.ARC_TESTNET_RPC || 'https://rpc-testnet.arc.xyz',
      // Ensure you have a PRIVATE_KEY variable set in your .env.local file
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
