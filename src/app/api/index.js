import express from 'express';

const app = express();

// Use Express's built-in raw text parser specifically for Circle's JSON pings
app.post('/api/v1/webhooks/cctp', express.text({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body;

    // Safety check for empty initialization pings from Circle
    if (!rawBody || rawBody.trim() === '' || Object.keys(rawBody).length === 0) {
      console.log('📨 Circle webhook handshake validation caught successfully.');
      return res.status(200).send('OK');
    }

    const event = JSON.parse(rawBody);
    console.log(`✉️ Circle Webhook Logged: ${event.type}`);

    return res.status(200).send('OK');
  } catch (err) {
    console.error('⚠️ Safely skipped parsing mismatch:', err.message);
    return res.status(200).send('Handled');
  }
});

// A standard GET route on the root path so you can test it in your browser
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    gateway: 'Arcflare Serverless Engine',
    timestamp: new Date().toISOString(),
  });
});

// CRITICAL FOR VERCEL: Do NOT use app.listen(). Export the app instead!
export default app;
