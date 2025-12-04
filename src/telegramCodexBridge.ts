import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { BotifyConfig, BridgeLogger } from './types.js';
import { versionString } from './version.js';

interface MessageQueueItem {
  text: string;
  metadata: {
    from: string;
    chatId: string;
    chatType?: string;
    replyToMessageId?: number;
  };
}

interface ChatSession {
  chatId: string;
  conversationId: string | null;
  lastRolloutPath: string | null;
  messageQueue: MessageQueueItem[];
  processing: boolean;
  warnedMissingConversationId: boolean;
  missingConversationIdTimeout: NodeJS.Timeout | null;
  lastInteractionAt: Date | null;
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

interface AttachmentDescriptor {
  fileId: string;
  kind: 'document' | 'photo';
  suggestedName?: string;
}

interface DateFormatter {
  format: (value: Date) => string;
}

type CodexAuthState = 'unknown' | 'checking' | 'ok' | 'unauthorized' | 'error';
type CodexAuthSource =
  | 'startup-check'
  | 'startup-announce'
  | 'status-command'
  | 'cli-status'
  | 'runtime-event'
  | 'prompt-response';

interface CodexAuthStatus {
  state: CodexAuthState;
  lastCheckAt: Date | null;
  lastOkAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureDetail: string | null;
  lastFailureSource: CodexAuthSource | null;
  lastHttpStatusCode: number | null;
  lastMessage: string | null;
}

export class TelegramCodexBridge {
  private readonly logger: BridgeLogger;
  private codexProcess: ChildProcessWithoutNullStreams | null = null;
  private codexReady = false;
  private stdoutRl: readline.Interface | null = null;
  private pollLoopPromise: Promise<void> | null = null;
  private initPromise: Promise<void> | null = null;
  private running = false;
  private stopRequested = false;

  private readonly sessions = new Map<string, ChatSession>();
  private readonly sessionByConversationId = new Map<string, ChatSession>();
  private readonly rpcPending = new Map<string, RpcPending>();
  private rpcCounter = 1;
  private readonly recentTail: string[] = [];
  private readonly fatalListeners = new Set<(error: Error) => void>();
  private fatalEmitted = false;
  private startedAt: Date | null = null;
  private lastInteractionAt: Date | null = null;
  private readonly timeFormatter: DateFormatter;
  private readonly timeZoneLabel: string;
  private gitInfoWarningLogged = false;
  private botUsername: string | null = null;
  private codexAuthStatus: CodexAuthStatus = {
    state: 'unknown',
    lastCheckAt: null,
    lastOkAt: null,
    lastFailureAt: null,
    lastFailureDetail: null,
    lastFailureSource: null,
    lastHttpStatusCode: null,
    lastMessage: null,
  };
  private codexAuthCheckPromise: Promise<void> | null = null;

  constructor(private readonly config: BotifyConfig, logger?: BridgeLogger) {
    this.logger = logger ?? console;
    const { formatter, timeZone } = this.createTimeFormatter();
    this.timeFormatter = formatter;
    this.timeZoneLabel = timeZone;
  }

  onFatal(handler: (error: Error) => void): () => void {
    this.fatalListeners.add(handler);
    return () => this.fatalListeners.delete(handler);
  }

  private emitFatal(error: Error): void {
    if (this.fatalEmitted) {
      return;
    }
    this.fatalEmitted = true;
    for (const handler of this.fatalListeners) {
      try {
        handler(error);
      } catch (err) {
        this.logger.error(`Fatal handler threw: ${(err as Error).message}`);
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.stopRequested = false;
    this.fatalEmitted = false;
    this.startedAt = new Date();
    this.lastInteractionAt = null;
    ensureDirectory(this.config.codexHome);
    ensureDirectory(this.config.attachmentsDir);
    await this.loadBotIdentity();
    await this.verifyCodexLoginStatus('startup-check');
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
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Failed to launch Codex MCP server.', error);
      void this.notifyOwner(
        [
          'Codex bridge failed to launch the MCP server.',
          `Command: ${this.config.codexCommand}`,
          `Error: ${error.message}`,
        ].join('\n'),
      );
      this.emitFatal(error);
    });

    codexProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      this.appendTail(text);
      this.logger.error(`[codex] ${text.trimEnd()}`);
    });

