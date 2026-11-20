// scripts/deploy-flarehq-escrow.mjs
//
// FlareHQEscrow mainnet deployment. DRY-RUN BY DEFAULT.
//
//   node scripts/deploy-flarehq-escrow.mjs
//       Prints the exact constructor args + post-deploy verification commands.
//       No RPC connection, no key read, no transaction.
//
//   node scripts/deploy-flarehq-escrow.mjs --execute
//       Requires:
//         MAINNET_DEPLOYER_KEY       dedicated deployer private key (never logged)
//         ESCROW_ARBITER_ADDRESS     arbiter role
//         ESCROW_TREASURY_ADDRESS    fee recipient
//       Optional:
//         ARC_MAINNET_RPC_URL        defaults to https://rpc.mainnet.arc.io
//         ARC_MAINNET_USDC_ADDRESS   defaults to canonical Arc USDC
//       Refuses to run on any chain other than 5042 and refuses the Safe as
//       the deployer. The owner is hard-pinned to the Safe.
//
// The owner is set in the constructor, so ownership never sits with the
// deployer key. After deployment, keep ARC_MAINNET_ESCROW_ADDRESS unset until
// the printed verification commands pass.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OWNER_SAFE = '0xb54f4Fa6F155CAb249f6Bbc194F2D5f363d4D9b4';
const ARC_MAINNET_CHAIN_ID = 5042;
const ARC_MAINNET_USDC = '0x3600000000000000000000000000000000000000';

const execute = process.argv.includes('--execute');
const unknown = process.argv.slice(2).filter((a) => a !== '--execute');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(' ')}`);
  process.exit(1);
}

function requireAddress(name, value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? '')) {
    throw new Error(`${name} must be a valid 0x address.`);
  }
  return value;
}

const token = requireAddress('ARC_MAINNET_USDC_ADDRESS', process.env.ARC_MAINNET_USDC_ADDRESS ?? ARC_MAINNET_USDC);
const arbiter = execute
  ? requireAddress('ESCROW_ARBITER_ADDRESS', process.env.ESCROW_ARBITER_ADDRESS)
  : (process.env.ESCROW_ARBITER_ADDRESS ?? '<set ESCROW_ARBITER_ADDRESS>');
const treasury = execute
  ? requireAddress('ESCROW_TREASURY_ADDRESS', process.env.ESCROW_TREASURY_ADDRESS)
  : (process.env.ESCROW_TREASURY_ADDRESS ?? '<set ESCROW_TREASURY_ADDRESS>');
const rpc = process.env.ARC_MAINNET_RPC_URL ?? 'https://rpc.mainnet.arc.io';

const constructorArgs = [token, OWNER_SAFE, arbiter, treasury];

const verification = [
  `cast call <ESCROW> "owner()(address)" --rpc-url ${rpc}`,
  `cast call <ESCROW> "arbiter()(address)" --rpc-url ${rpc}`,
  `cast call <ESCROW> "treasury()(address)" --rpc-url ${rpc}`,
  `cast call <ESCROW> "FEE_BPS()(uint256)" --rpc-url ${rpc}`,
  `cast call <ESCROW> "token()(address)" --rpc-url ${rpc}`,
  `cast code <ESCROW> --rpc-url ${rpc}`,
  'Then set ARC_MAINNET_ESCROW_ADDRESS on Render only AFTER owner/arbiter/treasury/FEE_BPS/token all match.',
];

if (!execute) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    chainId: ARC_MAINNET_CHAIN_ID,
    rpc,
    deployer: 'MAINNET_DEPLOYER_KEY (read only with --execute; never printed)',
    ownerSafe: OWNER_SAFE,
    constructorArgs,
    constructorSignature: 'constructor(address token_, address owner_, address arbiter_, address treasury_)',
    requireBeforeExecute: ['MAINNET_DEPLOYER_KEY', 'ESCROW_ARBITER_ADDRESS', 'ESCROW_TREASURY_ADDRESS'],
    postDeployVerification: verification,
    next: 'Review, then run with --execute. Keep ARC_MAINNET_ESCROW_ADDRESS unset until verification passes.',
  }, null, 2));
  process.exit(0);
}

if (!process.env.MAINNET_DEPLOYER_KEY) {
  console.error('MAINNET_DEPLOYER_KEY is required for --execute.');
  process.exit(1);
}
if (!existsSync('artifacts/contracts/FlareHQEscrow.sol/FlareHQEscrow.json')) {
  console.error('Missing FlareHQEscrow artifact. Run: npx hardhat compile');
  process.exit(1);
}

process.env.ARC_MAINNET_RPC_URL = rpc;
const { JsonRpcProvider, Wallet, ContractFactory } = await import('ethers');
const provider = new JsonRpcProvider(rpc);

const net = await provider.getNetwork();
if (Number(net.chainId) !== ARC_MAINNET_CHAIN_ID) {
  console.error(`Refusing to deploy: connected chain is ${net.chainId}, expected ${ARC_MAINNET_CHAIN_ID}.`);
  process.exit(1);
}

const deployer = new Wallet(process.env.MAINNET_DEPLOYER_KEY, provider);
if (deployer.address.toLowerCase() === OWNER_SAFE.toLowerCase()) {
  console.error('Refusing to deploy: the deployer is the owner Safe. Use a dedicated deployer key.');
  process.exit(1);
}

const artifact = JSON.parse(await readFile('artifacts/contracts/FlareHQEscrow.sol/FlareHQEscrow.json', 'utf8'));
const factory = new ContractFactory(artifact.abi, artifact.bytecode, deployer);

console.log(`Deploying FlareHQEscrow on chain ${net.chainId} from ${deployer.address}`);
console.log(`Constructor args: ${JSON.stringify(constructorArgs)}`);
const contract = await factory.deploy(...constructorArgs);
const tx = contract.deploymentTransaction();
console.log(`Deploy tx: ${tx?.hash}`);
await contract.waitForDeployment();
const address = await contract.getAddress();
console.log(`FlareHQEscrow deployed: ${address}`);

const checks = {
  owner: await contract.owner(),
  arbiter: await contract.arbiter(),
  treasury: await contract.treasury(),
  feeBps: (await contract.FEE_BPS()).toString(),
  token: await contract.token(),
};
console.log(JSON.stringify({ address, chainId: Number(net.chainId), ...checks }, null, 2));
if (checks.owner.toLowerCase() !== OWNER_SAFE.toLowerCase() ||
    checks.arbiter.toLowerCase() !== arbiter.toLowerCase() ||
    checks.treasury.toLowerCase() !== treasury.toLowerCase() ||
    checks.feeBps !== '25' ||
    checks.token.toLowerCase() !== token.toLowerCase()) {
  console.error('Post-deploy verification FAILED. Do not set ARC_MAINNET_ESCROW_ADDRESS.');
  process.exit(1);
}
console.log('Post-deploy verification passed. Keep ARC_MAINNET_ESCROW_ADDRESS unset until an independent read confirms these values.');
