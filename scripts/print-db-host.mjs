// scripts/print-db-host.mjs
// Prints only the DATABASE_URL host (never the secret) so gates can confirm
// which DB a suite run will touch. Usage: node scripts/print-db-host.mjs
import fs from 'node:fs';
function firstDbUrl() {
  for (const f of ['.env.local', '.env']) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const line = text.split('\n').find((l) => l.trim().startsWith('DATABASE_URL='));
      if (line) return { file: f, url: line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') };
    } catch { /* missing */ }
  }
  if (process.env.DATABASE_URL) return { file: 'env', url: process.env.DATABASE_URL };
  return null;
}
const found = firstDbUrl();
if (!found) { console.log('DATABASE_URL: missing'); process.exit(1); }
try {
  const u = found.url.replace(/^prisma\+postgres:\/\//, 'https://');
  console.log('DATABASE_URL host (' + found.file + '): ' + new URL(u).host);
} catch { console.log('DATABASE_URL: present but unparseable (' + found.file + ')'); }
