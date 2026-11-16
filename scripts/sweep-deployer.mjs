// Owner-operated only. Dry-run by default. Never logs keys or RPC URLs.
import { JsonRpcProvider, Wallet, getAddress, formatEther } from 'ethers';

async function main() {
  if (process.argv.slice(2).some(a => a !== '--execute')) throw new Error('Only --execute is supported.');
  for (const name of ['ARC_MAINNET_RPC_URL', 'MAINNET_DEPLOYER_KEY', 'TREASURY_ADDRESS']) {
    if (!process.env[name]) throw new Error(`${name} is required.`);
  }
  const provider = new JsonRpcProvider(process.env.ARC_MAINNET_RPC_URL);
  try {
    if ((await provider.getNetwork()).chainId !== 5042n) throw new Error('Expected Arc mainnet chain 5042.');
    const signer = new Wallet(process.env.MAINNET_DEPLOYER_KEY, provider);
    const to = getAddress(process.env.TREASURY_ADDRESS);
    if (to === signer.address || to === '0x0000000000000000000000000000000000000000') throw new Error('Invalid treasury destination.');
    const balance = await provider.getBalance(signer.address);
    const fees = await provider.getFeeData();
    if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) throw new Error('Fee estimate unavailable.');
    const maxFeePerGas = fees.maxFeePerGas < 20_000_000_000n ? 20_000_000_000n : fees.maxFeePerGas;
    const estimatedGas = await provider.estimateGas({ from: signer.address, to, value: 1n });
    const gasLimit = estimatedGas * 120n / 100n;
    const reserve = gasLimit * maxFeePerGas;
    const value = balance - reserve;
    if (value <= 0n) throw new Error('Balance cannot cover the gas reserve.');
    console.log(JSON.stringify({ mode: process.argv.includes('--execute') ? 'execute' : 'dry-run', chainId: 5042, from: signer.address, to, balanceUSDC: formatEther(balance), transferUSDC: formatEther(value), gasReserveUSDC: formatEther(reserve) }, null, 2));
    if (!process.argv.includes('--execute')) return;
    // Re-estimate the actual amount; never silently increase the planned gas cap.
    if (await provider.estimateGas({ from: signer.address, to, value }) > gasLimit) throw new Error('Gas estimate changed; rerun dry-run.');
    const tx = await signer.sendTransaction({ to, value, gasLimit, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, chainId: 5042 });
    console.log(`Submitted: https://explorer.arc.io/tx/${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error('Sweep did not succeed.');
    console.log('Sweep confirmed.');
  } finally { provider.destroy(); }
}
main().catch(() => { console.error('Sweep stopped. Check required environment names, chain, destination, balance and RPC availability locally. No secrets printed.'); process.exitCode = 1; });
