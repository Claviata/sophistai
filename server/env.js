import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.join(__dirname, '..');
export const envPath = process.env.SOPHISTAI_ENV_PATH || path.join(rootDir, '.env');

export function loadEnv() {
  dotenv.config({ path: envPath, override: true, quiet: true });
}

export function hasApiKey() {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

export function getApiKey() {
  return process.env.OPENROUTER_API_KEY?.trim() || '';
}

function validateApiKey(apiKey) {
  const key = String(apiKey ?? '');
  if (!key.trim()) {
    throw new Error('La API key no puede estar vacía');
  }
  if (key !== key.trim()) {
    throw new Error('La API key no puede tener espacios al inicio o al final');
  }
  if (/[\r\n\0]/.test(key)) {
    throw new Error('La API key no puede contener saltos de línea');
  }
  if (/\s/.test(key)) {
    throw new Error('La API key no puede contener espacios');
  }
  if (key.includes('#') || key.includes('"') || key.includes("'")) {
    throw new Error('La API key contiene caracteres no permitidos');
  }
  return key;
}

/**
 * Upsert OPENROUTER_API_KEY in .env without wiping other keys.
 */
export function writeApiKey(apiKey) {
  const key = validateApiKey(apiKey);

  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }

  const line = `OPENROUTER_API_KEY=${key}`;
  if (/^OPENROUTER_API_KEY=/m.test(content)) {
    content = content.replace(/^OPENROUTER_API_KEY=.*$/m, () => line);
  } else if (content.trim()) {
    content = `${content.replace(/\s*$/, '')}\n${line}\n`;
  } else {
    content = `${line}\n`;
  }

  fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // best-effort on platforms that ignore mode
  }
  process.env.OPENROUTER_API_KEY = key;
  loadEnv();
  return true;
}
