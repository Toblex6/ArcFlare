import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './fixtures/load-typescript.mjs';

function prismaFixture(name, existing) {
  let clients = 0; let extension; const shared = {};
  if (existing) shared.prisma = existing;
  class OfflinePrisma {
    constructor() { clients++; }
    $extends(input) { extension = input; return { offline: true }; }
  }
  const dependencies = { '@prisma/client': { PrismaClient: OfflinePrisma }, '@/lib/config/network': { getArcChain: () => ({ name }) } };
  const load = () => loadTypescript('src/lib/prisma.ts', dependencies, { global: shared });
  const module = load(); return { module, load, clients: () => clients, extension, shared };
}

for (const network of ['Arc Mainnet', 'Arc Testnet']) test(`legacy x402 persistence uses ${network} without changing gateway/payment fields`, async () => {
  const f = prismaFixture(network); const data = { chain: 'Arc Testnet x402', amount: '0.2', merchantSCA: 'frozen-recipient', status: 'SUCCESS', reference: 'ref' };
  const args = { data, select: { reference: true } }; let saved;
  const result = await f.extension.query.paymentLog.create({ args, query: async (input) => { saved = input; return 'record'; } });
  assert.equal(result, 'record'); assert.deepEqual(saved, { ...args, data: { ...data, chain: `${network} x402` } });
  assert.equal(args.data.chain, 'Arc Testnet x402', 'caller input is not mutated');
  assert.deepEqual(Object.keys(f.extension.query), ['paymentLog']); assert.deepEqual(Object.keys(f.extension.query.paymentLog), ['create']);
});
for (const chain of ['Base', 'Arc Mainnet', 'Arc Testnet', 'Arc Mainnet x402', undefined]) test(`non-legacy label ${String(chain)} is untouched`, async () => {
  const f = prismaFixture('Arc Mainnet'); const args = { data: { chain } }; let saved;
  await f.extension.query.paymentLog.create({ args, query: async (input) => { saved = input; } }); assert.equal(saved, args);
});
test('extended Prisma client stays globally shared; reload does not create a second pool', () => {
  const f = prismaFixture('Arc Mainnet'); assert.equal(f.load().prisma, f.module.prisma); assert.equal(f.clients(), 1);
  const existing = { userClient: true }; const reused = prismaFixture('Arc Mainnet', existing);
  assert.equal(reused.module.prisma, existing); assert.equal(reused.clients(), 0);
});
