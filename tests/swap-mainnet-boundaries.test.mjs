// Actual quote/builder/executor with mocked JSON-RPC and an in-memory intent.
// UI checks evaluate the component's own expressions and render its own JSX,
// not a copied threshold formula. No external network, signing, DB, or funds.
// Run: npx tsx --test tests/swap-mainnet-boundaries.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { prisma } from '../src/lib/prisma.ts';
import { __resetNetworkConfigCacheForTests, getNetworkConfig } from '../src/lib/config/network.ts';
import { getUnitFlowV3Deployment } from '../src/lib/config/unitflow.ts';
import { getTokenBySymbol } from '../src/lib/tokens/supportedTokens.ts';
import { buildUnitFlowV3Execution, toSwapUnits } from '../src/lib/routing/providers/unitflowV3.ts';
import { getTowerCandidate, requestFlowSwapQuote } from '../src/lib/swap/service.ts';
import { executeFlowSwapAsServer } from '../src/lib/swap/serverExecute.ts';
import { shouldShowTowerAttribution } from '../src/components/swap/swapCopy.ts';

const OWNER = '0x' + 'a'.repeat(40);
const USDC = '0x' + '2'.repeat(40), EURC = '0x' + '3'.repeat(40);
const POOL = '0x' + '7'.repeat(40), ZERO = '0x' + '0'.repeat(40);
const INPUT = 1_000_000n;
const MAINNET = {
  ARC_NETWORK: 'mainnet', NEXT_PUBLIC_ARC_NETWORK: 'mainnet',
  ARC_MAINNET_CHAIN_ID: '5042', ARC_MAINNET_CIRCLE_BLOCKCHAIN: 'ARC',
  ARC_MAINNET_RPC_URL: 'https://rpc.swap-fixture.example',
  ARC_MAINNET_EXPLORER_URL: 'https://explorer.swap-fixture.example',
  ARC_MAINNET_GATEWAY_URL: 'https://gateway.swap-fixture.example',
  ARC_MAINNET_CCTP_IRIS_URL: 'https://iris.swap-fixture.example/v2',
  ARC_MAINNET_CCTP_DOMAIN: '26', ARC_MAINNET_CCTP_MESSAGE_TRANSMITTER: '0x' + '1'.repeat(40),
  ARC_MAINNET_USDC_ADDRESS: USDC, ARC_MAINNET_EURC_ADDRESS: EURC,
  ROUTING_PROVIDER_UNITFLOW_V3_ENABLED: '1', ROUTING_PROVIDER_TOWER_ENABLED: '',
  // A guard regression must not initialize a real Circle client.
  CIRCLE_API_KEY: '', CIRCLE_ENTITY_SECRET: '',
};

