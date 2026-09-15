import { Router } from 'express';
import { debugLog } from '../debug.js';
import { hasApiKey, writeApiKey } from '../env.js';

const router = Router();

router.get('/key', (_req, res) => {
  const configured = hasApiKey();
  debugLog('settings.key.status', { configured });
  res.json({ configured });
});

router.put('/key', (req, res) => {
  try {
    const { apiKey } = req.body || {};
    writeApiKey(apiKey);
    debugLog('settings.key.saved', {
      configured: true,
      keyLength: String(apiKey || '').trim().length,
    });
    res.json({ configured: true });
  } catch (err) {
    debugLog('settings.key.save_error', { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

export default router;
