// src/lib/wallet/flarehqContracts.ts
//
// Single source of truth for the DEPLOYED Arc-flare contracts that external
// wallets interact with, verified live against the running testnet
// (2026-08-31) rather than assumed from any source file:
//
//   Escrow contract (FlareHQEscrow) 0xEb810aeD24D2314dB7471E44bf6DE89f017631E0
//     - confirmed selectors in deployed bytecode:
//         createEscrow(bytes32,address,uint256,uint256,string)
//         confirmDelivery(bytes32)
//         dispute(bytes32,string)
//         refundExpired(bytes32)
//         resolveDispute(bytes32,bool)
//         getEscrow(bytes32) view returns (address,address,uint256,uint256,string,bool,bool)
//         escrows(bytes32), admin()
//     - confirmed events (topic hashes extracted from deployed bytecode):
//         EscrowCreated(bytes32,address,address,uint256,uint256,string)
//         EscrowDisputed(bytes32,address,string)
//         EscrowReleased(bytes32,address,uint256)
//         EscrowRefunded(bytes32,address,uint256)
//     - NOTE: this is NOT the stale src/app/api/contracts/ArcFlareEscrow.sol
//       (that file describes an older 4-arg createEscrow / dispute(bytes32)
//       build). The deployed contract takes an EXPLICIT bytes32 escrowId that
//       the backend derives as keccak256(reference), and dispute takes a
//       reason string. The stale file is kept only for reference.
//
//   Stream contract (ArcFlareStream nanopayments) 0xd8ca3Bbc...A52B
//     - criterion-based tranche model (openStream/releaseTranche/closeStream,
//       uint256 streamId). It does NOT implement stopStream(bytes32) /
//       withdraw(bytes32) / createStream(...) — the per-second streaming
//       model the payments/stream/* routes referenced was replaced by this
//       contract on 2026-08-21. External-wallet stop/withdraw therefore
//       cannot execute against the configured address (see stream stop/withdraw
//       routes, which now fail closed instead of fabricating).
//
//   USDC (Arc testnet) 0x3600000000000000000000000000000000000000 — 6 decimals.
//
// This module is read-only state + ABI definitions; it never broadcasts.

import { parseAbi } from "viem";

export const ARCFLARE_ESCROW_CONTRACT_ADDRESS =
  process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || "";
export const ARCFLARE_STREAM_CONTRACT_ADDRESS =
  process.env.ARCFLARE_STREAM_CONTRACT_ADDRESS || "";

export const ARCFLARE_USDC_CONTRACT = "0x3600000000000000000000000000000000000000";
export const ARCFLARE_USDC_DECIMALS = 6;

export const ARC_TESTNET_CHAIN_ID = 5042002;

// ── FlareHQEscrow — deployed interface ────────────────────────────────────────
// NOTE: ABI items are plain object literals, NOT parseAbiItem()-parsed — the
// abitype parser rejects protected keywords (e.g. `reference`, `from`, `to`)
// that are perfectly valid ABI param names in practice. Object literals still
// encode/decode correctly with viem's decodeEventLog / readContract.
export const escrowAbi = [
  {
    name: 'createEscrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'beneficiary', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'condition', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'confirmDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'dispute',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'reason', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'refundExpired',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'resolveDispute',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'bytes32' },
      { name: 'releaseToBeneficiary', type: 'bool' },
    ],
    outputs: [],
  },
  {
    name: 'getEscrow',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'depositor', type: 'address' },
          { name: 'beneficiary', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'ref', type: 'string' },
          { name: 'depositorConfirmed', type: 'bool' },
          { name: 'beneficiaryConfirmed', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'escrows',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'depositor', type: 'address' },
          { name: 'beneficiary', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'ref', type: 'string' },
          { name: 'depositorConfirmed', type: 'bool' },
          { name: 'beneficiaryConfirmed', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'admin',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const escrowEvents = {
  EscrowCreated: {
    name: 'EscrowCreated',
    type: 'event',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'escrowId', type: 'bytes32' },
      { indexed: true, name: 'depositor', type: 'address' },
      { indexed: true, name: 'beneficiary', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
      { indexed: false, name: 'deadline', type: 'uint256' },
      { indexed: false, name: 'reference', type: 'string' },
    ],
  },
  EscrowDisputed: {
    name: 'EscrowDisputed',
    type: 'event',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'escrowId', type: 'bytes32' },
      { indexed: true, name: 'raisedBy', type: 'address' },
      { indexed: false, name: 'reason', type: 'string' },
    ],
  },
  EscrowReleased: {
    name: 'EscrowReleased',
    type: 'event',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'escrowId', type: 'bytes32' },
      { indexed: false, name: 'beneficiary', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
  EscrowRefunded: {
    name: 'EscrowRefunded',
    type: 'event',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'escrowId', type: 'bytes32' },
      { indexed: false, name: 'depositor', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
  },
} as const;

export const escrowSelectors = {
  createEscrow: "0xa6470e45",
  confirmDelivery: "0x74950ffd",
  dispute: "0x84146b9d",
  refundExpired: "0xcc3e049b",
  resolveDispute: "0x43a0e3e6",
} as const;

export const escrowEventTopics = {
  EscrowCreated: "0x59e789c417a6e94fd0efc65f1895ad3410f111164f22cf4b1a75dae69dcb1aec",
  EscrowDisputed: "0x85df63e82b1c4b692591e851fd05ac7c87d4dd28557d780c47c462a11f64e0c8",
  EscrowReleased: "0x3a9c1cd29cd3be251a72ce3c367c27dc1cb697ac4589965b76a83f9a25ca0710",
  EscrowRefunded: "0xfc31a7ddbe933aa6e67f3c98c183fbc87addd2b602fcfb10238d2f85cf026617",
} as const;

export interface EscrowOnChain {
  depositor: string;
  beneficiary: string;
  amount: bigint;
  deadline: bigint;
  reference: string;
  depositorConfirmed: boolean;
  beneficiaryConfirmed: boolean;
}

// ── USDC ERC-20 transfer surface (external-wallet payroll) ───────────────────
export const usdcTransferAbi = [
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
    anonymous: false,
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
  },
] as const;

export const erc20TransferSelector = "0xa9059cbb";

// ── ArcFlareStream (nanopayments) — deployed interface (read surface only) ───
export const streamAbi = parseAbi([
  "function openStream(address,address,uint256,uint256) returns (uint256)",
  "function releaseTranche(uint256,uint256)",
  "function closeStream(uint256)",
  "function getStream(uint256) view returns (address,address,address,uint256,uint256,uint256,uint256,bool,uint64)",
  "function releasedTranches(uint256,uint256) view returns (bool)",
  "function trancheAmounts(uint256,uint256) view returns (uint256)",
  "function nextStreamId() view returns (uint256)",
]);
