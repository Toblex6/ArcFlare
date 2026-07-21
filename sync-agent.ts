// scripts/sync-agent.ts
import { prisma } from '../src/lib/prisma';

async function main() {
  try {
    await prisma.agentRegistry.create({
      data: {
        scaAddress: '0x7cf8ee2ab9c1aeb9cbae26511fb0cbda923ab15e',
        tokenId: '851223',
        name: 'FlareHQ AI Agent',
        status: 'ACTIVE',
        ownerNode: '0x7cf8ee2ab9c1aeb9cbae26511fb0cbda923ab15e',
      },
    });
    console.log('✅ Agent inserted successfully');
  } catch (e: any) {
    if (e.code === 'P2002') {
      console.log('⚠️ Agent already exists in the database.');
    } else {
      console.error('❌ Error:', e.message);
    }
  }
}

main();