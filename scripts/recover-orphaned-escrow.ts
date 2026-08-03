// scripts/recover-orphaned-escrow.ts
//
// Recovers the escrow that succeeded on-chain (approve + createEscrow both
// confirmed) but never got saved to Postgres, because the create route was
// still writing to the wrong field name (`onchainId` instead of
// `contractEscrowId`) at the time this one ran.
//
// This escrow's 1 USDC is currently locked in the FlareHQEscrow contract
// under the onchainId below — this script just makes it visible/actionable
// in the dashboard again. It does NOT touch the chain, only inserts the
// missing DB row using values already confirmed from the server logs.
//
// Run once with: npx tsx scripts/recover-orphaned-escrow.ts
// (or: npx ts-node scripts/recover-orphaned-escrow.ts)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const reference = 'escrow_msc8mkqk_rzqmdn';

    const existing = await prisma.escrow.findUnique({ where: { reference } });
    if (existing) {
        console.log(`Escrow ${reference} already exists in the DB — nothing to do.`);
        console.log(existing);
        return;
    }

    const recovered = await prisma.escrow.create({
        data: {
            reference,
            contractEscrowId: '0x24a73fd82773513d16dbe11e718b7eb72fe2e8887a9153394c21c6c881bbb237',
            amount: 1,
            currency: 'USDC',
            depositorSCA: '0xc78c25768bba02a79767cc8506aa52999e4c5786',
            beneficiarySCA: '0x46dfEDe57338ceaD8c83C569fD37CE3A25746b35',
            contractAddress: process.env.ARCFLARE_ESCROW_CONTRACT_ADDRESS || '0xEb810aeD24D2314dB7471E44bf6DE89f017631E0',
            status: 'ACTIVE',
            condition: null, // original condition text wasn't captured in the logs — set manually if you remember it
            deadline: new Date('2026-08-03T20:13:19.868Z'),
            txHash: '0xf3195f297afd3171f8ae8781b8737c66e1ced5d1e67f3dd57bbfc6d1e328fbca',
            depositorConfirmed: false,
            beneficiaryConfirmed: false,
        },
    });

    console.log('✅ Recovered orphaned escrow:');
    console.log(recovered);
}

main()
    .catch((e) => {
        console.error('❌ Recovery failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());