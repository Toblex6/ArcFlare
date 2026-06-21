import axios from 'axios';

async function run() {
  console.log('🤖 [Simulated Agent]: Initializing cross-chain transfer payload...');

  // Example real-world parameters from an agent burning USDC on Base Sepolia
  const mockPayload = {
    sourceTxHash: '0x912f22a13e9ccb979b621500f6952b2afd6e75be7eadaed93fc2625fe11c52a2', // A sample structured EVM hash
    sourceRpcUrl: 'https://sepolia.base.org',
  };

  try {
    console.log('🚀 [Simulated Agent]: Shipping cross-chain intent to ArcFlare Gateway...');
    const response = await axios.post('http://localhost:3000/api/settle-cross-chain', mockPayload);

    console.log('\n📥 [Gateway Engine Response]:');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error: any) {
    if (error.response) {
      console.log(`\n📥 [Gateway Engine Returned Status ${error.response.status}]:`);
      console.log(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('❌ Link breakdown:', error.message);
    }
  }
}

run();
