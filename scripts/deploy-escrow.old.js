// scripts/deploy-escrow.js
// Run: npx hardhat run scripts/deploy-escrow.js --network arc_testnet

const hre = require('hardhat');

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log('Deploying with:', deployer.address);

  // Arc testnet USDC — update if mainnet
  // Testnet: get from https://faucet.circle.com
  const USDC_ADDRESS = process.env.USDC_ADDRESS;
  const MEDIATOR_ADDRESS = process.env.MEDIATOR_ADDRESS || deployer.address;

  if (!USDC_ADDRESS) {
    throw new Error('Set USDC_ADDRESS in .env');
  }

  const EscrowFactory = await hre.ethers.getContractFactory('ArcFlareEscrow');
  const escrow = await EscrowFactory.deploy(USDC_ADDRESS, MEDIATOR_ADDRESS);
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  console.log('✅ ArcFlareEscrow deployed to:', address);
  console.log('\nAdd to your .env:');
  console.log(`ESCROW_CONTRACT_ADDRESS=${address}`);
  console.log(`MEDIATOR_ADDRESS=${MEDIATOR_ADDRESS}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
