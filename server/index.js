import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, hasApiKey, rootDir } from './env.js';
import { debugLog, isDebugEnabled, getLogsDir } from './debug.js';
import { attachLiveReload } from './live-reload.js';
import {
  apiErrorHandler,
  assertBindAllowed,
  originGuard,
} from './security.js';
import './db.js';
import settingsRouter from './routes/settings.js';
import conversationsRouter, {
  modelsHandler,
} from './routes/conversations.js';
import turnsRouter from './routes/turns.js';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, 'public');
const app = express();
const PORT = Number(process.env.PORT) || 3847;

app.use(express.json({ limit: '1mb' }));

const HOST = process.env.HOST || '127.0.0.1';
assertBindAllowed(HOST);

const liveReload = attachLiveReload(app, publicDir);

app.use(originGuard(HOST, PORT));

app.use((req, res, next) => {
  if (!isDebugEnabled() || !req.path.startsWith('/api/')) {
    return next();
  }
  const started = Date.now();
  const convMatch = req.path.match(/^\/api\/conversations\/(\d+)/);
  const conversationId = convMatch ? Number(convMatch[1]) : null;
  res.on('finish', () => {
    debugLog(
      'http.request',
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        query: req.query,
      },
      conversationId
    );
  });
  next();
});

app.use(express.static(publicDir, liveReload.staticOptions));
app.get('/vendor/marked/marked.esm.js', (_req, res) => {
  res.sendFile(path.join(rootDir, 'node_modules/marked/lib/marked.esm.js'));
});
app.get('/vendor/dompurify/purify.es.mjs', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(rootDir, 'node_modules/dompurify/dist/purify.es.mjs'));
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    name: 'sophistai',
    apiKeyConfigured: hasApiKey(),
    debug: isDebugEnabled(),
  });
});

app.use('/api/settings', settingsRouter);
app.get('/api/models', modelsHandler);
app.use('/api/conversations', conversationsRouter);
app.use('/api/conversations/:id', turnsRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Ruta API no encontrada' });
});

app.get('/{*splat}', liveReload.sendIndex);

app.use(apiErrorHandler);

app.listen(PORT, HOST, () => {
  console.log(`Sophistaí en http://${HOST}:${PORT}`);
  if (liveReload.enabled) {
    console.log('Live reload: CSS en caliente; HTML/JS recargan la página');
  }
  console.log(
    hasApiKey()
      ? 'OPENROUTER_API_KEY configurada'
      : 'OPENROUTER_API_KEY pendiente (configúrala en la UI o en .env)'
  );
  if (isDebugEnabled()) {
    console.log(`Modo debug activo → logs en ${getLogsDir()}`);
    debugLog('server.start', {
      host: HOST,
      port: PORT,
      apiKeyConfigured: hasApiKey(),
    });
  }
});
