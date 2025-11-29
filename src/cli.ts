#!/usr/bin/env node
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { loadConfigFromEnv } from './config.js';
import { TelegramCodexBridge } from './telegramCodexBridge.js';
import { botifyVersion } from './version.js';

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has('--version') || args.has('-v')) {
    const details = [`botify ${botifyVersion.version}`];
    if (botifyVersion.branch && botifyVersion.branch !== 'unknown') {
      details.push(`branch: ${botifyVersion.branch}`);
    }
    if (botifyVersion.commit && botifyVersion.commit !== 'unknown') {
      details.push(`commit: ${botifyVersion.commit}`);
    }
    console.log(details.join(' | '));
    return;
  }

  loadDotenv();

  if (args.has('--status')) {
    try {
      const config = loadConfigFromEnv();
      const bridge = new TelegramCodexBridge(config);
      console.log(bridge.getStatusReport());
      return;
    } catch (err) {
      console.error(`Failed to render status: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }
  let bridge: TelegramCodexBridge | null = null;
  let unsubscribeFatal: (() => void) | null = null;
  let fatalHandled = false;

  try {
    const config = loadConfigFromEnv();
    bridge = new TelegramCodexBridge(config);
    unsubscribeFatal = bridge.onFatal((error: Error) => {
      if (fatalHandled) {
        return;
      }
      fatalHandled = true;
      console.error(`Fatal bridge error: ${error.message}`);
      const stopping = bridge ? bridge.stop() : Promise.resolve();
      void stopping
        .catch(() => {})
        .finally(() => {
          process.exit(1);
        });
    });
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
      unsubscribeFatal?.();
      unsubscribeFatal = null;
      if (bridge) {
        bridge
          .stop(signal)
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
