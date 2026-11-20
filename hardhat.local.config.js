// Offline contract verification: no dotenv, live networks, or private keys.
import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import { join } from 'node:path';
const dir = process.env.FLAREHQ_BUILD_DIR;
export default {
  plugins: [hardhatEthers],
  solidity: { version: '0.8.24' },
  ...(dir && { paths: { artifacts: join(dir, 'artifacts'), cache: join(dir, 'cache') } }),
};
