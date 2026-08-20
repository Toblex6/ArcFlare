// scripts/top-up-relayer.ts
//
// Testnet funding op: native value-send of USDC (18-dec view) from an
// x402 pool wallet to the relayer EOA (fee-free by construction).
// Usage: npx tsx scripts/top-up-relayer.ts [amount] [recipient]
// Defaults: amount 1.0 USDC, recipient = RELAYER_PRIVATE_KEY's address.

import 'dotenv/config';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { prisma } from '@/lib/prisma';

async function main() {
  const amount = process.argv[2] ?? '1.0';
  const keyB64 = process.env.X402_WALLET_ENCRYPTION_KEY;
  if (!keyB64) throw new Error('X402_WALLET_ENCRYPTION_KEY not set');
  const key = Buffer.from(keyB64, 'base64');

  const poolRows = await prisma.x402EoaWallet.findMany({ orderBy: { id: 'asc' } });
  const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC);
  const wallets = await Promise.all(poolRows.map(async (r) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.keyIv, 'base64'));
    decipher.setAuthTag(Buffer.from(r.keyAuthTag, 'base64'));
    const pk = Buffer.concat([decipher.update(Buffer.from(r.encryptedKey, 'base64')), decipher.final()]).toString('utf8');
    const w = new ethers.Wallet(pk, provider);
    return { address: w.address, w, balance: await provider.getBalance(w.address) };
  }));
  const funded = wallets.filter((x) => x.balance >= ethers.parseEther(amount));
  if (funded.length === 0) throw new Error(`no pool wallet holds >= ${amount} USDC`);
  const pool = funded.sort((a, b) => (b.balance < a.balance ? -1 : 1))[0].w;

  const recipient = process.argv[3] ?? new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY!).address;
  const value = ethers.parseEther(amount);

  const tx = await pool.sendTransaction({ to: recipient, value });
  const receipt = await tx.wait();
  const poolBal = await provider.getBalance(pool.address);
  console.log(`sent ${amount} USDC (native) from pool ${pool.address} → ${recipient}`);
  console.log(`tx ${receipt?.hash}`);
  console.log(`pool balance now: ${ethers.formatEther(poolBal)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });