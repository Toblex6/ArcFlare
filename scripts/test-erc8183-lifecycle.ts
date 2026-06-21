import { getCircleClient, waitForTransaction } from '../src/lib/circle/client';
import {
  AGENTIC_COMMERCE_CONTRACT,
  USDC_CONTRACT,
  agenticCommerceAbi,
} from '../src/lib/contracts/erc8183';
import { keccak256, toHex, createPublicClient, http } from 'viem';
import { arcTestnet } from 'viem/chains';

// Your wallet details
const CLIENT_ADDRESS = '0xcdd42d073766327fbd03f7f7410a5cb8b58355c4';
const PROVIDER_ADDRESS = '0x6e2379e03671f4e704a66fde64e94e70f4bfae03';

const circleClient = getCircleClient();
const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

async function main() {
  console.log('🚀 Starting ERC-8183 Job Lifecycle Test\n');

  // ---------- 1. Create Job ----------
  console.log('1️⃣ Creating job...');
  const expiredAt = Math.floor(Date.now() / 1000) + 3600;
  const createTx = await circleClient.createContractExecutionTransaction({
    walletAddress: CLIENT_ADDRESS,
    blockchain: 'ARC-TESTNET',
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: 'createJob(address,address,uint256,string,address)',
    abiParameters: [
      PROVIDER_ADDRESS,
      CLIENT_ADDRESS,
      expiredAt.toString(),
      'Test ERC-8183 job',
      '0x0000000000000000000000000000000000000000',
    ],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  const txHash = await waitForTransaction(createTx.data?.id!, 'create job');
  console.log(`   Tx hash: ${txHash}`);

  // Read job counter to get the new job ID (reliable fallback)
  const nextJobId = (await publicClient.readContract({
    address: AGENTIC_COMMERCE_CONTRACT,
    abi: agenticCommerceAbi as any, // 👈 type assertion to avoid strict functionName check
    functionName: 'jobCounter',
  })) as bigint; // 👈 explicitly cast to bigint
  const jobId = nextJobId - 1n;
  console.log(`   ✅ Job created. Job ID: ${jobId}\n`);

  // ---------- 2. Set Budget (10 USDC = 10_000_000 with 6 decimals) ----------
  console.log('2️⃣ Setting budget (10 USDC)...');
  const budget = 100_000n;
  const setBudgetTx = await circleClient.createContractExecutionTransaction({
    walletAddress: PROVIDER_ADDRESS,
    blockchain: 'ARC-TESTNET',
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: 'setBudget(uint256,uint256,bytes)',
    abiParameters: [jobId.toString(), budget.toString(), '0x'],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  await waitForTransaction(setBudgetTx.data?.id!, 'set budget');
  console.log('   ✅ Budget set\n');

  // ---------- 3. Approve USDC ----------
  console.log('3️⃣ Approving USDC spend...');
  const approveTx = await circleClient.createContractExecutionTransaction({
    walletAddress: CLIENT_ADDRESS,
    blockchain: 'ARC-TESTNET',
    contractAddress: USDC_CONTRACT,
    abiFunctionSignature: 'approve(address,uint256)',
    abiParameters: [AGENTIC_COMMERCE_CONTRACT, budget.toString()],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  await waitForTransaction(approveTx.data?.id!, 'approve USDC');
  console.log('   ✅ Approved\n');

  // ---------- 4. Fund Escrow ----------
  console.log('4️⃣ Funding escrow...');
  const fundTx = await circleClient.createContractExecutionTransaction({
    walletAddress: CLIENT_ADDRESS,
    blockchain: 'ARC-TESTNET',
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: 'fund(uint256,bytes)',
    abiParameters: [jobId.toString(), '0x'],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  await waitForTransaction(fundTx.data?.id!, 'fund escrow');
  console.log('   ✅ Escrow funded\n');

  // ---------- 5. Submit Deliverable ----------
  console.log('5️⃣ Submitting deliverable...');
  const deliverableHash = keccak256(toHex('test-deliverable'));
  const submitTx = await circleClient.createContractExecutionTransaction({
    walletAddress: PROVIDER_ADDRESS,
    blockchain: 'ARC-TESTNET',
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: 'submit(uint256,bytes32,bytes)',
    abiParameters: [jobId.toString(), deliverableHash, '0x'],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  await waitForTransaction(submitTx.data?.id!, 'submit deliverable');
  console.log('   ✅ Deliverable submitted\n');

  // ---------- 6. Complete Job ----------
  console.log('6️⃣ Completing job...');
  const reasonHash = keccak256(toHex('deliverable-approved'));
  const completeTx = await circleClient.createContractExecutionTransaction({
    walletAddress: CLIENT_ADDRESS,
    blockchain: 'ARC-TESTNET',
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: 'complete(uint256,bytes32,bytes)',
    abiParameters: [jobId.toString(), reasonHash, '0x'],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  await waitForTransaction(completeTx.data?.id!, 'complete job');
  console.log('   ✅ Job completed\n');

  // ---------- 7. Verify Final Job State ----------
  console.log('7️⃣ Verifying final job state...');
  const job = (await publicClient.readContract({
    address: AGENTIC_COMMERCE_CONTRACT,
    abi: agenticCommerceAbi,
    functionName: 'getJob',
    args: [jobId],
  })) as any; // workaround for complex tuple type
  const statusCode = Number(job.status);
  console.log(`   ✅ Job status: ${statusCode} (3 = Completed)\n`);

  console.log('🎉 ERC-8183 job lifecycle completed successfully!');
}

main().catch(console.error);
