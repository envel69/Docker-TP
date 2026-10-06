import express from 'express';
import os from 'os';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const MESSAGE = process.env.MESSAGE || 'Hello from TD2!';
const APP_VERSION = process.env.APP_VERSION || '0.0.1';

app.get('/', (_req, res) => {
  res.json({
    message: MESSAGE,
    version: APP_VERSION,
    hostname: os.hostname(),
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
