import { NextResponse } from 'next/server';
import { createPublicClient, http, getContract } from 'viem';

// Configured for Arc Testnet RPC
const arcTestnet = {
  id: 420, 
  name: 'Arc Testnet',
  network: 'arc-testnet',
  nativeCurrency: { name: 'Arc', symbol: 'ARC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arcscan.app'] },
    public: { http: ['https://rpc.testnet.arcscan.app'] },
  },
};

const publicClient = createPublicClient({ 
  chain: arcTestnet, 
  transport: http() 
});

const contractAbi = [
  {
    "inputs": [{ "internalType": "bytes32", "name": "requestHash", "type": "bytes32" }],
    "name": "getValidationStatus",
    "outputs": [
      { "internalType": "address", "name": "validator", "type": "address" },
      { "internalType": "uint256", "name": "agentId", "type": "uint256" },
      { "internalType": "uint8", "name": "responseStatus", "type": "uint8" },
      { "internalType": "bytes32", "name": "responseHash", "type": "bytes32" },
      { "internalType": "string", "name": "tag", "type": "string" },
      { "internalType": "uint256", "name": "lastUpdate", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const hash = searchParams.get('requestHash');

    if (!hash || !hash.startsWith('0x')) {
      return NextResponse.json({ success: false, error: "Invalid or missing 0x requestHash" }, { status: 400 });
    }
    
    const registryContract = getContract({
      address: "0x24DAB3fB3Fe6A17c2e9c57F3c1D5d15CBcF5800F",
      abi: contractAbi,
      client: publicClient
    });

    // Query contract state directly from Arc Testnet
    const status = await registryContract.read.getValidationStatus([hash as `0x${string}`]);
    
    return NextResponse.json({ 
      success: true,
      responseStatus: Number(status[2]), // 100 = verified passed status
      tag: status[4]                  // e.g. "kyc_verified"
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}