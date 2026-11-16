// Run after next build: node scripts/mainnet-optional-boot-tests.mjs
// Starts the real production server with optional features disabled. Only
// public-page loads and fail-closed requests; no DB, signing, or funds.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { MAINNET_ENV } from '../tests/fixtures/mainnet-env.mjs';

const portServer = createServer();
await new Promise((resolve, reject) => {
  portServer.once('error', reject);
  portServer.listen(0, '127.0.0.1', resolve);
});
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const env = { ...process.env, ...MAINNET_ENV };
for (const key of Object.keys(env)) {
  if (/^CCTP_MAINNET_/.test(key)) env[key] = '';
}
for (const key of ['ARC_MAINNET_STREAM_ADDRESS', 'ARC_MAINNET_X402_VERIFIER', 'ARC_MAINNET_ESCROW_ADDRESS', 'ARC_MAINNET_ERC8183_ADDRESS',
  'ARCFLARE_STREAM_CONTRACT_ADDRESS', 'ARC_FLARE_STREAM_CONTRACT_ADDRESS', 'ESCROW_ADMIN_PRIVATE_KEY',
  'CCTP_MAINNET_SOURCES_JSON', 'CCTP_MAINNET_ARC_CHAIN_ID', 'SELLER_WALLET_ADDRESS',
  'SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN']) env[key] = '';
// Never let an unexpected page read reach the production database.
env.DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:1/offline';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let checks = 0;
const stopped = new Promise((resolve) => server.once('exit', resolve));
try {
  await new Promise((resolve, reject) => {
    // Event-driven readiness, not sleep/polling. A bounded timeout is only a
    // failure deadline for a server that never announces successful startup.
    const deadline = setTimeout(() => reject(new Error(`Server startup timed out:\n${output}`)), 120_000);
    const collect = (chunk) => {
      output += chunk.toString();
      if (/Ready in/.test(output)) { clearTimeout(deadline); resolve(); }
    };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
    server.once('error', (error) => { clearTimeout(deadline); reject(error); });
    server.once('exit', (code) => { clearTimeout(deadline); reject(new Error(`Server exited ${code}:\n${output}`)); });
  });
  checks++;
  const base = `http://127.0.0.1:${port}`;
  const network = await fetch(`${base}/api/network`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(network.status, 200);
  const descriptor = await network.json();
  assert.equal(descriptor.name, 'mainnet');
  assert.equal(descriptor.chainId, 5042);
  assert.equal(descriptor.erc8183Address, null);
  checks++;
  for (const path of ['/', '/docs', '/docs/api', '/docs/merchant', '/docs/agents', '/merchant/login', '/consumer']) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `GET ${path}`);
    const html = await response.text();
    assert.ok(!html.includes('Application error:'), `no error boundary on ${path}`);
    const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (path === '/') {
      assert.match(text, /Mainnet accept, fund and completion actions are unavailable without ERC-8183/);
      assert.match(text, /Illustrative receipt/);
      assert.doesNotMatch(text, /funded \$250|rep 92|Live on/);
    }
    if (path.startsWith('/docs')) {
      assert.match(text, /Built on Arc\s/);
      assert.doesNotMatch(text, /Built on Arc Testnet/);
      assert.match(text, /mainnet|Mainnet/);
    }
    if (path === '/docs') {
      assert.match(text, /Arc Mainnet/);
      assert.match(text, /5042/);
      assert.doesNotMatch(text, /5042002/);
    }
    checks++;
  }
  const load = await Promise.all(Array.from({ length: 12 }, async () => {
    const response = await fetch(`${base}/api/network`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).chainId, 5042);
  }));
  checks += load.length;
  for (const [path, methods] of [
    ['/api/agent/brain', ['POST']], ['/api/nano/pay/agent-lookup', ['POST']],
    ['/api/x402/marketplace/pay/test-disabled', ['GET', 'POST', 'PUT', 'DELETE']],
    ['/api/cctp/transfer', ['GET']],
  ]) for (const method of methods) {
    const response = await fetch(`${base}${path}`, {
      method, headers: { 'payment-signature': Buffer.from('{}').toString('base64') },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.equal(response.headers.has('PAYMENT-REQUIRED'), false);
    const body = await response.json();
    assert.equal(body.code, path.includes('/cctp/') ? 'cctp_unavailable' : 'x402_unavailable');
    checks++;
  }
  for (const action of ['create', 'stop', 'withdraw']) {
    const response = await fetch(`${base}/api/payments/stream/${action}`, {
      method: 'POST', body: '{', signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'stream_unavailable');
    checks++;
  }
  for (const action of ['open', 'release', 'close']) {
    const response = await fetch(`${base}/api/jobs/nanopay/${action}`, {
      method: 'POST', body: '{', signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'stream_unavailable');
    checks++;
  }
  const listing = await fetch(`${base}/api/payments/stream/create`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(listing.status, 401, 'legacy GET still requires authentication');
  checks++;
  console.log(`mainnet-optional-boot: ${checks}/${checks} passed (built server, public pages, 12 concurrent descriptor reads, unavailable POSTs, authenticated GET boundary; no live DB or funds)`);
} finally {
  server.kill();
  await stopped;
}
