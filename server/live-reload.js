import fs from 'node:fs';
import path from 'node:path';

const HOT_EXTS = new Set(['.css', '.html', '.js']);

const CLIENT_JS = `(function () {
  const source = new EventSource('/__dev/events');
  source.onmessage = function (event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.type === 'css') {
      document.querySelectorAll('link[rel="stylesheet"]').forEach(function (link) {
        const url = new URL(link.href, location.href);
        if (url.origin !== location.origin) return;
        url.searchParams.set('t', String(Date.now()));
        link.href = url.href;
      });
      return;
    }
    if (data.type === 'reload') {
      location.reload();
    }
  };
})();
`;

function truthy(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function isLiveReloadEnabled() {
  return (
    truthy(process.env.SOPHISTAI_LIVE_RELOAD) ||
    truthy(process.env.SOFISTAI_LIVE_RELOAD)
  );
}

export function attachLiveReload(app, publicDir) {
  const enabled = isLiveReloadEnabled();

  function sendIndex(_req, res) {
    if (!enabled) {
      res.sendFile(path.join(publicDir, 'index.html'));
      return;
    }
    let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    if (html.includes('</body>')) {
      html = html.replace(
        '</body>',
        '    <script src="/__dev/reload.js"></script>\n  </body>'
      );
    } else {
      html += '<script src="/__dev/reload.js"></script>\n';
    }
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  }

  if (!enabled) {
    return { enabled, sendIndex, staticOptions: {} };
  }

  const clients = new Set();

  app.get('/__dev/reload.js', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('js').send(CLIENT_JS);
  });

  app.get('/__dev/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  let debounce;
  const watcher = fs.watch(
    publicDir,
    { recursive: true },
    (_event, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).toLowerCase();
      if (!HOT_EXTS.has(ext)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const type = ext === '.css' ? 'css' : 'reload';
        const payload = `data: ${JSON.stringify({ type, file: filename })}\n\n`;
        for (const client of clients) {
          client.write(payload);
        }
      }, 80);
    }
  );
  watcher.on('error', (err) => {
    console.error('Live reload: no se pudo vigilar public/', err);
  });

  return {
    enabled,
    sendIndex,
    staticOptions: {
      index: false,
      etag: false,
      lastModified: false,
      setHeaders(res) {
        res.set('Cache-Control', 'no-store');
      },
    },
  };
}
