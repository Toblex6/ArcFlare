// Read-only by default. Only the operator may run this script with --execute.
import { readFile } from 'node:fs/promises';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, ZeroHash, formatEther, id } from 'ethers';
import {
  MAINNET_ESCROW_DEPLOYER,
  MAINNET_PRODUCTION_ROLES,
  assertMainnetFlareHQEscrowRoles,
  matchesMainnetEscrowSafe,
} from './mainnet-roles.mjs';

const chainId = 5042;
const token = '0x3600000000000000000000000000000000000000';
const rpc = process.env.ARC_MAINNET_RPC_URL ?? 'https://rpc.mainnet.arc.io';
const args = process.argv.slice(2);
const execute = args.length === 1 && args[0] === '--execute';

class PreflightError extends Error {}

async function verifySafe(provider, owner, blockTag) {
  const sentinel = '0x0000000000000000000000000000000000000001';
  const safe = new Contract(owner, [
    'function masterCopy() view returns (address)',
    'function VERSION() view returns (string)',
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
    'function nonce() view returns (uint256)',
    'function getModulesPaginated(address,uint256) view returns (address[],address)',
  ], provider);
  const at = { blockTag };
  const [code, singleton, version, owners, threshold, nonce, [modules, next], guard, moduleGuard] = await Promise.all([
    provider.getCode(owner, blockTag), safe.masterCopy(at), safe.VERSION(at), safe.getOwners(at),
    safe.getThreshold(at), safe.nonce(at), safe.getModulesPaginated(sentinel, 1, at),
    provider.getStorage(owner, id('guard_manager.guard.address'), blockTag),
    provider.getStorage(owner, id('module_manager.module_guard.address'), blockTag),
  ]);
  if (code === '0x' || !matchesMainnetEscrowSafe({ singleton, version, threshold, nonce, owners })
    || modules.length !== 0 || next !== sentinel || guard !== ZeroHash || moduleGuard !== ZeroHash
    || await provider.getCode(singleton, blockTag) === '0x') {
    throw new PreflightError('The production Safe configuration does not match the approved deployment roles.');
  }
  console.log(JSON.stringify({ safe: owner, singleton, version, owners, threshold: Number(threshold), nonce: Number(nonce), modules }));
}

async function main() {
  if (args.length && !execute) throw new PreflightError('Use no arguments for read-only preflight.');
  const { owner, arbiter: pinnedArbiter, treasurySink } = MAINNET_PRODUCTION_ROLES;
  const arbiter = process.env.ESCROW_ARBITER_ADDRESS ?? (execute ? undefined : pinnedArbiter);
  const treasury = process.env.ESCROW_TREASURY_ADDRESS ?? (execute ? undefined : treasurySink);
  const rawKey = process.env.MAINNET_DEPLOYER_KEY;
  if (execute && !rawKey) throw new PreflightError('MAINNET_DEPLOYER_KEY is required for --execute.');
  if (rawKey && !/^(0x)?[0-9a-f]{64}$/i.test(rawKey)) throw new PreflightError('MAINNET_DEPLOYER_KEY is invalid.');
  let signer;
  if (rawKey) {
    try { signer = new Wallet(rawKey); }
    catch { throw new PreflightError('MAINNET_DEPLOYER_KEY is invalid.'); }
  }
  const deployer = signer?.address ?? MAINNET_ESCROW_DEPLOYER;
  try { assertMainnetFlareHQEscrowRoles({ arbiter, treasury, deployer }); }
  catch (error) { throw new PreflightError(error.message); }

  const constructorArgs = [token, owner, pinnedArbiter, treasurySink];
  console.log(JSON.stringify({
    mode: execute ? 'operator-execute' : 'read-only',
    chainId,
    constructorArgs,
    deployer,
    keyAddressMatches: signer ? true : null,
  }, null, 2));

  const artifact = JSON.parse(await readFile(new URL('../artifacts/contracts/FlareHQEscrow.sol/FlareHQEscrow.json', import.meta.url), 'utf8'));
  const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  try {
    if (Number(await provider.send('eth_chainId', [])) !== chainId) throw new PreflightError('Expected Arc mainnet chain 5042.');
    const block = await provider.getBlock('latest');
    const [deployerBalance] = await Promise.all([
      provider.getBalance(deployer, block.number),
      verifySafe(provider, owner, block.number),
    ]);
    console.log(JSON.stringify({ block: block.number, blockHash: block.hash, deployerNativeUsdc: formatEther(deployerBalance) }));

    const factory = new ContractFactory(artifact.abi, artifact.bytecode);
    const { data } = await factory.getDeployTransaction(...constructorArgs);
    let gasEstimate;
    try {
      gasEstimate = await provider.estimateGas({ from: deployer, data });
    } catch {
      if (execute || deployerBalance !== 0n) throw new PreflightError('Constructor gas estimation failed.');
      // RPC-only state override permits estimation for the empty deployer.
      gasEstimate = BigInt(await provider.send('eth_estimateGas', [
        { from: deployer, data }, 'latest', { [deployer]: { balance: '0xde0b6b3a7640000' } },
      ]));
      console.log('Gas estimate used a simulated balance override.');
    }
    const { maxFeePerGas, gasPrice } = await provider.getFeeData();
    const feePerGas = maxFeePerGas ?? gasPrice;
    if (feePerGas === null) throw new PreflightError('Arc RPC did not return a gas price.');
    const gasCost = gasEstimate * feePerGas;
    console.log(JSON.stringify({
      gasEstimate: gasEstimate.toString(),
      quotedFeePerGasWei: feePerGas.toString(),
      estimatedMaxGasCostUsdc: formatEther(gasCost),
      balanceCoversEstimate: deployerBalance >= gasCost,
    }, null, 2));
    if (!execute) return;
    if (!signer || deployerBalance < gasCost) throw new PreflightError('Deployer cannot cover the estimated gas cost.');

    const contract = await factory.connect(signer.connect(provider)).deploy(...constructorArgs);
    console.log(`Deployment tx ${contract.deploymentTransaction().hash}`);
    await contract.waitForDeployment();
    const [address, deployedOwner, deployedArbiter, deployedTreasury, pendingOwner, feeBps, deployedToken] = await Promise.all([
      contract.getAddress(), contract.owner(), contract.arbiter(), contract.treasury(),
      contract.pendingOwner(), contract.FEE_BPS(), contract.token(),
    ]);
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    if (!same(deployedOwner, owner) || !same(deployedArbiter, pinnedArbiter) || !same(deployedTreasury, treasurySink)
      || pendingOwner !== ZeroAddress || feeBps !== 25n || !same(deployedToken, token)) {
      throw new PreflightError('Post-deploy roles or token mismatch. Keep ARC_MAINNET_ESCROW_ADDRESS unset.');
    }
    console.log(JSON.stringify({ address, deployedOwner, deployedArbiter, deployedTreasury, pendingOwner }));
  } finally {
    provider.destroy();
  }
}

main().catch((error) => {
  // Provider errors can include credentialed RPC URLs or request context.
  console.error(error instanceof PreflightError ? error.message : 'Deployment script failed. Check the local artifact, RPC and signer configuration.');
  process.exitCode = 1;
});
