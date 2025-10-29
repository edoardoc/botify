import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import https from 'node:https';
import fs from 'node:fs';
import readline from 'node:readline';
import { BotifyConfig, BridgeLogger } from './types.js';

interface MessageQueueItem {
  text: string;
  metadata: {
    from: string;
  };
}

interface RpcPending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  method: string;
}

interface CodexMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
}

export class TelegramCodexBridge {
  private readonly logger: BridgeLogger;
  private codexProcess: ChildProcessWithoutNullStreams | null = null;
  private codexReady = false;
  private currentConversationId: string | null = null;
  private lastRolloutPath: string | null = null;
  private processingQueue = false;
  private warnedMissingConversationId = false;
  private missingConversationIdTimeout: NodeJS.Timeout | null = null;
  private stdoutRl: readline.Interface | null = null;
  private pollLoopPromise: Promise<void> | null = null;
  private initPromise: Promise<void> | null = null;
  private running = false;
  private stopRequested = false;

  private readonly messageQueue: MessageQueueItem[] = [];
  private readonly rpcPending = new Map<string, RpcPending>();
  private rpcCounter = 1;
  private readonly recentTail: string[] = [];

  constructor(private readonly config: BotifyConfig, logger?: BridgeLogger) {
    this.logger = logger ?? console;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.stopRequested = false;
    ensureDirectory(this.config.codexHome);
    const codexEnv = {
      ...process.env,
      CODEX_HOME: this.config.codexHome,
    };

    this.logger.info(`Launching Codex process: ${this.config.codexCommand}`);

    const codexProcess = spawn(this.config.codexCommand, {
      shell: true,
      cwd: this.config.codexCwd,
      env: codexEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    codexProcess.on('error', (err) => {
      this.logger.error('Failed to launch Codex MCP server.', err);
      void this.notifyOwner(
        [
          'Codex bridge failed to launch the MCP server.',
          `Command: ${this.config.codexCommand}`,
          `Error: ${err.message || String(err)}`,
        ].join('\n'),
      );
    });

    codexProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      this.appendTail(text);
      this.logger.error(`[codex] ${text.trimEnd()}`);
    });

    codexProcess.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      const tail = this.recentTail.length ? this.recentTail.join('\n') : 'No buffered output.';
      const message = [
        `Codex MCP server exited (${reason}).`,
        'Recent output:',
        tail,
        'Restart the bridge once the underlying issue is resolved.',
      ].join('\n');
      this.logger.error(message);
      void this.notifyOwner(message);
      void this.stop();
    });

    const stdoutRl = readline.createInterface({ input: codexProcess.stdout });
    stdoutRl.on('line', (line: string) => {
      this.appendTail(line);
      this.handleCodexLine(line);
    });

    this.codexProcess = codexProcess;
    this.stdoutRl = stdoutRl;
    this.running = true;

    this.initPromise = this.initCodex().catch((err) => {
      this.logger.error('Codex initialization failed.', err);
      void this.notifyOwner(`Codex initialization failed:\n${err.message || String(err)}`);
      throw err;
    });

    this.pollLoopPromise = this.pollUpdates().catch((err) => {
      if (this.stopRequested) {
        return;
      }
      this.logger.error('Fatal Telegram polling error.', err);
    });

    await this.initPromise;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.stopRequested = true;

    if (this.missingConversationIdTimeout) {
      clearTimeout(this.missingConversationIdTimeout);
      this.missingConversationIdTimeout = null;
    }

    this.messageQueue.length = 0;

    if (this.stdoutRl) {
      this.stdoutRl.close();
      this.stdoutRl = null;
    }

    if (this.codexProcess) {
      try {
        this.codexProcess.kill('SIGTERM');
      } catch (err) {
        this.logger.warn('Failed to terminate Codex process gracefully.', err as Error);
      }
      this.codexProcess = null;
    }

    if (this.pollLoopPromise) {
      try {
        await this.pollLoopPromise;
      } catch (err) {
        this.logger.warn('Polling loop ended with error.', err as Error);
      }
      this.pollLoopPromise = null;
    }

    this.codexReady = false;
    this.currentConversationId = null;
    this.lastRolloutPath = null;
    this.processingQueue = false;
    this.warnedMissingConversationId = false;
    this.running = false;
  }

  private async initCodex(): Promise<void> {
    await this.sendRpc('initialize', {
      protocolVersion: '2024-10-07',
      clientInfo: { name: 'telegram-bridge', version: '0.1.0' },
      capabilities: {},
    });
    this.sendNotification('initialized', {});
    await this.sendRpc('tools/list', {});
    this.codexReady = true;
    this.logger.info('Codex MCP server is ready.');
    this.processQueue();
  }

  private handleCodexLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: CodexMessage;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      this.logger.warn(`Failed to parse Codex output as JSON: ${trimmed}`);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const idKey = message.id !== undefined ? String(message.id) : undefined;
      if (idKey && message.method && !this.rpcPending.has(idKey)) {
        this.handleCodexRequest(message);
        return;
      }

      if (!idKey) {
        this.logger.warn(`Codex response missing id: ${JSON.stringify(message)}`);
        return;
      }

      const pending = this.rpcPending.get(idKey);
      if (!pending) {
        this.logger.warn(`Received response for unknown RPC id: ${idKey}`);
        return;
      }
      this.rpcPending.delete(idKey);
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }

      if (message.error) {
        pending.reject(new Error(message.error.message || 'Codex returned an error.'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.handleCodexNotification(message);
    } else {
      this.logger.warn(`Unhandled Codex message: ${JSON.stringify(message)}`);
    }
  }

  private handleCodexNotification(message: CodexMessage): void {
    const { method, params } = message;
    this.maybeUpdateConversationId(params);
    if (method && method.startsWith('events/')) {
      this.appendTail(`${method}: ${JSON.stringify(params)}`);
      return;
    }
    this.logger.info(`Codex notification: ${method ?? 'unknown'} ${JSON.stringify(params)}`);
  }

  private handleCodexRequest(message: CodexMessage): void {
    const method = message.method ?? 'unknown';
    const warning = `Codex requested ${method}, but the Telegram bridge does not support interactive approvals.`;
    this.logger.warn(warning);
    if (message.id !== undefined) {
      this.sendResponse(message.id, {
        error: { code: -32601, message: `${warning} Configure CODEX_APPROVAL_POLICY=never to avoid approvals.` },
      });
    }
    void this.notifyOwner(warning);
  }

  private sendRpc(method: string, params: Record<string, unknown>): Promise<any> {
    const id = String(this.rpcCounter++);
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.writeCodex(payload);
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      if (this.config.rpcTimeoutMs > 0) {
        timeout = setTimeout(() => {
          this.rpcPending.delete(id);
          reject(new Error(`Codex RPC timeout (${method})`));
        }, this.config.rpcTimeoutMs);
      }
      this.rpcPending.set(id, { resolve, reject, timeout, method });
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeCodex(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  private sendResponse(id: number | string, payload: { result?: unknown; error?: { code?: number; message?: string } }): void {
    const message: Record<string, unknown> = { jsonrpc: '2.0', id };
    if (payload.result !== undefined) {
      message.result = payload.result;
    }
    if (payload.error) {
      message.error = payload.error;
    }
    this.writeCodex(JSON.stringify(message));
  }

  private writeCodex(text: string): void {
    if (!this.codexProcess || !this.codexProcess.stdin.writable) {
      throw new Error('Codex process is not ready to receive input.');
    }
    this.codexProcess.stdin.write(`${text}\n`);
  }

  private appendTail(text: string): void {
    const parts = text.split(/\r?\n/).filter(Boolean);
    for (const part of parts) {
      this.recentTail.push(part);
    }
    while (this.recentTail.length > this.config.exitLogLines) {
      this.recentTail.shift();
    }
  }

  private async pollUpdates(): Promise<void> {
    let offset = 0;
    while (!this.stopRequested) {
      try {
        const params = new URLSearchParams();
        params.set('timeout', String(this.config.pollingTimeout));
        if (offset) {
          params.set('offset', String(offset));
        }
        const response = await this.apiRequest(`getUpdates?${params.toString()}`);
        if (!response.ok) {
          this.logger.error(`Telegram getUpdates failed: ${JSON.stringify(response)}`);
          await delay(2000);
          continue;
        }
        const updates = response.result || [];
        for (const update of updates) {
          offset = update.update_id + 1;
          this.handleUpdate(update);
        }
      } catch (err) {
        if (this.stopRequested) {
          break;
        }
        this.logger.error(`Polling error: ${(err as Error).message}`);
        await delay(3000);
      }
    }
  }

  private handleUpdate(update: any): void {
    const message = update.message || update.edited_message;
    if (!message || typeof message.text !== 'string') {
      return;
    }
    if (String(message.chat.id) !== String(this.config.chatId)) {
      void this.apiRequest('sendMessage', {
        chat_id: message.chat.id,
        text: 'This bot is locked to a different chat.',
      });
      return;
    }

    const trimmed = message.text.trim();
    if (trimmed === '/help') {
      void this.sendText(
        [
          'Codex Telegram Bridge (MCP mode)',
          '',
          'Commands:',
          '/ping   – heartbeat',
          '/reset  – drop the active Codex session',
          '/status – show server status',
          '/help   – this message',
          '',
          'Any other message is forwarded to Codex via MCP.',
        ].join('\n'),
      );
      return;
    }

    if (trimmed === '/ping') {
      void this.sendText('pong');
      return;
    }

    if (trimmed === '/reset') {
      this.currentConversationId = null;
      this.lastRolloutPath = null;
      this.messageQueue.length = 0;
      this.processingQueue = false;
      if (this.missingConversationIdTimeout) {
        clearTimeout(this.missingConversationIdTimeout);
        this.missingConversationIdTimeout = null;
      }
      this.warnedMissingConversationId = false;
      void this.sendText('Conversation reset. Send a new prompt to start a fresh Codex session.');
      return;
    }

    if (trimmed === '/status') {
      void this.sendText(
        [
          `Codex ready: ${this.codexReady}`,
          `Queue length: ${this.messageQueue.length}`,
          `Active conversation: ${this.currentConversationId ?? 'none'}`,
          `Last rollout: ${this.lastRolloutPath ?? 'n/a'}`,
        ].join('\n'),
      );
      return;
    }

    this.messageQueue.push({
      text: message.text,
      metadata: { from: message.from?.username || message.from?.first_name || 'user' },
    });
    this.processQueue();
  }

  private processQueue(): void {
    if (this.processingQueue || !this.codexReady) {
      return;
    }
    const next = this.messageQueue.shift();
    if (!next) {
      return;
    }
    this.processingQueue = true;
    this.handlePrompt(next.text)
      .then((responseText) => this.sendText(responseText))
      .catch((err: Error) => {
        this.logger.error(`Codex prompt failed: ${err.message}`);
        const message = err.message || String(err);
        if (/^Codex RPC timeout/.test(message)) {
          void this.sendText(
            [
              'Codex timed out waiting for the MCP response.',
              'The task may still complete in the background.',
              'Increase CODEX_RPC_TIMEOUT_MS (set it to 0 to disable timeouts) or break the task into smaller steps.',
              'Use /status to check the active session.',
            ].join('\n'),
          );
        } else {
          void this.sendText(`Codex error: ${message}`);
          this.currentConversationId = null;
        }
      })
      .finally(() => {
        this.processingQueue = false;
        this.processQueue();
      });
  }

  private async handlePrompt(prompt: string): Promise<string> {
    const args: Record<string, unknown> = { prompt };
    if (this.config.sandboxMode) {
      args.sandbox = this.config.sandboxMode;
    }
    if (this.config.codexCwd) {
      args.cwd = this.config.codexCwd;
    }
    if (this.config.approvalPolicy) {
      args['approval-policy'] = this.config.approvalPolicy;
    }
    if (this.config.profile) {
      args.profile = this.config.profile;
    }
    if (this.config.model) {
      args.model = this.config.model;
    }
    if (typeof this.config.includePlanTool === 'boolean') {
      args['include-plan-tool'] = this.config.includePlanTool;
    }
    if (this.config.baseInstructions) {
      args['base-instructions'] = this.config.baseInstructions;
    }
    if (this.config.configOverrides) {
      args.config = this.config.configOverrides;
    }

    let result: any;
    if (!this.currentConversationId) {
      result = await this.sendRpc('tools/call', {
        name: 'codex',
        arguments: args,
      });
    } else {
      result = await this.sendRpc('tools/call', {
        name: 'codex-reply',
        arguments: {
          conversationId: this.currentConversationId,
          prompt,
        },
      });
    }

    if (result?.rolloutPath) {
      this.lastRolloutPath = result.rolloutPath;
    }

    const updatedFromResult = this.maybeUpdateConversationId(result);
    if (!updatedFromResult && !this.currentConversationId) {
      this.scheduleMissingConversationWarning();
    }

    const formatted = renderResult(result);

    if (result?.isError) {
      this.currentConversationId = null;
      throw new Error(formatted || 'Codex reported an internal error.');
    }

    return formatted || '(Codex returned no content.)';
  }

  private maybeUpdateConversationId(payload: unknown): boolean {
    const conversationId = extractConversationId(payload);
    if (!conversationId) {
      return false;
    }
    this.currentConversationId = conversationId;
    this.warnedMissingConversationId = false;
    if (this.missingConversationIdTimeout) {
      clearTimeout(this.missingConversationIdTimeout);
      this.missingConversationIdTimeout = null;
    }
    return true;
  }

  private scheduleMissingConversationWarning(): void {
    if (this.warnedMissingConversationId || this.missingConversationIdTimeout) {
      return;
    }
    this.missingConversationIdTimeout = setTimeout(() => {
      this.missingConversationIdTimeout = null;
      if (this.currentConversationId) {
        return;
      }
      const warning =
        '!!! WARNING: Codex did not return a conversation id. Follow-up prompts will start a fresh session unless you send /reset and restate your request.';
      void this.sendText(warning);
      this.logger.warn('Codex response did not include a conversation id; follow-up prompts will start new sessions.');
      this.warnedMissingConversationId = true;
    }, 300);
  }

  private async sendText(text: string): Promise<void> {
    const chunks = chunkMessage(text, this.config.outputChunk);
    for (const chunk of chunks) {
      const payload = {
        chat_id: this.config.chatId,
        text: `<pre>${escapeHtml(chunk)}</pre>`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      const response = await this.apiRequest('sendMessage', payload);
      if (!response.ok) {
        this.logger.error(`Failed to send Telegram message: ${JSON.stringify(response)}`);
      }
    }
  }

  private async notifyOwner(message: string): Promise<void> {
    try {
      await this.sendText(message);
    } catch (err) {
      this.logger.error(`Failed to notify owner: ${(err as Error).message}`);
    }
  }

  private apiRequest(method: string, payload?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const isGet = payload === undefined;
      const body = isGet ? null : JSON.stringify(payload);
      const options: https.RequestOptions = {
        hostname: 'api.telegram.org',
        method: isGet ? 'GET' : 'POST',
        path: `/bot${this.config.botToken}/${method}`,
        headers: isGet
          ? undefined
          : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body ?? ''),
            },
      };
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Failed to parse Telegram response: ${raw}`));
          }
        });
      });
      req.on('error', (err) => reject(err));
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}

function renderResult(result: any): string {
  if (!result) {
    return '';
  }
  const lines: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!item) {
        continue;
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        lines.push(item.text.trim());
        continue;
      }
      if (item.type === 'tool') {
        const parts: string[] = [];
        parts.push(`Tool ${item.toolName || 'unknown'}`);
        if (item.status) {
          parts.push(`status=${item.status}`);
        }
        if (item.output) {
          parts.push(`output:\n${item.output}`);
        }
        lines.push(parts.join(' ').trim());
        continue;
      }
      lines.push(JSON.stringify(item, null, 2));
    }
  }
  return lines.join('\n\n').trim();
}

function extractConversationId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const visited = new Set<unknown>();
  const queue: unknown[] = [payload];

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string') {
        const normalizedKey = key.toLowerCase();
        if (
          (normalizedKey.includes('conversation') && normalizedKey.includes('id')) ||
          (normalizedKey.includes('session') && normalizedKey.includes('id'))
        ) {
          const trimmed = value.trim();
          if (trimmed.length) {
            return trimmed;
          }
        }
        if (normalizedKey === 'id' && looksLikeConversationContainer(current)) {
          const trimmed = value.trim();
          if (trimmed.length) {
            return trimmed;
          }
        }
        continue;
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

function looksLikeConversationContainer(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const record = obj as Record<string, unknown>;
  if (typeof record.type === 'string') {
    const normalizedType = record.type.toLowerCase();
    if (normalizedType.includes('conversation') || normalizedType.includes('session')) {
      return true;
    }
  }
  return Object.keys(record).some((key) => {
    const normalizedKey = key.toLowerCase();
    return normalizedKey.includes('conversation') || normalizedKey.includes('session');
  });
}

function chunkMessage(text: string, size: number): string[] {
  const chunks: string[] = [];
  let remaining = text || '';
  while (remaining.length > size) {
    chunks.push(remaining.slice(0, size));
    remaining = remaining.slice(size);
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ensureDirectory(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Unable to create directory ${dir}: ${(err as Error).message}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
