// Conversation + streaming message state (ARCHITECTURE.md §14).
// The store only understands the wire protocol — never raw engine events.

import { create } from 'zustand';
import type { ConversationMeta, ServerMsg, Usage } from '../../server/protocol';
import { sampleVerb } from './spinnerVerbs';

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; markdown: string; streaming: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      status: 'running' | 'ok' | 'error';
      output?: unknown;
    }
  | {
      kind: 'result';
      id: string;
      usage: Usage;
      costUsd: number;
      durationMs: number;
      isError: boolean;
    }
  | { kind: 'error'; id: string; message: string };

export interface PermissionRequest {
  reqId: string;
  tool: string;
  input: unknown;
}

export interface SessionInfo {
  sessionId: string;
  model: string;
  tools: string[];
  permissionMode: string;
  slashCommands: Array<{ name: string; description: string }>;
  models: Array<{ value: string; label: string; description: string; resolvedModel?: string }>;
  bypassAvailable: boolean;
}

/** Live spinner state for the in-flight turn (verb sampled once per turn). */
export interface TurnState {
  verb: string;
  startedAt: number;
  tokens: number;
}

export type Activity = 'requesting' | 'thinking' | 'responding' | 'tool';

interface AppState {
  connected: boolean;
  conversations: ConversationMeta[];
  activeId: string | null;
  activeMeta: ConversationMeta | null;
  items: TranscriptItem[];
  status: 'idle' | 'thinking' | 'running_tool';
  session: SessionInfo | null;
  permissions: PermissionRequest[];
  turn: TurnState | null;
  activity: Activity;
  currentTool: string | null;
  fileSuggestions: { reqId: string; items: string[] } | null;
  modelPickerOpen: boolean;
  sidebarOpen: boolean;
  /** Bumps when a conversation is opened or the draft is entered — NOT on
   * session-id rekeys. Drives scroll-state resets in the message list. */
  openSeq: number;
  setConnected: (connected: boolean) => void;
  handleServerMsg: (msg: ServerMsg) => void;
  /** Batched streaming deltas (one store update per animation frame). */
  applyDeltas: (deltas: Array<{ id: string; kind: 'assistant' | 'thinking'; text: string }>) => void;
}

