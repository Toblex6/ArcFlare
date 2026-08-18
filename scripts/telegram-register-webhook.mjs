/**
 * scripts/telegram-register-webhook.mjs
 *
 * ONE-TIME setup script. Run this once after deploying to Render (or any
 * time your webhook URL/secret changes). Registers your production URL
 * with Telegram so it starts sending updates to /api/telegram/webhook.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_WEBHOOK_SECRET=xxx node scripts/telegram-register-webhook.mjs https://your-app.onrender.com
 *
 * This does NOT run automatically on deploy — deliberately manual, since
 * registering the wrong URL (e.g. accidentally against a staging domain)
 * silently redirects all bot traffic there. Run it yourself, once,
 * after confirming the domain is correct.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const baseUrl = process.argv[2];

if (!BOT_TOKEN || !WEBHOOK_SECRET) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET in env.');
  process.exit(1);
}

if (!baseUrl || !baseUrl.startsWith('https://')) {
  console.error('Usage: node scripts/telegram-register-webhook.mjs https://your-production-domain.com');
  console.error('Must be https:// — Telegram will refuse http:// webhook URLs.');
  process.exit(1);
}

const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: WEBHOOK_SECRET,
    // drop_pending_updates avoids a burst of stale/queued updates from
    // any previous webhook registration (e.g. a stale staging URL)
    // hitting the new endpoint all at once.
    drop_pending_updates: true,
  }),
});

const body = await res.json();

if (!body.ok) {
  console.error('setWebhook FAILED:', JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(`Webhook registered: ${webhookUrl}`);
console.log('Verify with: curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo');