    codexProcess.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      const tail = this.recentTail.length ? this.recentTail.join('\n') : 'No buffered output.';
      const diagnostic = [
        `Codex MCP server exited (${reason}).`,
        'Recent output:',
        tail,
        'Restart the bridge once the underlying issue is resolved.',
      ].join('\n');
      const abnormalExit = Boolean(signal) || (typeof code === 'number' && code !== 0);
      if (abnormalExit) {
        this.logger.error(diagnostic);
      } else {
        this.logger.info(`Codex MCP server exited cleanly (${reason}).`);
      }
      const exitQuip = signal
        ? `Codex MCP server yeeted itself after catching ${signal}. Please restart me once it's safe.`
        : code === 0
          ? 'Codex MCP server clocked out politely (code 0). Summon me again when you need more magic.'
          : `Codex MCP server dramatically face-planted with exit code ${code ?? 'unknown'}. Please restart when ready.`;
      void this.notifyOwner(exitQuip);
      if (!this.stopRequested) {
        this.emitFatal(new Error(diagnostic));
      }
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
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Codex initialization failed.', error);
      void this.notifyOwner(`Codex initialization failed:\n${error.message}`);
      this.emitFatal(error);
      throw error;
    });

    this.pollLoopPromise = this.pollUpdates().catch((err) => {
      if (this.stopRequested) {
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error('Fatal Telegram polling error.', error);
      this.emitFatal(error);
    });

    await this.initPromise;
    void this.announceStartup();
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (!this.running) {
      return;
    }
    this.stopRequested = true;

    if (this.stdoutRl) {
      this.stdoutRl.close();
      this.stdoutRl = null;
    }

    if (this.codexProcess) {
      try {
        this.codexProcess.kill(signal);
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
    this.resetAllSessions();
    this.startedAt = null;
    this.lastInteractionAt = null;
    this.running = false;
  }

  private async initCodex(): Promise<void> {
    await this.sendRpc('initialize', {
      protocolVersion: '2024-10-07',
      clientInfo: { name: 'telegram-bridge', version: versionString },
      capabilities: {},
    });
    this.sendNotification('initialized', {});
    await this.sendRpc('tools/list', {});
    this.codexReady = true;
    this.logger.info('Codex MCP server is ready.');
    this.processAllQueues();
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
    this.maybeUpdateConversationIdFromPayload(params);
    if (method === 'codex/event') {
      this.inspectCodexEventForAuthIssues(params);
    }
    if (method && method.startsWith('events/')) {
      this.appendTail(`${method}: ${JSON.stringify(params)}`);
      return;
    }
    this.logger.info(`Codex notification: ${method ?? 'unknown'} ${JSON.stringify(params)}`);
  }

  private inspectCodexEventForAuthIssues(payload: unknown): void {
    const httpStatus = extractHttpStatusCode(payload);
    if (httpStatus !== 401) {
      return;
    }
    const detail = describeCodexEvent(payload) || 'Codex signaled HTTP 401 Unauthorized.';
    const changed = this.recordCodexAuthFailure('unauthorized', detail, 'runtime-event', httpStatus);
    if (changed) {
      this.notifyCodexUnauthorized(detail);
    }
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
    if (!message) {
      return;
    }
    const chatId = String(message.chat.id);
    if (chatId !== String(this.config.chatId)) {
      void this.apiRequest('sendMessage', {
        chat_id: message.chat.id,
        text: 'This bot is locked to a different chat.',
      });
      return;
    }

    const session = this.getSession(chatId);
    const attachments = this.extractAttachmentDescriptors(message);
    if (attachments.length) {
      void this.handleFileAttachments(attachments, chatId).catch((err) => {
        this.logger.error(`Attachment processing error: ${err.message}`);
      });
    }

    const promptText =
      typeof message.text === 'string'
        ? message.text
        : typeof message.caption === 'string'
          ? message.caption
          : undefined;

    if (promptText === undefined) {
      return;
    }

    const trimmed = promptText.trim();
    const command = this.normalizeBotCommand(trimmed);

    if (command === '/help') {
      void this.sendText(
        [
          'Codex Telegram Bridge (MCP mode)',
          '',
          'Commands:',
          '/ping   – heartbeat',
          '/reset  – drop the active Codex session',
          '/status – show server status',
          '/relive – gracefully exit so a new build can start',
          '/help   – this message',
          '',
          'Any other message is forwarded to Codex via MCP.',
        ].join('\n'),
        { chatId, replyToMessageId: message.message_id },
      );
      return;
    }

    if (command === '/ping') {
      void this.sendText('pong', { chatId, replyToMessageId: message.message_id });
      return;
    }

    if (command === '/reset') {
      this.resetSession(session);
      void this.sendText(
        'Conversation reset. Send a new prompt to start a fresh Codex session.',
        { chatId, replyToMessageId: message.message_id },
      );
      return;
    }

    if (command === '/status') {
      void this.handleStatusCommand(chatId, message.message_id);
      return;
    }

    if (command === '/relive') {
      this.handleReliveCommand(chatId);
      return;
    }

    const sanitized = this.normalizePromptInput(promptText);
    if (!sanitized.length) {
      return;
    }

    session.messageQueue.push({
      text: sanitized,
      metadata: {
        from: message.from?.username || message.from?.first_name || 'user',
        chatId,
        chatType: message.chat?.type,
        replyToMessageId: message.message_id,
      },
    });
    this.processQueue(session);
  }

  private normalizeBotCommand(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
      return null;
    }
    const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(@\S+)?$/);
    if (!match) {
      return null;
    }
    const mention = match[2];
    if (mention && !this.isMentionForBot(mention)) {
      return null;
    }
    return `/${match[1]}`;
  }

  private normalizePromptInput(text: string): string {
    let normalized = text.trim();
    if (this.botUsername) {
      const mentionPattern = new RegExp(`^@${escapeRegExp(this.botUsername)}\\b`, 'i');
      normalized = normalized.replace(mentionPattern, '').trimStart();
    }
    normalized = normalized.replace(/^botify[\s,:-]+/i, '').trimStart();
    return normalized;
  }

  private isMentionForBot(mention: string | undefined): boolean {
    if (!mention) {
      return true;
    }
    if (!this.botUsername) {
      return true;
    }
    return mention.trim().toLowerCase() === `@${this.botUsername.toLowerCase()}`;
  }

  private processQueue(session: ChatSession): void {
    if (session.processing || !this.codexReady) {
      return;
    }
    const next = session.messageQueue.shift();
    if (!next) {
      return;
    }
    session.processing = true;
    const promptWithSender = this.applySenderContext(next);
    this.handlePrompt(session, promptWithSender)
      .then((responseText) =>
        this.sendText(responseText, {
          chatId: next.metadata.chatId,
          replyToMessageId: next.metadata.replyToMessageId,
        }),
      )
      .catch((err: Error) => {
        this.logger.error(`Codex prompt failed: ${err.message}`);
        const message = err.message || String(err);
        const sendOptions = {
          chatId: next.metadata.chatId,
          replyToMessageId: next.metadata.replyToMessageId,
        };
        if (/^Codex RPC timeout/.test(message)) {
          void this.sendText(
            [
              'Codex timed out waiting for the MCP response.',
              'The task may still complete in the background.',
              'Increase CODEX_RPC_TIMEOUT_MS (set it to 0 to disable timeouts) or break the task into smaller steps.',
              'Use /status to check the active session.',
            ].join('\n'),
            sendOptions,
          );
        } else {
          void this.sendText(`Codex error: ${message}`, sendOptions);
          if (looksUnauthorizedMessage(message)) {
            const changed = this.recordCodexAuthFailure('unauthorized', message, 'prompt-response', 401);
            if (changed) {
              this.notifyCodexUnauthorized(message);
            }
          }
          this.setConversationId(session, null);
        }
      })
      .finally(() => {
        session.processing = false;
        this.processQueue(session);
      });
  }

  private processAllQueues(): void {
    for (const session of this.sessions.values()) {
      this.processQueue(session);
    }
  }

  private applySenderContext(next: MessageQueueItem): string {
    const chatType = next.metadata.chatType?.trim().toLowerCase();
    const sender = next.metadata.from?.trim();
    if (!sender) {
      return next.text;
    }
    const isGroupChat = chatType === 'group' || chatType === 'supergroup';
    if (!isGroupChat) {
      return next.text;
    }
    const isHandleLike = /^[a-z0-9_][a-z0-9_.-]*$/i.test(sender);
    const prefix = isHandleLike ? `@${sender}: ` : `(from ${sender}) `;
    return `${prefix}${next.text}`;
  }

  private async handlePrompt(session: ChatSession, prompt: string): Promise<string> {
    this.markInteraction();
    session.lastInteractionAt = new Date();
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
    if (!session.conversationId) {
      result = await this.sendRpc('tools/call', {
        name: 'codex',
        arguments: args,
      });
    } else {
      result = await this.sendRpc('tools/call', {
        name: 'codex-reply',
        arguments: {
          conversationId: session.conversationId,
          prompt,
        },
      });
    }

    if (result?.rolloutPath) {
      session.lastRolloutPath = result.rolloutPath;
    }
    if (typeof result?.conversationId === 'string' && result.conversationId.trim().length) {
      this.setConversationId(session, result.conversationId.trim());
    }

    const updatedFromResult = this.maybeUpdateConversationIdForSession(session, result);
    if (!updatedFromResult && !session.conversationId) {
      this.scheduleMissingConversationWarning(session);
    }

    const formatted = renderResult(result);

    if (result?.isError) {
      this.setConversationId(session, null);
      throw new Error(formatted || 'Codex reported an internal error.');
    }

    this.recordCodexAuthSuccess('prompt-response', 'Codex responded to Telegram prompt.');
    return formatted || '(Codex returned no content.)';
  }

  private getSession(chatId: string): ChatSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        chatId,
        conversationId: null,
        lastRolloutPath: null,
        messageQueue: [],
        processing: false,
        warnedMissingConversationId: false,
        missingConversationIdTimeout: null,
        lastInteractionAt: null,
      };
      this.sessions.set(chatId, session);
    }
    return session;
  }

  private resetSession(session: ChatSession): void {
    session.messageQueue.length = 0;
    session.processing = false;
    session.lastRolloutPath = null;
    session.warnedMissingConversationId = false;
    this.setConversationId(session, null);
    this.clearSessionTimeout(session);
    session.lastInteractionAt = null;
  }

  private resetAllSessions(): void {
    for (const session of this.sessions.values()) {
      this.clearSessionTimeout(session);
      if (session.conversationId) {
        this.sessionByConversationId.delete(session.conversationId);
      }
    }
    this.sessions.clear();
    this.sessionByConversationId.clear();
  }

  private clearSessionTimeout(session: ChatSession): void {
    if (session.missingConversationIdTimeout) {
      clearTimeout(session.missingConversationIdTimeout);
      session.missingConversationIdTimeout = null;
    }
  }

  private setConversationId(session: ChatSession, conversationId: string | null): void {
    if (session.conversationId) {
      this.sessionByConversationId.delete(session.conversationId);
    }
    session.conversationId = conversationId;
    if (conversationId) {
      this.sessionByConversationId.set(conversationId, session);
      session.warnedMissingConversationId = false;
      this.clearSessionTimeout(session);
    }
  }

  private maybeUpdateConversationIdForSession(session: ChatSession, payload: unknown): boolean {
    const conversationId = extractConversationId(payload);
    if (!conversationId) {
      return false;
    }
    this.setConversationId(session, conversationId);
    return true;
  }

  private maybeUpdateConversationIdFromPayload(payload: unknown): boolean {
    const conversationId = extractConversationId(payload);
    if (!conversationId) {
      return false;
    }
    const session =
      this.sessionByConversationId.get(conversationId) || this.findMostRecentSessionWithoutConversationId();
    if (!session) {
      return false;
    }
    this.setConversationId(session, conversationId);
    return true;
  }

  private findMostRecentSessionWithoutConversationId(): ChatSession | null {
    let candidate: ChatSession | null = null;
    for (const session of this.sessions.values()) {
      if (session.conversationId) {
        continue;
      }
      if (!candidate) {
        candidate = session;
        continue;
      }
      const candidateTime = candidate.lastInteractionAt?.getTime() ?? 0;
      const sessionTime = session.lastInteractionAt?.getTime() ?? 0;
      if (sessionTime > candidateTime) {
        candidate = session;
      }
    }
    return candidate;
  }

  private scheduleMissingConversationWarning(session: ChatSession): void {
    if (session.warnedMissingConversationId || session.missingConversationIdTimeout) {
      return;
    }
    session.missingConversationIdTimeout = setTimeout(() => {
      session.missingConversationIdTimeout = null;
      if (session.conversationId) {
        return;
      }
      const warning =
        '!!! WARNING: Codex did not return a conversation id. Follow-up prompts will start a fresh session unless you send /reset and restate your request.';
      void this.sendText(warning, { chatId: session.chatId });
      this.logger.warn('Codex response did not include a conversation id; follow-up prompts will start new sessions.');
      session.warnedMissingConversationId = true;
    }, 300);
  }

  private markInteraction(): void {
    this.lastInteractionAt = new Date();
  }

  private formatTimestamp(value: Date | null): string {
    if (!value) {
      return 'n/a';
    }
    try {
      return `${this.timeFormatter.format(value)} (${this.timeZoneLabel})`;
    } catch (err) {
      this.logger.warn(`Failed to format timestamp: ${(err as Error).message}`);
      return value.toISOString();
    }
  }

  private formatRelativeDuration(value: Date | null): string {
    if (!value) {
      return 'n/a';
    }
    const diffMs = Date.now() - value.getTime();
    if (diffMs === 0) {
      return 'just now';
    }
    const past = diffMs > 0;
    const absMs = Math.abs(diffMs);
    const units = [
      { label: 'year', ms: 31_536_000_000 },
      { label: 'month', ms: 2_592_000_000 },
      { label: 'day', ms: 86_400_000 },
      { label: 'hour', ms: 3_600_000 },
      { label: 'minute', ms: 60_000 },
      { label: 'second', ms: 1_000 },
    ];
    const parts: string[] = [];
    let remainder = absMs;
    for (const unit of units) {
      const amount = Math.floor(remainder / unit.ms);
      if (amount > 0) {
        const label = `${unit.label}${amount === 1 ? '' : 's'}`;
        parts.push(`${amount} ${label}`);
        remainder -= amount * unit.ms;
      }
      if (parts.length === 2) {
        break;
      }
    }
    if (!parts.length) {
      return past ? 'just now' : 'any moment now';
    }
    const joined = parts.length === 1 ? parts[0] : `${parts[0]} and ${parts[1]}`;
    return past ? `${joined} ago` : `in ${joined}`;
  }

  private createTimeFormatter(): { formatter: DateFormatter; timeZone: string } {
    const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        hour12: false,
        timeZone: systemZone,
        timeZoneName: 'short',
      });
      const resolved = formatter.resolvedOptions().timeZone || systemZone;
      return { formatter, timeZone: resolved };
    } catch (err) {
      const fallbackFormatter: DateFormatter = {
        format: (value: Date) => value.toISOString(),
      };
      return { formatter: fallbackFormatter, timeZone: 'UTC' };
    }
  }

  async getStatusReport(options?: { chatId?: string; refreshAuth?: boolean; source?: CodexAuthSource }): Promise<string> {
    const chatId = options?.chatId ?? String(this.config.chatId);
    if (options?.refreshAuth) {
      const source = options.source ?? 'cli-status';
      await this.verifyCodexLoginStatus(source);
    }
    const session = this.sessions.get(chatId) ?? null;
    return this.buildStatusLines(session).join('\n');
  }

  private buildStatusLines(session: ChatSession | null): string[] {
    const lines = [
      `Codex ready: ${this.codexReady}`,
      `Codex auth: ${this.describeCodexAuthSummary()}`,
    ];
    const authDetail = this.describeCodexAuthDetail();
    if (authDetail) {
      lines.push(`Auth detail: ${authDetail}`);
    }
    lines.push(
      `Queue length: ${session?.messageQueue.length ?? 0}`,
      `Active conversation: ${session?.conversationId ?? 'none'}`,
      `Last rollout: ${session?.lastRolloutPath ?? 'n/a'}`,
      `Working dir: ${this.config.codexCwd}`,
      `Server time zone: ${this.timeZoneLabel}`,
      `Started: ${this.formatRelativeDuration(this.startedAt)}`,
      `Last interaction: ${this.formatTimestamp(this.lastInteractionAt)}`,
      `Repo branch: ${this.getRepositoryBranch()}`,
      `Last commit: ${this.getRepositoryHead()}`,
      `Git status: ${this.getGitStatusSummary()}`,
      `Diff vs master: ${this.getGitDiffSummary()}`,
      `Botify version: ${versionString}`,
      `Model: ${this.config.model ?? 'default'}`,
      `Sandbox: ${this.config.sandboxMode ?? 'n/a'}`,
    );
    return lines;
  }

  private describeCodexAuthSummary(): string {
    const state = this.codexAuthStatus.state;
    const stateLabel = state.charAt(0).toUpperCase() + state.slice(1);
    const qualifiers: string[] = [];
    if (this.codexAuthStatus.lastCheckAt) {
      qualifiers.push(`checked ${this.formatRelativeDuration(this.codexAuthStatus.lastCheckAt)}`);
    }
    if (state === 'ok' && this.codexAuthStatus.lastOkAt) {
      qualifiers.push(`last ok ${this.formatRelativeDuration(this.codexAuthStatus.lastOkAt)}`);
    }
    if ((state === 'unauthorized' || state === 'error') && this.codexAuthStatus.lastFailureAt) {
      qualifiers.push(`last failure ${this.formatRelativeDuration(this.codexAuthStatus.lastFailureAt)}`);
    }
    return qualifiers.length ? `${stateLabel} (${qualifiers.join(', ')})` : stateLabel;
  }

  private describeCodexAuthDetail(): string | null {
    if (this.codexAuthStatus.state === 'ok' || this.codexAuthStatus.state === 'unknown') {
      return null;
    }
    const detail = this.codexAuthStatus.lastFailureDetail || this.codexAuthStatus.lastMessage;
    if (!detail) {
      return null;
    }
    const parts: string[] = [];
    if (this.codexAuthStatus.lastHttpStatusCode) {
      parts.push(`HTTP ${this.codexAuthStatus.lastHttpStatusCode}`);
    }
    if (this.codexAuthStatus.lastFailureSource) {
      parts.push(this.codexAuthStatus.lastFailureSource);
    }
    parts.push(detail);
    return parts.join(' – ');
  }

  private async verifyCodexLoginStatus(source: CodexAuthSource): Promise<void> {
    if (this.codexAuthCheckPromise) {
      await this.codexAuthCheckPromise;
      return;
    }
    this.codexAuthStatus.state = 'checking';
    this.codexAuthStatus.lastCheckAt = new Date();
    this.codexAuthStatus.lastMessage = `Checking Codex auth via ${source}`;
    const promise = this.runCodexLoginStatusCommand()
      .then((result) => this.handleCodexLoginStatusResult(result, source))
      .catch((err) => {
        const message = (err as Error).message || 'Codex login status failed';
        this.logger.warn(`Codex login status command failed: ${message}`);
        this.recordCodexAuthFailure('error', message, source, null);
      })
      .finally(() => {
        this.codexAuthCheckPromise = null;
      });
    this.codexAuthCheckPromise = promise;
    await promise;
  }

  private async handleCodexLoginStatusResult(
    result: { code: number | null; stdout: string; stderr: string },
    source: CodexAuthSource,
  ): Promise<void> {
    const stdout = result.stdout?.trim() ?? '';
    const stderr = result.stderr?.trim() ?? '';
    const detail = [stdout, stderr].filter(Boolean).join(' | ');
    if (result.code === 0) {
      this.recordCodexAuthSuccess(source, detail || 'Codex login status OK');
      return;
    }
    const combined = detail || `exit code ${result.code ?? 'unknown'}`;
    const httpStatus = detectHttpStatusFromText(combined);
    if (httpStatus === 401 || /401/.test(combined) || /unauthorized/i.test(combined)) {
      const changed = this.recordCodexAuthFailure('unauthorized', combined, source, httpStatus ?? 401);
      if (changed) {
        this.notifyCodexUnauthorized(`Codex login status failed: ${combined}`);
      }
      return;
    }
    this.recordCodexAuthFailure('error', combined, source, httpStatus);
  }

  private runCodexLoginStatusCommand(): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const binary = this.resolveCodexBinary();
      const codexEnv = {
        ...process.env,
        CODEX_HOME: this.config.codexHome,
      };
      const child = spawn(binary, ['login', 'status'], {
        cwd: this.config.codexCwd,
        env: codexEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });
  }

  private recordCodexAuthSuccess(source: CodexAuthSource, detail: string): void {
    const now = new Date();
    this.codexAuthStatus.state = 'ok';
    this.codexAuthStatus.lastOkAt = now;
    this.codexAuthStatus.lastMessage = detail;
    this.codexAuthStatus.lastFailureDetail = null;
    this.codexAuthStatus.lastFailureAt = null;
    this.codexAuthStatus.lastFailureSource = null;
    this.codexAuthStatus.lastHttpStatusCode = null;
  }

  private recordCodexAuthFailure(
    state: Extract<CodexAuthState, 'unauthorized' | 'error'>,
    detail: string,
    source: CodexAuthSource,
    httpStatus: number | null,
  ): boolean {
    const previousState = this.codexAuthStatus.state;
    this.codexAuthStatus.state = state;
    this.codexAuthStatus.lastFailureAt = new Date();
    this.codexAuthStatus.lastFailureDetail = detail;
    this.codexAuthStatus.lastFailureSource = source;
    this.codexAuthStatus.lastMessage = detail;
    this.codexAuthStatus.lastHttpStatusCode = httpStatus;
    return previousState !== state;
  }

  private notifyCodexUnauthorized(detail: string): void {
    const trimmed = detail.trim();
    if (!trimmed) {
      return;
    }
    const message = [
      '⚠️ Codex authentication failed (HTTP 401).',
      trimmed,
      'Run `codex login` inside the Codex working directory and restart Botify.',
    ].join('\n');
    void this.notifyOwner(message);
  }

  private resolveCodexBinary(): string {
    const command = this.config.codexCommand?.trim();
    if (!command) {
      return 'codex';
    }
    const tokens = tokenizeCommand(command);
    if (!tokens.length) {
      return 'codex';
    }
    for (const token of tokens) {
      const base = path.basename(token);
      if (base === 'codex' || base.startsWith('codex')) {
        return token;
      }
    }
    return tokens[0];
  }

  private getRepositoryBranch(): string {
    const root = this.config.codexCwd || process.cwd();
    try {
      const output = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
      if (output) {
        return output;
      }
    } catch (err) {
      this.logGitWarning(`Failed to read git branch via git: ${(err as Error).message}`);
    }
    const gitDir = this.getGitDirectory(root);
    if (!gitDir) {
      return 'unknown';
    }
    try {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref:')) {
        const ref = head.slice(5).trim();
        const parts = ref.split('/');
        return parts[parts.length - 1] || ref;
      }
      return head ? '(detached HEAD)' : 'unknown';
    } catch (err) {
      this.logGitWarning(`Failed to parse .git/HEAD: ${(err as Error).message}`);
      return 'unknown';
    }
  }

  private getRepositoryHead(): string {
    const root = this.config.codexCwd || process.cwd();
    try {
      const output = execSync('git log -1 --pretty=format:%h%x20%s%x20', {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
      if (output) {
        return output;
      }
    } catch (err) {
      this.logGitWarning(`Failed to read git head via git: ${(err as Error).message}`);
    }
    const gitDir = this.getGitDirectory(root);
    if (!gitDir) {
      return 'unknown';
    }
    try {
      const headContent = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      if (headContent.startsWith('ref:')) {
        const ref = headContent.slice(5).trim();
        const refPath = path.join(gitDir, ref);
        const hash = fs.readFileSync(refPath, 'utf8').trim();
        return hash ? `${hash.slice(0, 7)} (message unavailable)` : 'unknown';
      }
      return headContent ? `${headContent.slice(0, 7)} (detached)` : 'unknown';
    } catch (err) {
      this.logGitWarning(`Failed to resolve git head: ${(err as Error).message}`);
      return 'unknown';
    }
  }

  private getGitStatusSummary(): string {
    const root = this.config.codexCwd || process.cwd();
    try {
      const output = execSync('git status -sb --untracked-files=normal', {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      })
        .split('\n')[0]
        .trim();
      return output || 'clean';
    } catch (err) {
      this.logGitWarning(`Failed to read git status: ${(err as Error).message}`);
      return 'unknown';
    }
  }

  private getGitDiffSummary(): string {
    const root = this.config.codexCwd || process.cwd();
    try {
      const output = execSync('git diff --name-only master...HEAD', {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
      if (!output.length) {
        return 'in sync';
      }
      const files = output.split('\n').filter(Boolean);
      const count = files.length;
      return `${count} file${count === 1 ? '' : 's'} differ`;
    } catch (err) {
      this.logGitWarning(`Failed to compare with master: ${(err as Error).message}`);
      return 'comparison unavailable';
    }
  }

  private getGitDirectory(root: string): string | null {
    const dotGitPath = path.join(root, '.git');
    try {
      const stats = fs.statSync(dotGitPath);
      if (stats.isDirectory()) {
        return dotGitPath;
      }
      if (stats.isFile()) {
        const content = fs.readFileSync(dotGitPath, 'utf8');
        const match = content.trim().match(/^gitdir:\s*(.+)$/i);
        if (match) {
          return path.resolve(root, match[1]);
        }
      }
    } catch (err) {
      this.logGitWarning(`Failed to locate .git directory: ${(err as Error).message}`);
    }
    return null;
  }

  private logGitWarning(message: string): void {
    if (this.gitInfoWarningLogged) {
      return;
    }
    this.gitInfoWarningLogged = true;
    this.logger.warn(message);
  }

  private async loadBotIdentity(): Promise<void> {
    if (this.botUsername) {
      return;
    }
    try {
      const response = await this.apiRequest('getMe');
      if (response?.ok && typeof response.result?.username === 'string') {
        this.botUsername = response.result.username;
        this.logger.info(`Telegram bot username detected: @${this.botUsername}`);
      } else {
        this.logger.warn('Telegram getMe did not return a username; mentions will not be stripped automatically.');
      }
    } catch (err) {
      this.logger.warn(`Failed to fetch Telegram bot identity: ${(err as Error).message}`);
    }
  }

  private async announceStartup(): Promise<void> {
    try {
      const report = await this.getStatusReport({ refreshAuth: true, source: 'startup-announce' });
      const message = [`Botify ${versionString} is online and ready.`, '', report].join('\n');
      await this.sendText(message);
    } catch (err) {
      this.logger.warn(`Failed to send startup announcement: ${(err as Error).message}`);
    }
  }

  private handleReliveCommand(chatId: string): void {
    this.logger.warn('Received /relive command; preparing to exit.');
    const message = `I'll be back! Botify ${versionString} is shutting down so a newer build can come online in a few minutes.`;
    const finishShutdown = () => {
      void this.stop('SIGTERM')
        .catch((err) => {
          this.logger.warn('Relive shutdown encountered an error.', err as Error);
        })
        .finally(() => {
          process.exit(0);
        });
    };
    void this.sendText(message, { chatId })
      .catch((err) => {
        this.logger.warn(`Failed to send /relive notice: ${(err as Error).message}`);
      })
      .finally(() => finishShutdown());
  }

  private async handleStatusCommand(chatId: string, replyToMessageId?: number): Promise<void> {
    try {
      const report = await this.getStatusReport({ chatId, refreshAuth: true, source: 'status-command' });
      await this.sendText(report, {
        chatId,
        replyToMessageId,
        renderMode: 'pre',
      });
    } catch (err) {
      const message = (err as Error).message || 'Unknown status error';
      this.logger.error(`Failed to render /status: ${message}`);
      await this.sendText(`Failed to render status: ${message}`, {
        chatId,
        replyToMessageId,
      });
    }
  }

  private extractAttachmentDescriptors(message: any): AttachmentDescriptor[] {
    const attachments: AttachmentDescriptor[] = [];
    const document = message.document;
    if (document && typeof document.file_id === 'string') {
      attachments.push({
        fileId: document.file_id,
        kind: 'document',
        suggestedName: typeof document.file_name === 'string' ? document.file_name : undefined,
      });
    }
    if (Array.isArray(message.photo) && message.photo.length) {
      const photo = message.photo[message.photo.length - 1];
      if (photo && typeof photo.file_id === 'string') {
        attachments.push({
          fileId: photo.file_id,
          kind: 'photo',
          suggestedName:
            typeof photo.file_unique_id === 'string' ? `photo-${photo.file_unique_id}` : undefined,
        });
      }
    }
    return attachments;
  }

  private async handleFileAttachments(descriptors: AttachmentDescriptor[], chatId: string): Promise<void> {
    if (!descriptors.length) {
      return;
    }
    const savedPaths: string[] = [];
    const failures: string[] = [];

    for (const descriptor of descriptors) {
      try {
        const stored = await this.storeAttachment(descriptor);
        savedPaths.push(stored);
      } catch (err) {
        const message = (err as Error).message;
        failures.push(`${descriptor.kind}: ${message}`);
        this.logger.error(`Attachment storage failed (${descriptor.kind}): ${message}`);
      }
    }

    if (savedPaths.length) {
      const displayPaths = savedPaths.map((absolutePath) => {
        const relative = path.relative(this.config.codexCwd, absolutePath);
        if (relative && !relative.startsWith('..')) {
          return relative;
        }
        return absolutePath;
      });
      await this.sendText(['Saved attachment(s):', ...displayPaths.map((p) => `- ${p}`)].join('\n'), {
        chatId,
      });
    }

    if (failures.length) {
      await this.sendText(
        ['Failed to save attachment(s):', ...failures.map((line) => `- ${line}`)].join('\n'),
        { chatId },
      );
    }
  }

  private async storeAttachment(descriptor: AttachmentDescriptor): Promise<string> {
    const response = await this.apiRequest('getFile', { file_id: descriptor.fileId });
    if (!response.ok || !response.result?.file_path) {
      throw new Error('Telegram getFile returned no file_path.');
    }
    const remotePath = response.result.file_path as string;
    const destination = this.resolveAttachmentDestination(remotePath, descriptor);
    await this.downloadTelegramFile(remotePath, destination);
    return destination;
  }

  private resolveAttachmentDestination(remotePath: string, descriptor: AttachmentDescriptor): string {
    const remoteName = path.basename(remotePath);
    const fallbackName = descriptor.suggestedName || remoteName || `${descriptor.kind}-${Date.now()}`;
    const { baseName, extension } = buildAttachmentNameParts(fallbackName, remoteName, descriptor.kind);
    const dir = this.config.attachmentsDir;
    ensureDirectory(dir);
    let attempt = `${baseName}${extension}`;
    let counter = 1;
    while (fs.existsSync(path.join(dir, attempt))) {
      attempt = `${baseName}-${counter}${extension}`;
      counter += 1;
    }
    return path.join(dir, attempt);
  }

  private downloadTelegramFile(remotePath: string, destination: string): Promise<void> {
    ensureDirectory(path.dirname(destination));
    return new Promise((resolve, reject) => {
      const request = https.get(
        {
          hostname: 'api.telegram.org',
          method: 'GET',
          path: `/file/bot${this.config.botToken}/${remotePath}`,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Telegram file download failed with status ${res.statusCode}`));
            return;
          }
          const fileStream = fs.createWriteStream(destination);
          res.pipe(fileStream);
          fileStream.on('finish', () =>
            fileStream.close((err) => {
              if (err) {
                reject(err);
                return;
              }
              resolve();
            }),
          );
          fileStream.on('error', (err) => reject(err));
        },
      );
      request.on('error', (err) => reject(err));
    });
  }

  private async sendText(
    text: string,
    options?: { chatId?: string; replyToMessageId?: number; renderMode?: 'auto' | 'pre' },
  ): Promise<void> {
    const targetChat = options?.chatId ?? this.config.chatId;
    const chunks = chunkMessage(text, this.config.outputChunk);
    for (const chunk of chunks) {
      const formatted = options?.renderMode === 'pre'
        ? `<pre>${escapeHtml(chunk)}</pre>`
        : formatTelegramHtml(chunk);
      const payload: Record<string, unknown> = {
        chat_id: targetChat,
        text: formatted,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      if (options?.replyToMessageId) {
        payload.reply_to_message_id = options.replyToMessageId;
        payload.allow_sending_without_reply = true;
      }
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

function extractHttpStatusCode(payload: unknown): number | null {
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
      if (typeof value === 'number') {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey.includes('http') && normalizedKey.includes('status')) {
          return value;
        }
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }
  return null;
}

function describeCodexEvent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, any>;
  const msg = record.msg;
  const parts: string[] = [];
  if (msg && typeof msg === 'object') {
    if (typeof msg.type === 'string') {
      parts.push(`type=${msg.type}`);
    }
    if (typeof msg.message === 'string') {
      parts.push(msg.message);
    }
  }
  const meta = record._meta;
  if (meta && typeof meta === 'object' && typeof meta.requestId === 'string') {
    parts.push(`request ${meta.requestId}`);
  } else if (typeof record.id === 'string') {
    parts.push(`request ${record.id}`);
  }
  return parts.length ? parts.join(' | ') : null;
}

function detectHttpStatusFromText(text: string): number | null {
  if (!text) {
    return null;
  }
  const match = text.match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function looksUnauthorizedMessage(message: string): boolean {
  if (!message) {
    return false;
  }
  return /401/.test(message) || /unauthorized/i.test(message);
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escapeNext = false;
  for (const char of command) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escapeNext = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length) {
    tokens.push(current);
  }
  return tokens;
}

function chunkMessage(text: string, size: number): string[] {
  const chunks: string[] = [];
  let remaining = text || '';
  while (remaining.length > size) {
    let splitIndex = remaining.lastIndexOf('\n', size);
    if (splitIndex <= 0) {
      splitIndex = size;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}

function formatTelegramHtml(text: string): string {
  if (!text) {
    return '&nbsp;';
  }
  const segments: string[] = [];
  const codeFence = /```([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = codeFence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      const formattedPlain = formatInlineMarkdown(plain);
      if (formattedPlain.trim().length) {
        segments.push(formattedPlain);
      }
    }
    const codeBlock = normalizeCodeBlock(match[1]);
    if (codeBlock.length) {
      segments.push(`<pre>${escapeHtml(codeBlock)}</pre>`);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remainder = formatInlineMarkdown(text.slice(lastIndex));
    if (remainder.trim().length) {
      segments.push(remainder);
    }
  }
  if (!segments.length) {
    return escapeHtml(text);
  }
  return segments.join('\n');
}

function formatInlineMarkdown(text: string): string {
  if (!text) {
    return '';
  }
  const inlineCode = /`([^`]+)`/g;
  let lastIndex = 0;
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = inlineCode.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      parts.push(applyBasicFormatting(escapeHtml(plain)));
    }
    parts.push(`<code>${escapeHtml(match[1])}</code>`);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);
    parts.push(applyBasicFormatting(escapeHtml(tail)));
  }
  return parts.join('');
}

function applyBasicFormatting(text: string): string {
  if (!text) {
    return '';
  }
  return text
    .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([\s\S]+?)__/g, '<u>$1</u>')
    .replace(/(?<!\*)\*([^\*][\s\S]*?)\*(?!\*)/g, '<i>$1</i>')
    .replace(/(?<!_)_([^_][\s\S]*?)_(?!_)/g, '<i>$1</i>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

function normalizeCodeBlock(raw: string): string {
  if (!raw) {
    return '';
  }
  let normalized = raw.replace(/\r\n?/g, '\n');
  if (normalized.startsWith('\n')) {
    normalized = normalized.slice(1);
  }
  const firstLineBreak = normalized.indexOf('\n');
  if (firstLineBreak !== -1) {
    const maybeLang = normalized.slice(0, firstLineBreak).trim();
    if (/^[\w.-]+$/.test(maybeLang)) {
      normalized = normalized.slice(firstLineBreak + 1);
    }
  }
  return normalized.replace(/\n+$/, '');
}

function buildAttachmentNameParts(
  candidate: string,
  remoteName: string,
  kind: 'document' | 'photo',
): { baseName: string; extension: string } {
  const sanitizedCandidate = sanitizeFileComponent(candidate);
  const sanitizedRemote = sanitizeFileComponent(remoteName);
  const parsedCandidate = path.parse(sanitizedCandidate);
  const parsedRemote = path.parse(sanitizedRemote);
  let baseName = parsedCandidate.name || sanitizedCandidate || parsedRemote.name || kind;
  let extension = parsedCandidate.ext || parsedRemote.ext;
  if (!extension && kind === 'photo') {
    extension = '.jpg';
  }
  baseName = baseName || 'file';
  return { baseName, extension: extension || '' };
}

function sanitizeFileComponent(value: string): string {
  if (!value) {
    return '';
  }
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
