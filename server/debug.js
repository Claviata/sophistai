import fs from 'node:fs';
import path from 'node:path';
import { getApiKey, rootDir } from './env.js';

const logsDir = path.join(rootDir, 'data', 'logs');

function truthy(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function isDebugEnabled() {
  return truthy(process.env.SOFISTAI_DEBUG) || truthy(process.env.DEBUG);
}

function ensureLogsDir() {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

function scrubSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text
    .replace(/sk-or-[a-zA-Z0-9_-]+/g, 'sk-or-[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
  const liveKey = getApiKey();
  if (liveKey && liveKey.length >= 8) {
    out = out.split(liveKey).join('[REDACTED]');
  }
  return out;
}

function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return scrubSecrets(value);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/apikey|api_key|authorization|password|secret|token/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

function writeLine(filePath, entry) {
  ensureLogsDir();
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Log a debug event. When conversationId is set, also appends to
 * data/logs/conversation-{id}.jsonl
 */
export function debugLog(event, details = {}, conversationId = null) {
  if (!isDebugEnabled()) return;

  const entry = {
    ts: new Date().toISOString(),
    event,
    conversationId: conversationId == null ? null : Number(conversationId),
    ...redact(details),
  };

  const line = `[sofistai:debug] ${entry.ts} ${event}${
    entry.conversationId != null ? ` conv=${entry.conversationId}` : ''
  }`;
  console.log(line, details && Object.keys(details).length ? redact(details) : '');

  writeLine(path.join(logsDir, 'app.jsonl'), entry);

  if (entry.conversationId != null && Number.isFinite(entry.conversationId)) {
    writeLine(
      path.join(logsDir, `conversation-${entry.conversationId}.jsonl`),
      entry
    );
  }
}

export function conversationLog(conversationId, event, details = {}) {
  debugLog(event, details, conversationId);
}

export function getLogsDir() {
  return logsDir;
}
