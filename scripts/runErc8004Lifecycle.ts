import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { keccak256, stringToBytes } from 'viem';
import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

// Registry Addresses — TESTNET pins (docs.arc.io/arc/references/contract-addresses).
// TESTNET-ONLY script: refuses mainnet execution (see guard below). A mainnet
// ERC-8004 lifecycle run would submit real-money transactions and must never be
// triggered by this helper.
const ARC_NETWORK_SELECTED = (
  process.env.ARC_NETWORK ??
  process.env.NEXT_PUBLIC_ARC_NETWORK ??
  "testnet"
).toLowerCase();
if (ARC_NETWORK_SELECTED === "mainnet") {
  console.error(
    "Refusing to run scripts/runErc8004Lifecycle.ts with ARC_NETWORK=mainnet: this is a TESTNET-ONLY operator script. Mainnet lifecycle actions are separate, deliberate operations."
  );
  process.exit(1);
}
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const VALIDATION_REGISTRY = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';

async function runErc8004Lifecycle() {
  console.log('🚀 [FlareHQ Core] Booting Machine Identity Lifecycle Engine...');

  const circleClient = initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });

  // Provisioning
  const walletSet = await circleClient.createWalletSet({ name: 'FlareHQ ERC8004 Agent Suite' });
  const walletsResponse = await circleClient.createWallets({
    blockchains: ['ARC-TESTNET'],
    count: 2,
    walletSetId: walletSet.data?.walletSet?.id ?? '',
    accountType: 'SCA',
  });

  const ownerWallet = walletsResponse.data?.wallets?.[0]!;
  const validatorWallet = walletsResponse.data?.wallets?.[1]!;

  console.log(`   Owner Agent Wallet:     ${ownerWallet.address}`);
  console.log(`   Validator Node Wallet:  ${validatorWallet.address}`);

  const simulatedAgentId = BigInt(1);
  const valHash = keccak256(stringToBytes('kyc_verification_request_agent_1'));

  // Phase 1: Identity
  console.log('\n--- [Phase 1: Registering Agent] ---');
  const regTx = await circleClient.createContractExecutionTransaction({
    walletId: ownerWallet.id,
    contractAddress: IDENTITY_REGISTRY,
    abiFunctionSignature: 'register(string)',
    abiParameters: ['ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei'],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  // Phase 2: Reputation
  console.log('--- [Phase 2: Recording Metrics] ---');
  const feedbackTx = await circleClient.createContractExecutionTransaction({
    walletId: validatorWallet.id,
    contractAddress: REPUTATION_REGISTRY,
    abiFunctionSignature: 'giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)',
    abiParameters: [
      simulatedAgentId.toString(),
      '95',
      '0',
      'successful_trade',
      '',
      '',
      '',
      keccak256(stringToBytes('successful_trade')),
    ],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  // Phase 3: Validation Request
  console.log('--- [Phase 3: Validation Request] ---');
  const reqTx = await circleClient.createContractExecutionTransaction({
    walletId: ownerWallet.id,
    contractAddress: VALIDATION_REGISTRY,
    abiFunctionSignature: 'requestValidation(uint256,bytes32,string,address)',
    abiParameters: ['1', valHash, 'ipfs://bafkreiexample', String(validatorWallet.address)],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  // Phase 4: Validation Response
  console.log('--- [Phase 4: Validation Response] ---');
  const resTx = await circleClient.createContractExecutionTransaction({
    walletId: validatorWallet.id,
    contractAddress: VALIDATION_REGISTRY,
    abiFunctionSignature: 'submitValidationResult(bytes32,uint8,string)',
    abiParameters: [valHash, '1', 'kyc_verified'],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });

  console.log(`\n🎉 Pipeline Synced!`);
  console.log(`   Request ID:  ${reqTx.data?.id}`);
  console.log(`   Response ID: ${resTx.data?.id}`);
  console.log(`   >> AUTHORIZE THIS VALIDATOR IN REMIX: ${validatorWallet.address}`);
}

runErc8004Lifecycle().catch(console.error);
