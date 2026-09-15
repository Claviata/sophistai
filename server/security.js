function truthy(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function isLoopbackHost(host) {
  const h = String(host || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function isWildcardBind(host) {
  const h = String(host || '')
    .trim()
    .replace(/^\[|\]$/g, '');
  return h === '0.0.0.0' || h === '::' || h === '*';
}

export function assertBindAllowed(host) {
  if (isLoopbackHost(host)) return;
  if (truthy(process.env.SOPHISTAI_ALLOW_REMOTE)) {
    console.warn(
      `Sophistaí escuchando en ${host} (SOPHISTAI_ALLOW_REMOTE=1). Cualquier cliente que alcance el puerto puede usar tu API key y las salas.`
    );
    return;
  }
  throw new Error(
    `HOST=${host} no es loopback. Usa HOST=127.0.0.1 o define SOPHISTAI_ALLOW_REMOTE=1.`
  );
}

export function originGuard(host, port) {
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  if (host && !isWildcardBind(host)) {
    const bare = String(host).replace(/^\[|\]$/g, '');
    const needsBrackets = bare.includes(':');
    allowed.add(`http://${needsBrackets ? `[${bare}]` : bare}:${port}`);
  }
  return (req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    if (allowed.has(origin)) return next();
    res.status(403).json({ error: 'Origen no permitido' });
  };
}

export function apiErrorHandler(err, req, res, next) {
  if (!req.path?.startsWith('/api')) {
    next(err);
    return;
  }
  const status = Number(err.status) || 500;
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(status).json({ error: err.message || 'Error interno' });
}
