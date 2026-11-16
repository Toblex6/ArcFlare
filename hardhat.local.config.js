// Offline contract verification: no dotenv, live networks, or private keys.
import hardhatEthers from '@nomicfoundation/hardhat-ethers';
export default { plugins: [hardhatEthers], solidity: { version: '0.8.24' } };
