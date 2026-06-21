import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

// Update these to match the addresses generated in your last run
const OWNER_WALLET_ID = '94bd9b65-cc31-5789-8268-6cc30847c356'; // Get this from your terminal
const VALIDATOR_ADDRESS = '0x6aec38efb08501972d40e43c362f4f7eca105598'; // Your Validator address
const VALIDATION_REGISTRY = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';

async function authorize() {
  console.log('🔓 Authorizing Validator...');

  const tx = await client.createContractExecutionTransaction({
    walletId: OWNER_WALLET_ID,
    contractAddress: VALIDATION_REGISTRY,
    // Trying the most common function name for this pattern:
    abiFunctionSignature: 'addValidator(address)',
    abiParameters: [VALIDATOR_ADDRESS],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  console.log(`Transaction Sent: ${tx.data?.id}`);
}

authorize();
