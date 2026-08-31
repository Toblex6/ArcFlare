/**
 * scripts/telegram-register-commands.mjs
 *
 * ONE-TIME setup script. Run this once after deploying (or any time a
 * command is ADDED or its DESCRIPTION CHANGES) so the commands appear in
 * Telegram's "/" autocomplete menu. Telegram's setMyCommands REPLACES the
 * whole list — there is no incremental sync — so this file holds the full
 * canonical command list (TELEGRAM_COMMANDS in scripts/telegram-commands.mjs)
 * and must be re-run manually after any command change. It does NOT auto-run
 * on deploy, mirroring telegram-register-webhook.mjs.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx node scripts/telegram-register-commands.mjs
 *
 * Verify with: curl https://api.telegram.org/bot<TOKEN>/getMyCommands
 */

import { TELEGRAM_COMMANDS } from './telegram-commands.mjs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in env.');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ commands: TELEGRAM_COMMANDS }),
});

const body = await res.json();

if (!body.ok) {
  console.error('setMyCommands FAILED:', JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(`Registered ${TELEGRAM_COMMANDS.length} commands with Telegram:`);
for (const c of TELEGRAM_COMMANDS) {
  console.log(`  /${c.command} — ${c.description}`);
}
console.log('Verify with: curl https://api.telegram.org/bot<TOKEN>/getMyCommands');
