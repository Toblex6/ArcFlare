// Run after next build: node scripts/mainnet-optional-boot-tests.mjs
// Starts the real production server with optional features disabled. Only
// network-descriptor and fail-closed paid/bridge requests; no DB or funds.
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
for (const key of ['ARC_MAINNET_STREAM_ADDRESS', 'ARC_MAINNET_X402_VERIFIER', 'ARC_MAINNET_ESCROW_ADDRESS',
  'ARCFLARE_STREAM_CONTRACT_ADDRESS', 'ARC_FLARE_STREAM_CONTRACT_ADDRESS',
  'CCTP_MAINNET_SOURCES_JSON', 'CCTP_MAINNET_ARC_CHAIN_ID', 'SELLER_WALLET_ADDRESS',
  'SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN']) env[key] = '';
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
  assert.equal((await network.json()).name, 'mainnet');
  checks++;
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
  console.log(`mainnet-optional-boot: ${checks}/${checks} passed (CCTP_MAINNET_* absent; ARC_MAINNET_CCTP_* topology retained; no funds moved)`);
} finally {
  server.kill();
  await stopped;
}
