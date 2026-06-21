import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

// Adding your specific Request and Response IDs
const txIdsToMonitor = [
  'a71e7da9-8af4-59fd-bc84-f99c6bbebaf7', // Request ID
  '70939c7f-c5ae-593a-8391-6c5be28580b2', // Response ID
];

async function monitorTransactions() {
  console.log('🔍 Checking Lifecycle Status...');

  for (const txId of txIdsToMonitor) {
    try {
      console.log(`\nChecking ID: ${txId}`);

      const response = await circleClient.getTransaction({ id: txId });
      const tx = response.data?.transaction as any;

      if (!tx) {
        console.log(`  ⚠️ Transaction not found.`);
        continue;
      }

      console.log(`  State: ${tx.state}`);

      if (tx.state === 'COMPLETE') {
        console.log(`  ✅ Confirmed: ${tx.txHash}`);
      } else if (tx.state === 'FAILED' || tx.state === 'DENIED') {
        console.log(`  ❌ Failed.`);
        console.log(`     Error: ${tx.errorCode || 'Unknown'}`);
        console.log(`     Details: ${tx.errorDetails || 'No details'}`);
      } else {
        console.log(`  ⏳ Pending (Status: ${tx.state})`);
      }
    } catch (error) {
      console.error(`  ❗ Error fetching ${txId}:`, error);
    }
  }
}

monitorTransactions().catch(console.error);
