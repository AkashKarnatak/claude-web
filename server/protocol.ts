// Wire protocol between backend and browser (ARCHITECTURE.md §6).
// The frontend only ever sees these shapes; all engine-version-specific
// parsing stays in agent.ts. Do not leak raw engine events to the client.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ConversationMeta {
  id: string;
  sessionId: string | null;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
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
  | { t: 'user_prompt'; id: string; text: string }
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
  // @-mention file completion results.
  | { t: 'file_suggestions'; reqId: string; items: string[] }
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
  | { t: 'prompt'; text: string }
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
  | { t: 'auth'; token: string };

