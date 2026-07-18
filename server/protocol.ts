// Wire protocol between backend and browser (ARCHITECTURE.md §6).
// The frontend only ever sees these shapes; all engine-version-specific
// parsing stays in agent.ts. Do not leak raw engine events to the client.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** A pasted/dropped image attached to a prompt (base64, API-supported type).
 * Order matters: the Nth image is what "[Image #N]" in the text refers to. */
export interface PromptImage {
  mediaType: string;
  data: string;
}

export interface ConversationMeta {
  id: string;
  sessionId: string | null;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

// A background task or fanned-out subagent (Task tool, workflow, background
// shell) as shown in the tasks panel.
export interface TaskItem {
  taskId: string;
  /** Engine task type: 'local_bash', 'local_workflow', subagent runs, … */
  taskType?: string;
  /** Subagent type for Task-tool agents (e.g. 'general-purpose'). */
  subagentType?: string;
  workflowName?: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused' | 'stopped';
  /** Server epoch ms; the client ticks elapsed off this. */
  startedAt: number;
  endedAt?: number;
  /** Latest progress/final summary line. */
  summary?: string;
  lastToolName?: string;
  totalTokens?: number;
  toolUses?: number;
  error?: string;
}

// Global conversation search (ripgrep-style match list).
export interface SearchSnippet {
  role: 'user' | 'assistant';
  /** Context window around the match ("…" ellipses included). */
  text: string;
  /** [start, end) highlight ranges into `text`, non-overlapping, sorted. */
  ranges: Array<[number, number]>;
}

export interface SearchResult {
  /** Conversation (= engine session) id, openable via open_conversation. */
  id: string;
  title: string;
  updatedAt: number;
  matchCount: number;
  snippets: SearchSnippet[];
}

export type ServerMsg =
  // Session bootstrap (from the engine's system/init event).
  | {
      t: 'session';
      conversationId: string;
      sessionId: string;
      model: string;
      tools: string[];
      permissionMode: string;
      slashCommands: Array<{ name: string; description: string }>;
      models: Array<{ value: string; label: string; description: string; resolvedModel?: string }>;
      // bypassPermissions can only be entered if the session was launched
      // with allowDangerouslySkipPermissions; the cycle skips it otherwise.
      bypassAvailable: boolean;
    }
  // Authoritative permission-mode confirmation (or revert after a failed
  // set_mode) — clients update optimistically and settle on this.
  | { t: 'mode'; mode: string }
  // Authoritative model confirmation/revert, same contract as 'mode'.
  | { t: 'model'; model: string }
  // Echo of a user prompt, so transcripts/history include both sides.
  | { t: 'user_prompt'; id: string; text: string; images?: PromptImage[] }
  // Assistant Markdown streaming.
  | { t: 'assistant_start'; id: string }
  | { t: 'assistant_delta'; id: string; text: string }
  | { t: 'assistant_end'; id: string; markdown: string }
  // Extended-thinking streaming.
  | { t: 'thinking_start'; id: string }
  | { t: 'thinking_delta'; id: string; text: string }
  | { t: 'thinking_end'; id: string }
  // Tool activity.
  | { t: 'tool_use'; id: string; name: string; input: unknown; status: 'running' }
  | { t: 'tool_result'; id: string; forToolId: string; output: unknown; isError: boolean }
  // Interactive permission round-trip.
  | { t: 'permission_request'; reqId: string; tool: string; input: unknown; explanation?: string }
  | { t: 'permission_resolved'; reqId: string }
  // End-of-turn usage/cost footer.
  | { t: 'result'; turnId: string; usage: Usage; costUsd: number; durationMs: number; isError: boolean }
  | { t: 'error'; message: string }
  | { t: 'status'; state: 'idle' | 'thinking' | 'running_tool' }
  // Cumulative output tokens for the in-flight turn (spinner status line).
  | { t: 'tokens'; output: number }
  // Background tasks / subagents snapshot (full replace on every change).
  | { t: 'tasks'; items: TaskItem[] }
  // @-mention file completion results.
  | { t: 'file_suggestions'; reqId: string; items: string[] }
  // Global conversation search results.
  | { t: 'search_results'; reqId: string; items: SearchResult[] }
  // Conversation management (UI sidebar; ARCHITECTURE.md §9 persistence).
  | { t: 'conversations'; items: ConversationMeta[] }
  | { t: 'history'; conversationId: string; meta: ConversationMeta; messages: ServerMsg[] }
  // Blank draft state: no conversation open; one is created on first prompt.
  | { t: 'draft' }
  // Token auth handshake (only when bound to a non-loopback HOST).
  | { t: 'auth_required' }
  | { t: 'auth_ok' }
  | { t: 'auth_bad' };

export type ClientMsg =
  | { t: 'prompt'; text: string; images?: PromptImage[] }
  | {
      t: 'permission';
      reqId: string;
      decision: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      reason?: string;
    }
  | { t: 'interrupt' }
  | { t: 'set_mode'; mode: string }
  | { t: 'set_model'; model?: string }
  | { t: 'new_conversation' }
  | { t: 'open_conversation'; conversationId: string }
  | { t: 'list_conversations' }
  | { t: 'suggest_files'; reqId: string; query: string }
  | { t: 'search'; reqId: string; query: string }
  | { t: 'auth'; token: string };

