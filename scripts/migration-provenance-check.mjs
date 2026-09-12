// scripts/migration-provenance-check.mjs (invoked by hand, not a suite)
// Non-mutating structural validation: checked-in migration SQL vs schema.prisma.
// Never touches the DB. Run: node scripts/migration-provenance-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'prisma/migrations/20260912000000_swap_backend_stage/migration.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');

let fail = 0;
const check = (name, cond) => {
  console.log(`  ${(cond ? '✅' : '❌')} ${name}`);
  if (!cond) fail++;
};

const convCols = ['venueId', 'deploymentName', 'deploymentRouter', 'feeTier', 'executionIdentity',
  'expectedPayer', 'slippageBps', 'wrapTxHash', 'tokenInSwap', 'tokenOutSwap',
  'amountInSwap', 'quotedOutputSwap', 'minOutputSwap'];
for (const c of convCols) check(`SQL adds payment_conversions.${c}`, sql.includes(`"${c}"`));
check('SQL creates flow_swap_intents table', sql.includes('CREATE TABLE "flow_swap_intents"'));
const flowCols = ['ownerWallet', 'inputSymbol', 'outputSymbol', 'inputAmount', 'inputAmountSwap',
  'tokenInSwap', 'tokenOutSwap', 'quotedOutputSwap', 'minOutputSwap', 'venueId', 'deploymentName',
  'deploymentRouter', 'poolAddress', 'feeTier', 'slippageBps', 'quoteExpiresAt', 'deadline',
  'quoteHash', 'executionIdentity', 'idempotencyKey', 'expectedPayer', 'recipient',
  'wrapTxHash', 'executionTxHash', 'actualInputAmount', 'actualOutputAmount', 'status'];
const flowBlock = schema.slice(schema.indexOf('model FlowSwapIntent'));
for (const c of flowCols) check(`schema FlowSwapIntent has ${c}`, flowBlock.includes(`${c} `));
check('SQL flow executionIdentity unique', sql.includes('flow_swap_intents_executionIdentity_key'));
check('SQL flow executionTxHash unique', sql.includes('flow_swap_intents_executionTxHash_key'));
check('SQL flow wrapTxHash unique', sql.includes('flow_swap_intents_wrapTxHash_key'));
check('SQL conversion executionIdentity unique', sql.includes('payment_conversions_executionIdentity_key'));
check('SQL conversion wrapTxHash unique', sql.includes('payment_conversions_wrapTxHash_key'));
const payLogBlock = schema.slice(schema.indexOf('model PaymentLog'), schema.indexOf('model AgentRegistry'));
check('PaymentLog untouched (no venue/executionIdentity fields)', !/venueId|executionIdentity|deploymentName/.test(payLogBlock));
check('migration dir has migration.sql only (no edits to history)', fs.readdirSync(path.join(root, 'prisma/migrations/20260912000000_swap_backend_stage')).join(',') === 'migration.sql');

console.log(fail === 0 ? 'migration-provenance-check: ALL PASS (structural only — DB provenance NOT proven)' : `migration-provenance-check: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
