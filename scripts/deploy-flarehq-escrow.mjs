// Read-only by default. Only the operator may run this script with --execute.
import { Contract, ContractFactory, JsonRpcProvider, ZeroAddress, ZeroHash, formatEther, id, keccak256 } from 'ethers';
import { buildMainnetContract, checkDeploymentRevision, PreflightError } from './lib/mainnet-contract-build.mjs';
import { resolveMainnetDeployerKey } from './lib/mainnet-deployer-key.mjs';
import {
  MAINNET_ESCROW_DEPLOYER,
  MAINNET_PRODUCTION_ROLES,
  assertMainnetFlareHQEscrowRoles,
  assertMainnetPayrollRoles,
  matchesMainnetEscrowSafe,
} from './mainnet-roles.mjs';

const chainId = 5042;
const token = '0x3600000000000000000000000000000000000000';
const rpc = process.env.ARC_MAINNET_RPC_URL ?? 'https://rpc.mainnet.arc.io';
const args = process.argv.slice(2);
const execute = args.length === 1 && args[0] === '--execute';
const replacements = args.length === 1 && args[0] === '--preview-replacements';
const escrow = 'FlareHQEscrow';
const source = `contracts/${escrow}.sol`;

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
  if (args.length && !execute && !replacements) throw new PreflightError('Use no arguments for escrow preflight, or --preview-replacements for read-only Payroll/SpendLimit estimates.');
  const reviewed = process.env.ESCROW_DEPLOY_COMMIT;
  if (execute || reviewed !== undefined) {
    const sources = replacements ? ['contracts/ArcFlarePayroll.sol', 'contracts/ArcFlareSpendLimit.sol'] : [source];
    for (const path of sources) checkDeploymentRevision(path, reviewed);
    console.log(`Reviewed revision: ${reviewed}`);
  }
  const { owner, arbiter: pinnedArbiter, treasurySink, relayer } = MAINNET_PRODUCTION_ROLES;
  const arbiter = process.env.ESCROW_ARBITER_ADDRESS ?? (execute ? undefined : pinnedArbiter);
  const treasury = process.env.ESCROW_TREASURY_ADDRESS ?? (execute ? undefined : treasurySink);
  // Read-only preflight also validates a supplied key, but never broadcasts.
  const rawKey = process.env.MAINNET_DEPLOYER_KEY;
  if (execute && !rawKey) throw new PreflightError('MAINNET_DEPLOYER_KEY is required for --execute.');
  let key;
  try { key = resolveMainnetDeployerKey(rawKey, MAINNET_ESCROW_DEPLOYER); }
  catch (error) { throw new PreflightError(error.message); }
  const { signer, deployer, keyAddressMatches } = key;
  try { assertMainnetFlareHQEscrowRoles({ arbiter, treasury, deployer }); }
  catch (error) { throw new PreflightError(error.message); }

  assertMainnetPayrollRoles({ owner, relayer }); // same address is SpendLimit recorder
  const deployments = replacements
    ? [['ArcFlarePayroll', [owner, relayer]], ['ArcFlareSpendLimit', [owner, relayer]]]
    : [[escrow, [token, owner, pinnedArbiter, treasurySink]]];
  console.log(JSON.stringify({
    mode: execute ? 'operator-execute' : 'read-only',
    chainId,
    deployments,
    deployer,
    keyAddressMatches,
  }, null, 2));

  const compiled = deployments.map(([name, argv]) => [name, argv, buildMainnetContract(name)]);
  const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  try {
    if (Number(await provider.send('eth_chainId', [])) !== chainId) throw new PreflightError('Expected Arc mainnet chain 5042.');
    const block = await provider.getBlock('latest');
    const [deployerBalance] = await Promise.all([
      provider.getBalance(deployer, block.number),
      verifySafe(provider, owner, block.number),
    ]);
    console.log(JSON.stringify({ block: block.number, blockHash: block.hash, deployerNativeUsdc: formatEther(deployerBalance) }));

    for (const [name, constructorArgs, artifact] of compiled) {
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
      contract: name,
      initCodeHash: keccak256(data),
      gasEstimate: gasEstimate.toString(),
      quotedFeePerGasWei: feePerGas.toString(),
      estimatedMaxGasCostUsdc: formatEther(gasCost),
      balanceCoversEstimate: deployerBalance >= gasCost,
    }, null, 2));
    if (!execute || name !== escrow) continue;
    if (!signer || deployerBalance < gasCost) throw new PreflightError('Deployer cannot cover the estimated gas cost.');

    const signerOnMainnet = signer.connect(provider);
    const request = await signerOnMainnet.populateTransaction({ data, gasLimit: gasEstimate,
      ...(maxFeePerGas !== null ? { maxFeePerGas } : { gasPrice: feePerGas }) });
    checkDeploymentRevision(source, reviewed);
    const deployment = await signerOnMainnet.sendTransaction(request);
    console.log(`Deployment tx ${deployment.hash}`);
    const receipt = await deployment.wait();
    if (receipt?.status !== 1 || !receipt.contractAddress) throw new PreflightError('Deployment did not produce a successful contract receipt.');
    const contract = new Contract(receipt.contractAddress, artifact.abi, provider);
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
    }
  } finally {
    provider.destroy();
  }
}

main().catch((error) => {
  // Provider errors can include credentialed RPC URLs or request context.
  console.error(error instanceof PreflightError ? error.message : 'Deployment script failed. Check the local artifact, RPC and signer configuration.');
  process.exitCode = 1;
});
