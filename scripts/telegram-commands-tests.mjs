/**
 * scripts/telegram-commands-tests.mjs
 *
 * Assertion test for the /-menu command list — no live Telegram API call.
 * Asserts:
 *  1. The canonical list in telegram-commands.mjs is the full current
 *     command set, matching every command the webhook route dispatches.
 *  2. Every command name is 1-32 chars and lowercase (Telegram limits).
 *  3. Every description is non-empty and under 40 chars (menu readability).
 *  4. register-commands script actually sends this list as `commands`.
 *
 * Run: node scripts/telegram-commands-tests.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TELEGRAM_COMMANDS } from './telegram-commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log('═══ Telegram setMyCommands payload ═══');

// 1. Full command list matches the webhook dispatcher.
const webhook = readFileSync(join(here, '..', 'src', 'app', 'api', 'telegram', 'webhook', 'route.ts'), 'utf8');
const dispatched = [...webhook.matchAll(/case\s+'\/([a-z]+)'/g)].map((m) => m[1]);
ok(dispatched.length > 0, `webhook route dispatches ${dispatched.length} commands`);
const missing = dispatched.filter((c) => !TELEGRAM_COMMANDS.some((x) => x.command === c));
ok(missing.length === 0, 'every dispatched command is registered in the menu', `missing: ${missing.join(', ')}`);
const extra = TELEGRAM_COMMANDS.filter((c) => !dispatched.includes(c.command)).map((c) => c.command);
ok(extra.length === 0, 'no stale commands registered that the bot cannot handle', `extra: ${extra.join(', ')}`);

// 2/3. Telegram API constraints.
for (const c of TELEGRAM_COMMANDS) {
  ok(/^[a-z0-9_]{1,32}$/.test(c.command), `command /${c.command} name is valid`, c.command);
  ok(typeof c.description === 'string' && c.description.length > 0 && c.description.length <= 40,
    `/${c.command} description is 1-40 chars`, `${c.description?.length} chars`);
}

// 4. The register script sends this exact list.
const reg = readFileSync(join(here, 'telegram-register-commands.mjs'), 'utf8');
ok(reg.includes("import { TELEGRAM_COMMANDS } from './telegram-commands.mjs'"), 'register script imports the canonical list');
ok(reg.includes('body: JSON.stringify({ commands: TELEGRAM_COMMANDS })'), 'register script sends the list as setMyCommands.commands');
ok(reg.includes('setMyCommands'), 'register script calls setMyCommands');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
