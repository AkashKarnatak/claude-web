// Wraps the Claude Agent SDK query() — lifecycle, streaming input,
// interrupt, resume — and maps engine events to the wire protocol
// (ARCHITECTURE.md §4, §5). All engine-schema knowledge lives here.

import { randomUUID } from 'node:crypto';
import {
  query,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { PermissionBroker, type PendingPermission } from './permissions.js';
import type { PromptImage, ServerMsg } from './protocol.js';

export interface AgentSessionOptions {
  conversationId: string;
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  resume?: string;
  /** Launch with allowDangerouslySkipPermissions so bypassPermissions works. */
  allowBypass?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  onMessage: (msg: ServerMsg) => void;
  onSessionId: (sessionId: string) => void;
}

/** Async queue used as the streaming-input prompt for a multi-turn session. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  end(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

const BUFFERED: ReadonlySet<ServerMsg['t']> = new Set([
  'user_prompt',
  'assistant_end',
  'tool_use',
  'tool_result',
  'result',
  'error',
] as const);

export class AgentSession {
  /** Rekeyed to the engine's session id once init reports it (resume forks). */
  conversationId: string;
  /**
   * Renderable wire messages emitted since this session booted. The engine
   * flushes its session JSONL lazily, so history for a LIVE conversation is
   * served from this buffer layered over the file parse.
   */
  readonly transcript: ServerMsg[] = [];
  readonly permissions: PermissionBroker;
  private input = new InputQueue();
  private session: Query;
  private emit: (msg: ServerMsg) => void;
  private closed = false;
  private allowBypass: boolean;
  private currentMode: string;
  private model: string;
  // Rich command list from initializationResult (has descriptions, unlike
  // the init event's bare names).
  private slashCommands: Array<{ name: string; description: string }> = [];
  private models: Array<{
    value: string;
    label: string;
    description: string;
    resolvedModel?: string;
  }> = [];
  private initSeen = false;

  // --- streaming state (per in-flight assistant API message) ---
  private assistantId: string | null = null;
  private assistantStarted = false; // assistant_start is emitted lazily on the
  // first text delta so tool-only messages don't render an empty bubble.
  private assistantText = '';
  private thinkingId: string | null = null;
  private thinkingStreamed = 0; // chars streamed for the open thinking block
  // Content-block types by index, so content_block_stop knows what ended.
  private blockTypes = new Map<number, string>();
  // tool_use blocks under construction, keyed by content-block index.
  private pendingToolInputs = new Map<number, { id: string; name: string; json: string }>();
  // engine tool_use ids already surfaced, so canonical assistant messages
  // don't re-emit cards the stream already produced.
  private emittedTools = new Set<string>();
  // Output tokens for the in-flight turn (sum across the turn's API
  // messages; message_delta usage is cumulative per message).
  private turnOutputTokens = 0;
  private currentMessageTokens = 0;

  constructor(opts: AgentSessionOptions) {
    this.conversationId = opts.conversationId;
    this.emit = (msg: ServerMsg) => {
      if (BUFFERED.has(msg.t)) this.transcript.push(msg);
      opts.onMessage(msg);
    };
    this.allowBypass = opts.allowBypass ?? false;
    this.currentMode = opts.permissionMode;
    this.model = opts.model ?? '';

    this.permissions = new PermissionBroker(
      (req: PendingPermission) =>
        this.emit({ t: 'permission_request', reqId: req.reqId, tool: req.tool, input: req.input }),
      (reqId) => this.emit({ t: 'permission_resolved', reqId }),
    );

    const options: Options = {
      // Claude Code's own preset so behavior matches the CLI.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: opts.permissionMode,
      canUseTool: async (toolName, input, { signal }) =>
        this.permissions.request(toolName, input, signal),
      includePartialMessages: true,
      cwd: opts.cwd,
      ...(opts.allowBypass ? { allowDangerouslySkipPermissions: true } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.allowedTools?.length ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.disallowedTools?.length ? { disallowedTools: opts.disallowedTools } : {}),
    };

    this.session = query({ prompt: this.input, options });
    void this.run(opts.onSessionId);
    void this.announceInit();
  }

  /**
   * The engine only emits its init event with the first turn; the initialize
   * control request resolves as soon as the CLI boots. Announce a session
   * early so slash commands and mode switching work before any prompt.
   */
  private async announceInit(): Promise<void> {
    try {
      const info = await this.session.initializationResult();
      this.slashCommands = info.commands.map((c) => ({
        name: c.name,
        description: c.description ?? '',
      }));
      try {
        this.models = (await this.session.supportedModels()).map((m) => ({
          value: m.value,
          label: m.displayName,
          description: (m as { description?: string }).description ?? '',
          // Canonical wire id (e.g. 'opus[1m]' → 'claude-opus-4-8[1m]') so the
          // client can match the init event's full model id to a row.
          resolvedModel: m.resolvedModel,
        }));
      } catch {
        // model list is optional
      }
      if (this.initSeen || this.closed) return; // real init already announced
      this.emit({
        t: 'session',
        conversationId: this.conversationId,
        sessionId: '',
        model: this.model,
        tools: [],
        permissionMode: this.currentMode,
        slashCommands: this.slashCommands,
        models: this.models,
        bypassAvailable: this.allowBypass,
      });
    } catch {
      // Engine failed to boot; the run loop surfaces the error.
    }
  }

  sendPrompt(text: string, images: PromptImage[] = []): void {
    this.emit({
      t: 'user_prompt',
      id: randomUUID(),
      text,
      ...(images.length ? { images } : {}),
    });
    this.emit({ t: 'status', state: 'thinking' });
    // Images go before the text as API image blocks; the text keeps its
    // "[Image #N]" tokens, which refer to the Nth image by order — the same
    // shape the TUI writes, so history replay round-trips cleanly.
    const content =
      images.length > 0
        ? [
            ...images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mediaType as 'image/png',
                data: img.data,
              },
            })),
            ...(text.trim() ? [{ type: 'text' as const, text }] : []),
          ]
        : text;
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    try {
      await this.session.interrupt();
    } catch (err) {
      this.emit({ t: 'error', message: `Interrupt failed: ${errText(err)}` });
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    try {
      await this.session.setPermissionMode(mode as PermissionMode);
      this.currentMode = mode;
      this.emit({ t: 'mode', mode });
    } catch (err) {
      this.emit({ t: 'error', message: `Could not set permission mode: ${errText(err)}` });
      // Revert clients that updated optimistically.
      this.emit({ t: 'mode', mode: this.currentMode });
    }
  }

  async setModel(model?: string): Promise<void> {
    try {
      await this.session.setModel(model);
      this.model = model ?? 'default';
      this.emit({ t: 'model', model: this.model });
    } catch (err) {
      this.emit({ t: 'error', message: `Could not set model: ${errText(err)}` });
      this.emit({ t: 'model', model: this.model }); // revert optimistic clients
    }
  }

  /** Current model id as last reported/selected for this session. */
  get modelId(): string {
    return this.model;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.permissions.denyAll('Session closed');
    this.input.end();
    try {
      this.session.close();
    } catch {
      // already torn down
    }
  }

  private async run(onSessionId: (id: string) => void): Promise<void> {
    try {
      for await (const message of this.session) {
        this.handleEngineMessage(message, onSessionId);
      }
    } catch (err) {
      if (!this.closed) {
        this.emit({ t: 'error', message: errText(err) });
        this.emit({ t: 'status', state: 'idle' });
      }
    }
  }

  // ---- engine event → wire protocol mapping (ARCHITECTURE.md §5, §6) ----

  private handleEngineMessage(message: SDKMessage, onSessionId: (id: string) => void): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.initSeen = true;
          onSessionId(message.session_id);
          this.currentMode = message.permissionMode;
          this.model = message.model;
          this.emit({
            t: 'session',
            conversationId: this.conversationId,
            sessionId: message.session_id,
            model: message.model,
            tools: message.tools,
            permissionMode: message.permissionMode,
            slashCommands: this.slashCommands.length
              ? this.slashCommands
              : (message.slash_commands ?? []).map((name) => ({ name, description: '' })),
            models: this.models,
            bypassAvailable: this.allowBypass,
          });
        }
        return;

      case 'stream_event':
        // Subagent (Task tool) streams carry parent_tool_use_id — keep them
        // out of the top-level transcript; the Task tool card covers them.
        if (message.parent_tool_use_id) return;
        this.handleStreamEvent(message.event);
        return;

      case 'assistant': {
        if (message.parent_tool_use_id) return;
        this.finishAssistantMessage(message.message.content);
        return;
      }

      case 'user': {
        if (message.parent_tool_use_id) return;
        // Tool results fed back into the model. (Plain text user messages are
        // echoes of our own input — user_prompt already covers those.)
        const content = message.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          this.emit({
            t: 'tool_result',
            id: randomUUID(),
            forToolId: block.tool_use_id,
            output: block.content ?? '',
            isError: block.is_error ?? false,
          });
        }
        this.emit({ t: 'status', state: 'thinking' });
        return;
      }

      case 'result': {
        this.emit({
          t: 'result',
          turnId: message.uuid,
          usage: {
            input_tokens: message.usage.input_tokens,
            output_tokens: message.usage.output_tokens,
            cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
            cache_read_input_tokens: message.usage.cache_read_input_tokens,
          },
          costUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
          isError: message.is_error,
        });
        if (message.is_error && message.subtype !== 'success') {
          this.emit({ t: 'error', message: `Turn ended: ${message.subtype}` });
        }
        this.turnOutputTokens = 0;
        this.currentMessageTokens = 0;
        this.emit({ t: 'status', state: 'idle' });
        return;
      }

      default:
        // Other engine message types (hooks, tasks, notifications…) are not
        // part of the wire protocol.
        return;
    }
  }

  /** Raw Claude API streaming events (includePartialMessages). */
  private handleStreamEvent(event: { type: string }): void {
    const ev = event as Record<string, any>;
    switch (event.type) {
      case 'message_start':
        this.assistantId = randomUUID();
        this.assistantStarted = false;
        this.assistantText = '';
        this.currentMessageTokens = 0;
        this.blockTypes.clear();
        this.pendingToolInputs.clear();
        return;

      case 'message_delta': {
        const outputTokens = ev.usage?.output_tokens;
        if (typeof outputTokens === 'number' && outputTokens > this.currentMessageTokens) {
          this.turnOutputTokens += outputTokens - this.currentMessageTokens;
          this.currentMessageTokens = outputTokens;
          this.emit({ t: 'tokens', output: this.turnOutputTokens });
        }
        return;
      }

      case 'content_block_start': {
        const block = ev.content_block;
        this.blockTypes.set(ev.index, block?.type ?? '');
        if (block?.type === 'tool_use') {
          this.pendingToolInputs.set(ev.index, { id: block.id, name: block.name, json: '' });
        } else if (block?.type === 'thinking') {
          this.thinkingId = randomUUID();
          this.thinkingStreamed = 0;
          this.emit({ t: 'thinking_start', id: this.thinkingId });
        }
        return;
      }

      case 'content_block_delta': {
        const delta = ev.delta;
        if (delta?.type === 'text_delta' && this.assistantId) {
          if (!this.assistantStarted) {
            this.assistantStarted = true;
            this.emit({ t: 'assistant_start', id: this.assistantId });
          }
          this.assistantText += delta.text;
          this.emit({ t: 'assistant_delta', id: this.assistantId, text: delta.text });
        } else if (delta?.type === 'thinking_delta' && this.thinkingId) {
          const text = delta.thinking ?? '';
          this.thinkingStreamed += text.length;
          if (text) this.emit({ t: 'thinking_delta', id: this.thinkingId, text });
        } else if (delta?.type === 'input_json_delta') {
          const pending = this.pendingToolInputs.get(ev.index);
          if (pending) pending.json += delta.partial_json;
        }
        return;
      }

      case 'content_block_stop': {
        switch (this.blockTypes.get(ev.index)) {
          case 'tool_use': {
            const pending = this.pendingToolInputs.get(ev.index);
            if (pending) {
              this.pendingToolInputs.delete(ev.index);
              this.emitToolUse(pending.id, pending.name, parseJsonLoose(pending.json));
            }
            return;
          }
          case 'thinking':
            // If nothing streamed (thinking often arrives canonically, with
            // only a signature in the stream), keep the panel open — the
            // canonical assistant event will supply the content.
            if (this.thinkingId && this.thinkingStreamed > 0) {
              this.emit({ t: 'thinking_end', id: this.thinkingId });
              this.thinkingId = null;
            }
            return;
          default:
            return;
        }
      }

      default:
        return;
    }
  }

  /**
   * Canonical `assistant` events. The engine emits one per COMPLETED content
   * block while streaming (thinking → text → tool_use, separately), not one
   * per API message — so only finalize the state belonging to the block types
   * actually present. A thinking-only event must not reset the text stream,
   * or every text delta after it would be dropped.
   */
  private finishAssistantMessage(content: Array<Record<string, any>> | string): void {
    const blocks = Array.isArray(content) ? content : [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text': {
          // Replace the incrementally-built copy with canonical Markdown.
          const markdown = (block.text as string) || this.assistantText;
          if (markdown || this.assistantStarted) {
            const id = this.assistantId ?? randomUUID();
            if (!this.assistantStarted) this.emit({ t: 'assistant_start', id });
            this.emit({ t: 'assistant_end', id, markdown });
          }
          // Next text block (if any) becomes a new message bubble.
          this.assistantId = randomUUID();
          this.assistantStarted = false;
          this.assistantText = '';
          break;
        }

        case 'thinking': {
          const text = (block.thinking as string) ?? '';
          if (this.thinkingId) {
            // Panel already open from the stream; fill it if the stream only
            // carried a signature, then close it.
            if (this.thinkingStreamed === 0 && text) {
              this.emit({ t: 'thinking_delta', id: this.thinkingId, text });
            }
            this.emit({ t: 'thinking_end', id: this.thinkingId });
            this.thinkingId = null;
            this.thinkingStreamed = 0;
          } else if (text && !this.thinkingStreamed) {
            // No stream events at all for this block — emit it whole.
            const id = randomUUID();
            this.emit({ t: 'thinking_start', id });
            this.emit({ t: 'thinking_delta', id, text });
            this.emit({ t: 'thinking_end', id });
          }
          break;
        }

        case 'tool_use':
          this.emitToolUse(block.id, block.name, block.input);
          break;
      }
    }
  }

  private emitToolUse(id: string, name: string, input: unknown): void {
    if (this.emittedTools.has(id)) return;
    this.emittedTools.add(id);
    this.emit({ t: 'tool_use', id, name, input, status: 'running' });
    this.emit({ t: 'status', state: 'running_tool' });
  }
}

function parseJsonLoose(json: string): unknown {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return { _raw: json };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
