import { getCircleClient, createWallets } from '../lib/circle/client';

async function test() {
  try {
    console.log('Testing Circle client...');

    // Test wallet creation
    const { walletSetId, wallets } = await createWallets('Test Wallet Set', 2);

    console.log('✅ Success!');
    console.log(`Wallet Set ID: ${walletSetId}`);
    console.log(`Wallets: ${JSON.stringify(wallets, null, 2)}`);
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

test();
