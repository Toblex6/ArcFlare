import { getCircleClient, waitForTransaction } from '../src/lib/circle/client';
import { AGENTIC_COMMERCE_CONTRACT } from '../src/lib/contracts/erc8183';
import { createPublicClient, http } from 'viem';
import { arcTestnet } from 'viem/chains';

// Use the wallet addresses from your successful wallet creation step
const CLIENT_ADDRESS = '0xcdd42d073766327fbd03f7f7410a5cb8b58355c4';
const PROVIDER_ADDRESS = '0x6e2379e03671f4e704a66fde64e94e70f4bfae03';

const circleClient = getCircleClient();
const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

async function main() {
  console.log('🚀 Running ERC-8183 Debug Script...');

  const expiredAt = Math.floor(Date.now() / 1000) + 3600;
  console.log('1️⃣ Creating a new test job...');

  const createTx = await circleClient.createContractExecutionTransaction({
    walletAddress: CLIENT_ADDRESS,
    blockchain: 'ARC-TESTNET',
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: 'createJob(address,address,uint256,string,address)',
    abiParameters: [
      PROVIDER_ADDRESS,
      CLIENT_ADDRESS,
      expiredAt.toString(),
      'Debug test job',
      '0x0000000000000000000000000000000000000000',
    ],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  const txHash = await waitForTransaction(createTx.data?.id!, 'create job');
  console.log(`\n✅ Transaction successful! Hash: ${txHash}`);

  console.log('\n2️⃣ Fetching transaction receipt...');
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });

  console.log(`\n   Receipt Status: ${receipt.status}`); // This MUST be 'success'
  console.log(`   Block Number: ${receipt.blockNumber}`);
  console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);

  console.log('\n3️⃣ Inspecting raw transaction logs:');
  if (receipt.logs.length === 0) {
    console.log(
      "   ❌ No logs found in the receipt. The transaction may have succeeded but the contract didn't emit the event."
    );
  } else {
    for (const [index, log] of receipt.logs.entries()) {
      console.log(`\n   Log ${index + 1}:`);
      console.log(`     Address: ${log.address}`);
      console.log(`     Topics: ${log.topics.map((t) => t.slice(0, 30)).join(', ')}...`);
      console.log(`     Data: ${log.data.slice(0, 66)}...`);
      if (log.address.toLowerCase() === AGENTIC_COMMERCE_CONTRACT.toLowerCase()) {
        console.log(`     ✅ This log is from the ERC-8183 contract.`);
        // Check if the first topic matches the keccak256 hash of the JobCreated event signature
        const jobCreatedEventSignature =
          '0x957e1da045e5f970beaca1ebf7de3f62f6ec093512dac48ffb2e94e8bb4aa5c7';
        if (log.topics[0] === jobCreatedEventSignature) {
          console.log(`     🎉 Found the JobCreated event!`);
          console.log(`       Job ID (from topics[1]): ${log.topics[1]}`);
        }
      }
    }
  }
}

main().catch(console.error);