function applyMsg(state: AppState, msg: ServerMsg): Partial<AppState> {
  switch (msg.t) {
    case 'conversations':
      return { conversations: msg.items };

    case 'draft':
      // Blank state: keep session info (typeahead/mode) but clear the chat.
      return {
        openSeq: state.openSeq + 1,
        activeId: null,
        activeMeta: null,
        items: [],
        permissions: [],
        status: 'idle',
        turn: null,
        currentTool: null,
        fileSuggestions: null,
      };

    case 'history': {
      // Replay the persisted transcript through the same reducer.
      let acc: AppState = {
        ...state,
        activeId: msg.conversationId,
        activeMeta: msg.meta,
        items: [],
        permissions: [],
        status: 'idle',
        session: null,
        turn: null,
        currentTool: null,
        activity: 'requesting',
      };
      for (const m of msg.messages) {
        acc = { ...acc, ...applyMsg(acc, m) };
      }
      // History replay renders everything as settled.
      return {
        ...acc,
        openSeq: state.openSeq + 1,
        items: acc.items.map((it) =>
          (it.kind === 'assistant' || it.kind === 'thinking') && it.streaming
            ? { ...it, streaming: false }
            : it,
        ),
        status: 'idle',
      };
    }

    case 'session': {
      // Resume forks the engine session under a new id; follow it so the
      // sidebar highlight and future opens track the engine's identity.
      const follow =
        msg.conversationId && state.activeId && msg.conversationId !== state.activeId
          ? {
              activeId: msg.conversationId,
              activeMeta: state.activeMeta
                ? { ...state.activeMeta, id: msg.conversationId, sessionId: msg.sessionId }
                : state.activeMeta,
            }
          : {};
      return {
        ...follow,
        session: {
          sessionId: msg.sessionId,
          model: msg.model,
          tools: msg.tools,
          permissionMode: msg.permissionMode,
          slashCommands: msg.slashCommands.map((c) => ({
            ...c,
            name: c.name.replace(/^\//, ''),
          })),
          models: msg.models,
          bypassAvailable: msg.bypassAvailable,
        },
      };
    }

    case 'mode':
      return state.session
        ? { session: { ...state.session, permissionMode: msg.mode } }
        : {};

    case 'model':
      return state.session ? { session: { ...state.session, model: msg.model } } : {};

    case 'user_prompt':
      return { items: [...state.items, { kind: 'user', id: msg.id, text: msg.text }] };

    case 'assistant_start':
      return {
        items: [...state.items, { kind: 'assistant', id: msg.id, markdown: '', streaming: true }],
      };

    case 'assistant_delta':
      return {
        items: updateItem(state.items, msg.id, 'assistant', (it) => ({
          ...it,
          markdown: it.markdown + msg.text,
        })),
      };

    case 'assistant_end': {
      const exists = state.items.some((it) => it.kind === 'assistant' && it.id === msg.id);
      if (!exists) {
        if (!msg.markdown) return {}; // tool-only message — nothing to show
        return {
          items: [
            ...state.items,
            { kind: 'assistant', id: msg.id, markdown: msg.markdown, streaming: false },
          ],
        };
      }
      // Replace the incrementally-built copy with the canonical Markdown.
      return {
        items: updateItem(state.items, msg.id, 'assistant', (it) => ({
          ...it,
          markdown: msg.markdown,
          streaming: false,
        })),
      };
    }

    case 'thinking_start':
      return {
        items: [...state.items, { kind: 'thinking', id: msg.id, text: '', streaming: true }],
      };

    case 'thinking_delta':
      return {
        items: updateItem(state.items, msg.id, 'thinking', (it) => ({
          ...it,
          text: it.text + msg.text,
        })),
      };

    case 'thinking_end':
      return {
        items: updateItem(state.items, msg.id, 'thinking', (it) => ({ ...it, streaming: false })),
      };

    case 'tool_use':
      return {
        items: [
          ...state.items,
          { kind: 'tool', id: msg.id, name: msg.name, input: msg.input, status: 'running' },
        ],
        activity: 'tool',
        currentTool: msg.name,
      };

    case 'tool_result':
      return {
        items: updateItem(state.items, msg.forToolId, 'tool', (it) => ({
          ...it,
          status: msg.isError ? 'error' : 'ok',
          output: msg.output,
        })),
        activity: 'requesting',
        currentTool: null,
      };

    case 'permission_request':
      if (state.permissions.some((p) => p.reqId === msg.reqId)) return {};
      return {
        permissions: [
          ...state.permissions,
          { reqId: msg.reqId, tool: msg.tool, input: msg.input },
        ],
      };

    case 'permission_resolved':
      return { permissions: state.permissions.filter((p) => p.reqId !== msg.reqId) };

    case 'result':
      return {
        items: [
          ...state.items,
          {
            kind: 'result',
            id: msg.turnId,
            usage: msg.usage,
            costUsd: msg.costUsd,
            durationMs: msg.durationMs,
            isError: msg.isError,
          },
        ],
      };

    case 'error':
      return {
        items: [...state.items, { kind: 'error', id: crypto.randomUUID(), message: msg.message }],
      };

    case 'status': {
      if (msg.state === 'idle') {
        return {
          status: msg.state,
          turn: null,
          currentTool: null,
          activity: 'requesting',
          // Settle anything still marked streaming; the turn is over.
          items: state.items.map((it) =>
            (it.kind === 'assistant' || it.kind === 'thinking') && it.streaming
              ? { ...it, streaming: false }
              : it,
          ),
        };
      }
      // Start the spinner when the engine begins working on a turn.
      const turn = state.turn ?? { verb: sampleVerb(), startedAt: Date.now(), tokens: 0 };
      return { status: msg.state, turn };
    }

    case 'tokens':
      return state.turn ? { turn: { ...state.turn, tokens: msg.output } } : {};

    case 'file_suggestions':
      return { fileSuggestions: { reqId: msg.reqId, items: msg.items } };

    default:
      return {};
  }
}

function updateItem<K extends TranscriptItem['kind']>(
  items: TranscriptItem[],
  id: string,
  kind: K,
  fn: (item: Extract<TranscriptItem, { kind: K }>) => TranscriptItem,
): TranscriptItem[] {
  const idx = items.findIndex((it) => it.kind === kind && it.id === id);
  if (idx === -1) return items;
  const next = items.slice();
  next[idx] = fn(items[idx] as Extract<TranscriptItem, { kind: K }>);
  return next;
}

export const useStore = create<AppState>((set, get) => ({
  connected: false,
  conversations: [],
  activeId: null,
  activeMeta: null,
  items: [],
  status: 'idle',
  session: null,
  permissions: [],
  turn: null,
  activity: 'requesting',
  currentTool: null,
  fileSuggestions: null,
  modelPickerOpen: false,
  sidebarOpen: false,
  openSeq: 0,

  setConnected: (connected) => set({ connected }),

  handleServerMsg: (msg) => set((state) => applyMsg(state as AppState, msg)),

  applyDeltas: (deltas) => {
    let { items } = get();
    let activity: Activity = 'thinking';
    for (const d of deltas) {
      if (d.kind === 'assistant') {
        activity = 'responding';
        items = updateItem(items, d.id, 'assistant', (it) => ({
          ...it,
          markdown: it.markdown + d.text,
        }));
      } else {
        items = updateItem(items, d.id, 'thinking', (it) => ({ ...it, text: it.text + d.text }));
      }
    }
    set({ items, activity });
  },
}));
