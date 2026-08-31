/**
 * scripts/arcscan-links-tests.mjs
 *
 * Static assertions that Flow/consumer Recent Activity rows render Arcscan
 * explorer links for items with a transaction hash, and degrade gracefully
 * (no dead link) for items without one.
 *
 * Run: node scripts/arcscan-links-tests.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('═══ Arcscan links on consumer Recent Activity ═══');

const src = readFileSync(join(here, '..', 'src', 'app', 'consumer', 'page.tsx'), 'utf8');
const start = src.indexOf('{activity.map(');
const activityBlock = src.slice(start, src.indexOf('))}', start));

ok(src.includes('interface ActivityItem') && src.includes('explorerUrl?: string | null;'),
  'ActivityItem type includes explorerUrl (nullable)');
ok(src.includes('useState<ActivityItem[]>([])'), 'activity state is typed with ActivityItem');
ok(activityBlock.includes('a.explorerUrl ?'), 'activity rows branch on explorerUrl presence');
ok(activityBlock.includes('href={a.explorerUrl}'), 'row link points at the API-provided explorerUrl');
ok(activityBlock.includes('target="_blank" rel="noopener noreferrer"'), 'row link opens in a new tab safely');
ok(activityBlock.includes('styles.resultLink'), 'row link reuses the existing resultLink styling (same pattern as result.explorerUrl)');
ok(activityBlock.includes('Pending'), 'null explorerUrl renders a pending indicator instead of a dead link');

// The API really returns explorerUrl per row.
const api = readFileSync(join(here, '..', 'src', 'app', 'api', 'consumer', 'activity', 'route.ts'), 'utf8');
ok(api.includes('arcTxHash'), 'activity API still computes explorerUrl from arcTxHash');
ok(api.includes('testnet.arcscan.app/tx/'), 'activity API points at Arcscan');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
