import express from 'express';
import webhookRouter from './lib/payments/webhooks.js';

const app = express();

// Plug your new webhook paths directly into your main app
app.use(webhookRouter);

// Your regular human UI or application routes continue below unbothered
app.use(express.json());
app.get('/dashboard', (req, res) => {
  res.send('Your original dashboard screen UI is completely safe here.');
});

app.listen(3000, () => console.log('Arcflare backend running on port 3000'));