async function withNetwork(env, fn) {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  __resetNetworkConfigCacheForTests();
  try { return await fn(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    __resetNetworkConfigCacheForTests();
  }
}

const FACTORY = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const POOL_ABI = parseAbi([
  'function liquidity() view returns (uint128)', 'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
]);
const QUOTER = parseAbi(['function quoteExactInputSingle(address,address,uint24,uint256,uint160) view returns (uint256)']);

function fixture(t, env, loss, direction = 'USDC->EURC') {
  const deployment = getUnitFlowV3Deployment(env);
  const [inputSymbol, outputSymbol] = direction.split('->');
  const eurc = getTokenBySymbol('EURC').address;
  const inToken = inputSymbol === 'USDC' ? deployment.wusdc : eurc;
  const outToken = outputSymbol === 'USDC' ? deployment.wusdc : eurc;
  const rpcCalls = [], effects = [], rows = new Map();
  const quoted = toSwapUnits(outputSymbol, INPUT, deployment) * BigInt(10_000 - loss) / 10_000n;
  const isTestnet = env.ARC_NETWORK === 'testnet';
  const rpcUrl = new URL(getNetworkConfig(env).primaryRpc).href;
  const rpcResponse = (request) => {
    assert.equal(request.method, 'eth_call', 'no RPC submission is allowed');
    const call = request.params[0];
    const target = String(call.to).toLowerCase();
    let abi, result, decoded;
    if (target === deployment.factory.toLowerCase()) {
      abi = FACTORY; decoded = decodeFunctionData({ abi, data: call.data });
      assert.equal(decoded.args[0].toLowerCase(), inToken.toLowerCase());
      assert.equal(decoded.args[1].toLowerCase(), outToken.toLowerCase());
      result = Number(decoded.args[2]) === 100 ? POOL : ZERO;
    } else if (target === deployment.quoter.toLowerCase()) {
      abi = QUOTER; decoded = decodeFunctionData({ abi, data: call.data });
      assert.equal(decoded.args[0].toLowerCase(), inToken.toLowerCase());
      assert.equal(decoded.args[1].toLowerCase(), outToken.toLowerCase());
      assert.equal(decoded.args[3], toSwapUnits(inputSymbol, INPUT, deployment));
      result = quoted;
    } else if (target === POOL.toLowerCase()) {
      abi = POOL_ABI; decoded = decodeFunctionData({ abi, data: call.data });
      const token0 = deployment.wusdc;
      if (decoded.functionName === 'token0') result = token0;
      else if (decoded.functionName === 'token1') result = eurc;
      else if (decoded.functionName === 'liquidity') result = 1_000_000n;
      else if (decoded.functionName === 'slot0') {
        // Testnet's 18-dec USDC leg uses a 1e-12 raw mid against 6-dec EURC.
        result = [isTestnet ? (2n ** 96n) / 1_000_000n : 2n ** 96n, 0, 0, 0, 0, 0, true];
      } else throw new Error(`Unexpected pool read ${decoded.functionName}`);
    } else throw new Error(`Unexpected RPC destination ${target}`);
    rpcCalls.push(decoded.functionName);
    return { jsonrpc: '2.0', id: request.id,
      result: encodeFunctionResult({ abi, functionName: decoded.functionName, result }) };
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(String(url)).href, rpcUrl, 'only fixture RPC allowed');
    const payload = JSON.parse(init.body);
    return new Response(JSON.stringify(Array.isArray(payload) ? payload.map(rpcResponse) : rpcResponse(payload)),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const replaced = [];
  const replace = (target, method, implementation) => {
    replaced.push([target, method, target[method]]);
    target[method] = implementation;
  };
  t.after(() => {
    for (const [target, method, previous] of replaced.reverse()) target[method] = previous;
  });
  const forbidden = () => { throw new Error('Live database access forbidden'); };
  replace(prisma, '$transaction', forbidden);
  for (const method of ['findMany', 'findUnique', 'create', 'update', 'updateMany']) {
    replace(prisma.flowSwapIntent, method, forbidden);
  }
  replace(prisma.flowSwapIntent, 'findMany', async () => { effects.push('findMany'); return []; });
  replace(prisma.flowSwapIntent, 'create', async ({ data }) => {
    effects.push('create'); const row = { id: 'offline-intent', ...data };
    rows.set(row.id, row); return row;
  });
  replace(prisma.flowSwapIntent, 'findUnique', async ({ where }) => {
    effects.push('findUnique'); return rows.get(where.id) ?? null;
  });
  const args = { ownerWallet: OWNER, inputSymbol, outputSymbol, inputAmount: INPUT, env };
  return { args, rows, effects, rpcCalls, quoted };
}

// Extract only the actual component's price guard declarations + JSX.
const componentSource = readFileSync(new URL('../src/components/swap/FlowSwapView.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('FlowSwapView.tsx', componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map(), markup = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['isMainnet', 'priceLossBps', 'priceWarn', 'priceBlocked', 'priceLossPct'].includes(node.name.getText(ast))) {
    declarations.set(node.name.getText(ast), node.getText(ast));
  }
  if (ts.isJsxExpression(node) && node.expression) {
    const text = node.expression.getText(ast);
    if (text.startsWith('priceWarn && !priceBlocked && (') || text.startsWith('priceBlocked && (')) markup.push(text);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.size, 5); assert.equal(markup.length, 2);
const jsx = `${[...declarations.values()].map((s) => `const ${s};`).join('\n')}
return { priceWarn, priceBlocked, content: <>${markup.map((s) => `{${s}}`).join('')}</> };`;
const compiled = ts.transpileModule(jsx, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const actualUiGuard = new Function('React', 'quote', 'networkName', 'styles', compiled);

for (const loss of [0, 100, 101, 500, 501, 9000]) {
  test(`mainnet UI actual guard and warning markup at ${loss}bps`, () => {
    const result = actualUiGuard(React, { status: 'quoted', quote: { priceLossBps: loss } }, 'mainnet', {});
    const html = renderToStaticMarkup(result.content);
    assert.equal(result.priceWarn, loss > 100); assert.equal(result.priceBlocked, loss > 500);
    if (loss > 500) { assert.match(html, /Blocked:.*more than 5%/); assert.doesNotMatch(html, /more than 1%/); }
    else if (loss > 100) assert.match(html, /more than 1%/);
    else assert.equal(html, '');
  });
}

test('testnet UI never warns or blocks; unquoted mainnet UI does not warn', () => {
  const testnet = actualUiGuard(React, { status: 'quoted', quote: { priceLossBps: 9000 } }, 'testnet', {});
  assert.equal(testnet.priceWarn, false); assert.equal(testnet.priceBlocked, false);
  assert.equal(renderToStaticMarkup(testnet.content), '');
  const idle = actualUiGuard(React, { status: 'loading', quote: { priceLossBps: 200 } }, 'mainnet', {});
  assert.equal(idle.priceWarn, false);
});

test('both confirmation handlers check block before requesting wallet execution', () => {
  for (const [start, end, execution] of [
    ['const handleConfirm =', 'const registerAndVerify =', 'await sendAndMine('],
    ['const handleCircleConfirm =', 'const circleConfirmDisabled', 'await post('],
  ]) {
    const begin = componentSource.indexOf(start);
    assert.ok(begin >= 0, `handler locator ${start}`);
    const finish = componentSource.indexOf(end, begin);
    assert.ok(finish > begin, `handler end locator ${end}`);
    const body = componentSource.slice(begin, finish);
    assert.match(body, /if \(priceBlocked\)\s*\{[\s\S]*?return;/);
    // Narrow call locator can be checked independently from copy changes.
    const call = body.indexOf(execution);
    assert.ok(call >= 0, `execution locator ${execution}`);
    assert.ok(body.indexOf('if (priceBlocked)') < call);
  }
});

for (const direction of ['USDC->EURC', 'EURC->USDC']) {
  for (const loss of [100, 101, 500, 501]) {
    test(`${direction}: actual mainnet quote boundary at ${loss}bps`, async (t) => {
      await withNetwork(MAINNET, async () => {
        const h = fixture(t, MAINNET, loss, direction);
        if (loss > 500) {
          await assert.rejects(requestFlowSwapQuote(h.args), (e) => e.status === 400 && /more than 5%/.test(e.message));
          assert.deepEqual(h.effects, [], 'reject before any intent access/write');
        } else {
          const result = await requestFlowSwapQuote(h.args);
          assert.equal(result.view.priceLossBps, loss);
          assert.equal(result.view.output.quoted, h.quoted.toString());
          assert.equal(result.view.recipient, OWNER); assert.equal(result.view.expectedPayer, OWNER);
          assert.equal(result.view.venueId, 'unitflow-v3');
          assert.equal(result.view.unsigned.wrapTx, null);
          assert.equal(result.view.unsigned.swapTx.value, '0');
          assert.equal(result.tower.available, false); assert.deepEqual(h.effects, ['findMany', 'create']);
        }
        assert.ok(h.rpcCalls.includes('slot0'), 'actual builder derives loss from the pool mid');
      });
    });
  }
  for (const loss of [500, 501]) {
    test(`${direction}: independent Circle execution price guard at ${loss}bps`, async (t) => {
      await withNetwork(MAINNET, async () => {
        const h = fixture(t, MAINNET, loss, direction);
        const expiresAtSec = Math.floor(Date.now() / 1000) + 300;
        const envelope = await buildUnitFlowV3Execution({ ...h.args, merchantSCA: OWNER,
          expectedPayer: OWNER, allowSelfPayer: true, expiresAtSec }, MAINNET);
        h.rows.set('offline-intent', { id: 'offline-intent', ownerWallet: OWNER, status: 'QUOTED',
          inputSymbol: h.args.inputSymbol, outputSymbol: h.args.outputSymbol, inputAmount: INPUT.toString(),
          slippageBps: envelope.slippageBps, feeTier: envelope.fee,
          quoteExpiresAt: new Date(expiresAtSec * 1000), poolAddress: envelope.pool,
          quotedOutputSwap: envelope.quotedOutputSwap.toString(), minOutputSwap: envelope.minOutSwap.toString(),
          executionIdentity: envelope.executionIdentity, executionTxHash: null });
        await assert.rejects(executeFlowSwapAsServer({ ownerWallet: OWNER, circleWalletId: 'offline-no-signing', intentId: 'offline-intent' }),
          loss > 500
            ? (e) => e.status === 400 && /refusing to execute/.test(e.message)
            : /Missing Circle credentials/);
        assert.deepEqual(h.effects, ['findUnique'], 'no persistence/broadcast after the fixture read');
      });
    });
  }
}

for (const direction of ['USDC->EURC', 'EURC->USDC']) {
  test(`${direction}: actual testnet quote remains informational above the mainnet block threshold`, async (t) => {
    const env = { ...MAINNET, ARC_NETWORK: 'testnet', NEXT_PUBLIC_ARC_NETWORK: 'testnet' };
    await withNetwork(env, async () => {
      const h = fixture(t, env, 600, direction);
      const deployment = getUnitFlowV3Deployment(env);
      const result = await requestFlowSwapQuote(h.args);
      assert.equal(result.view.deploymentName, 'testnet');
      assert.ok(result.view.priceLossBps > 500);
      assert.equal(result.view.output.quoted, h.quoted.toString());
      assert.equal(result.view.input.address, getTokenBySymbol(h.args.inputSymbol).address);
      assert.equal(result.view.output.address, getTokenBySymbol(h.args.outputSymbol).address);
      assert.equal(result.view.unsigned.swapTx.to, deployment.universalRouter);
      assert.equal(result.view.unsigned.swapTx.value, '0');
      if (h.args.inputSymbol === 'USDC') {
        assert.equal(result.view.unsigned.wrapTx.to, deployment.wusdc);
        assert.equal(result.view.unsigned.wrapTx.value, toSwapUnits('USDC', INPUT, deployment).toString());
      } else assert.equal(result.view.unsigned.wrapTx, null);
      assert.deepEqual(h.effects, ['findMany', 'create']);
      assert.ok(h.rpcCalls.includes('slot0'));
    });
  });
}

for (const responseKind of ['valid', 'wrong-token', 'wrong-amount', 'zero-output', 'http-403']) {
  test(`Tower ${responseKind}: real candidate result controls attribution`, async (t) => {
    await withNetwork(MAINNET, async () => {
      const requests = [];
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(String(url), 'https://tower.swap-fixture.example/api/public/swap/quote');
        assert.equal(init.method, 'POST');
        const body = JSON.parse(init.body); requests.push(body);
        const data = { ...body, outputAmount: '950000', minOut: '940000' };
        if (responseKind === 'wrong-token') data.outputToken = '0x' + 'f'.repeat(40);
        if (responseKind === 'wrong-amount') data.inputAmount = '2000000';
        if (responseKind === 'zero-output') data.outputAmount = '0';
        return Response.json(responseKind === 'http-403' ? { success: false, error: 'fixture rejected' } : { success: true, data },
          { status: responseKind === 'http-403' ? 403 : 200 });
      });
      const result = await getTowerCandidate({ inputSymbol: 'USDC', outputSymbol: 'EURC', inputAmount: INPUT,
        env: { ...MAINNET, ROUTING_PROVIDER_TOWER_ENABLED: '1',
          TOWER_SWAP_API_KEY: 'offline-fixture-not-a-credential', TOWER_SWAP_BASE_URL: 'https://tower.swap-fixture.example' } });
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0], { inputToken: USDC, outputToken: EURC, inputAmount: INPUT.toString() });
      assert.equal(result.consulted, true);
      assert.equal(result.available, responseKind === 'valid');
      assert.equal(shouldShowTowerAttribution(result), responseKind === 'valid');
      if (responseKind === 'valid') {
        assert.equal(result.quotedOutput, '950000'); assert.match(result.note, /Tower does not execute/);
      }
    });
  });
}
