// src/lib/wallet/erc20.ts
// Minimal ERC20 pieces needed for a customer's wallet to pay a merchant
// directly on-chain, and for the server to verify that payment afterward.
import { getNetworkConfig } from "@/lib/config/network";

// USDC address flows from the authoritative network config (testnet: pinned
// testnet value unchanged; mainnet: required ARC_MAINNET_USDC_ADDRESS). This
// is the single legacy-compat alias used by merchant-withdraw / escrow-pay;
// it is NOT a second source of truth.
export const USDC_CONTRACT: string = getNetworkConfig().usdcAddress;
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