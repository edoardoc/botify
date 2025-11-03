import path from 'node:path';
import { BotifyConfig } from './types.js';

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on', 'y']);
const BOOL_FALSE = new Set(['0', 'false', 'no', 'off', 'n']);

export function loadConfigFromEnv(options: LoadConfigOptions = {}): BotifyConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const botToken = getEnv(env, 'TELEGRAM_BOT_TOKEN', true);
  const chatId = getEnv(env, 'TELEGRAM_CHAT_ID', true);
  const pollingTimeout = toNumber(env.TELEGRAM_POLL_TIMEOUT, 25);
  const codexCommand = env.CODEX_COMMAND?.trim() || 'codex mcp-server';
  const codexCwd = env.CODEX_CWD?.trim() || cwd;
  const codexHome =
    env.CODEX_HOME?.trim() ||
    path.join(codexCwd, '.codex_mcp_home');
  const sandboxMode = env.CODEX_SANDBOX?.trim() || 'danger-full-access';
  const approvalPolicy = env.CODEX_APPROVAL_POLICY?.trim() || 'never';
  const profile = blankToUndefined(env.CODEX_PROFILE);
  const model = blankToUndefined(env.CODEX_MODEL);
  const includePlanTool = toOptionalBool(env.CODEX_INCLUDE_PLAN_TOOL);
  const baseInstructions = blankToUndefined(env.CODEX_BASE_INSTRUCTIONS);
  const configOverrides = parseJson(blankToUndefined(env.CODEX_CONFIG_OVERRIDES));
  const rpcTimeoutMs = toNumber(env.CODEX_RPC_TIMEOUT_MS, 900000);
  const exitLogLines = toNumber(env.CODEX_EXIT_LOG_LINES, 40);
  const outputChunk = toNumber(env.CODEX_OUTPUT_CHUNK, 3500);

  return {
    botToken,
    chatId,
    pollingTimeout,
    codexCommand,
    codexCwd,
    codexHome,
    sandboxMode,
    approvalPolicy,
    profile,
    model,
    includePlanTool,
    baseInstructions,
    configOverrides,
    rpcTimeoutMs,
    exitLogLines,
    outputChunk,
  };
}

function getEnv(env: NodeJS.ProcessEnv, key: string, required: boolean): string {
  const value = env[key];
  if (!value || !value.trim().length) {
    if (required) {
      throw new Error(`Missing required environment variable ${key}.`);
    }
    return '';
  }
  return value.trim();
}

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalBool(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (BOOL_TRUE.has(normalized)) {
    return true;
  }
  if (BOOL_FALSE.has(normalized)) {
    return false;
  }
  return undefined;
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse CODEX_CONFIG_OVERRIDES as JSON. ${(err as Error).message}`);
  }
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}
