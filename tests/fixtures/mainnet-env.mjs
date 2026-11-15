// Deterministic throwaway fixtures only; no funded wallets or live RPC calls.
import { Wallet } from 'ethers';

const key = '0x' + '11'.repeat(32);
const address = new Wallet(key).address;
export const MAINNET_ENV = {
  NODE_ENV: 'production', ARC_NETWORK: 'mainnet', NEXT_PUBLIC_ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042', ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC',
  ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.example',
  ARC_MAINNET_EXPLORER_URL: 'https://explorer.arc.example',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway.circle.example',
  // Core topology remains required; optional CCTP_MAINNET_* bridge vars absent.
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris.circle.example/v2',
  ARC_MAINNET_CCTP_DOMAIN: '26', ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x' + '1'.repeat(40),
  ARC_MAINNET_USDC_ADDRESS: '0x' + '2'.repeat(40), ARC_MAINNET_EURC_ADDRESS: '0x' + '3'.repeat(40),
  SELLER_ADDRESS: address, SELLER_PRIVATE_KEY: key, BUYER_ADDRESS: address, BUYER_PRIVATE_KEY: key,
  EOA_PRIVATE_KEY: key, RELAYER_PRIVATE_KEY: key, ARC_ADMIN_PRIVATE_KEY: key, ESCROW_ADMIN_PRIVATE_KEY: key,
  X402_WALLET_ENCRYPTION_KEY: 'test-only-encryption-secret-0123456789abcdef',
  CONSUMER_JWT_SECRET: 'test-only-consumer-secret-0123456789abcdef',
  MERCHANT_JWT_SECRET: 'test-only-merchant-secret-0123456789abcdef',
  INTERNAL_SETTLEMENT_API_KEY: 'test-only-internal-key-0123456789abcdef',
  TELEGRAM_BOT_TOKEN: 'test-only-telegram-token-0123456789abcdef',
  TELEGRAM_WEBHOOK_SECRET: 'test-only-telegram-webhook-0123456789abcdef',
  PAYROLL_CONTRACT_ADDRESS: '0x' + '4'.repeat(40), SPEND_LIMIT_CONTRACT_ADDRESS: '0x' + '5'.repeat(40),
  SWAP_POOL_CONTRACT_ADDRESS: '0x' + '6'.repeat(40), JOB_ESCROW_CONTRACT_ADDRESS: '0x' + '7'.repeat(40),
  CIRCLE_API_KEY: 'test-only-circle-api-key', CIRCLE_WALLET_SET_ID: 'test-only-circle-wallet-set',
  CIRCLE_ENTITY_SECRET: 'test-only-circle-entity-secret', NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: 'test-only-project-id',
};

export async function withEnv(env, fn) {
  const net = await import('../../src/lib/config/network.ts');
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(ARC_|NEXT_PUBLIC_ARC_|CCTP_MAINNET_|ARCFLARE_STREAM_|ARC_FLARE_STREAM_)/.test(key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    net.__resetNetworkConfigCacheForTests();
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    net.__resetNetworkConfigCacheForTests();
  }
}
