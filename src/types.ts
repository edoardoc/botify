export interface BotifyConfig {
  botToken: string;
  chatId: string;
  pollingTimeout: number;
  codexCommand: string;
  codexCwd: string;
  codexHome: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  attachmentsDir: string;
  profile?: string;
  model?: string;
  includePlanTool?: boolean;
  baseInstructions?: string;
  configOverrides?: unknown;
  rpcTimeoutMs: number;
  exitLogLines: number;
  outputChunk: number;
}

export interface BridgeLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
}

export interface BridgeLifecycle {
  start(): Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export interface StartOptions {
  signal?: AbortSignal;
}
