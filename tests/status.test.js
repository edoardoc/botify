import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromEnv } from '../dist/config.js';
import { TelegramCodexBridge } from '../dist/telegramCodexBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const REQUIRED_ENV = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_CHAT_ID: '123456',
};
const STUB_PATH = path.join(__dirname, 'fixtures', 'bin');

test('CLI --status matches bridge status report', async () => {
  const env = { ...process.env, ...REQUIRED_ENV };
  env.PATH = `${STUB_PATH}${path.delimiter}${env.PATH ?? ''}`;
  const config = loadConfigFromEnv({ env, cwd: ROOT });
  const bridge = new TelegramCodexBridge(config);
  const expected = await bridge.getStatusReport({ refreshAuth: true, source: 'cli-status' });
  const cliPath = path.join(ROOT, 'dist/cli.js');
  const result = spawnSync('node', [cliPath, '--status'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
});
