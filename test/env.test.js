import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sophistai-env-'));
const envFile = path.join(dir, '.env');
fs.writeFileSync(envFile, 'UNRELATED=keep-me\nOPENROUTER_API_KEY=old-key\n');
process.env.SOPHISTAI_ENV_PATH = envFile;

const { writeApiKey, getApiKey } = await import('../server/env.js');

test('writeApiKey round-trips $ in the value without eating other keys', () => {
  const key = 'sk-or-v1-$&$1$$tail';
  writeApiKey(key);
  const content = fs.readFileSync(envFile, 'utf8');
  assert.match(content, /^UNRELATED=keep-me$/m);
  assert.match(content, /^OPENROUTER_API_KEY=sk-or-v1-\$&\$1\$\$tail$/m);
  assert.equal(getApiKey(), key);
});
