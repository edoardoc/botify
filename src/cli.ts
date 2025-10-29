#!/usr/bin/env node
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { loadConfigFromEnv } from './config.js';
import { TelegramCodexBridge } from './telegramCodexBridge.js';

async function main(): Promise<void> {
  loadDotenv();
  let bridge: TelegramCodexBridge | null = null;

  try {
    const config = loadConfigFromEnv();
    bridge = new TelegramCodexBridge(config);
    await bridge.start();
    console.log('Telegram Codex bridge is running. Press Ctrl+C to stop.');
  } catch (err) {
    console.error(`Failed to start bridge: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  await new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals) => {
      console.log(`Received ${signal}. Shutting down bridge...`);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      if (bridge) {
        bridge
          .stop()
          .then(() => resolve())
          .catch(() => resolve());
      } else {
        resolve();
      }
    };

    const onSigint = () => shutdown('SIGINT');
    const onSigterm = () => shutdown('SIGTERM');

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  });
}

void main();
