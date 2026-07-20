// src/lib/wallet/erc20.ts
// Minimal ERC20 pieces needed for a customer's wallet to pay a merchant
// directly on-chain, and for the server to verify that payment afterward.
import { USDC_CONTRACT } from '@/src/lib/contracts/erc8183';

export { USDC_CONTRACT };
export const USDC_DECIMALS = 6;

export const erc20TransferAbi = [
    {
        name: 'transfer',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        name: 'Transfer',
        type: 'event',
        inputs: [
            { indexed: true, name: 'from', type: 'address' },
            { indexed: true, name: 'to', type: 'address' },
            { indexed: false, name: 'value', type: 'uint256' },
        ],
    },
] as const;