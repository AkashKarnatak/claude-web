// WebSocket client: connect, dispatch to store, reconnect with backoff.
// Streaming deltas are batched per animation frame (ARCHITECTURE.md §7, §16
// backpressure) so fast token streams don't flood React with re-renders.

import type { ClientMsg, ServerMsg } from '../../server/protocol';
import { clearPermissionNotification, notifyPermissionRequest } from './notify';
import { pathConversationId, replaceChatUrl } from './router';
import { useStore } from './store';

let ws: WebSocket | null = null;
let retryMs = 500;

// rAF delta batching. Order matters: any non-delta message flushes queued
// deltas first so the transcript never reorders.
let queuedDeltas: Array<{ id: string; kind: 'assistant' | 'thinking'; text: string }> = [];
let rafHandle: number | null = null;

function flushDeltas(): void {
  rafHandle = null;
  if (queuedDeltas.length === 0) return;
  // Merge consecutive deltas per message id to a single append.
  const merged: typeof queuedDeltas = [];
  for (const d of queuedDeltas) {
    const last = merged[merged.length - 1];
    if (last && last.id === d.id && last.kind === d.kind) {
      last.text += d.text;
    } else {
      merged.push({ ...d });
    }
  }
  queuedDeltas = [];
  useStore.getState().applyDeltas(merged);
}

function scheduleFlush(): void {
  if (rafHandle !== null) return;
  if (document.hidden) {
    // rAF doesn't fire in hidden tabs; keep the transcript current so it
    // isn't a sudden wall of text when the user tabs back.
    rafHandle = window.setTimeout(() => flushDeltas(), 250) as unknown as number;
  } else {
    rafHandle = requestAnimationFrame(flushDeltas);
  }
}

const TOKEN_KEY = 'claude-web-token';
// Only auto-try the stored token once per connection; a rejection means it's
// wrong and the user must type a new one.
let triedStoredToken = false;

export function submitToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  useStore.setState({ authState: 'required' }); // pending until auth_ok
  send({ t: 'auth', token });
}

function dispatch(msg: ServerMsg): void {
  if (msg.t === 'auth_required') {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored && !triedStoredToken) {
      triedStoredToken = true;
      send({ t: 'auth', token: stored });
    } else {
      useStore.setState({ authState: 'required' });
    }
    return;
  }
  if (msg.t === 'auth_ok') {
    triedStoredToken = false;
    useStore.setState({ authState: 'ok' });
    return;
  }
  if (msg.t === 'auth_bad') {
    localStorage.removeItem(TOKEN_KEY);
    useStore.setState({ authState: 'failed' });
    return;
  }
  if (msg.t === 'assistant_delta') {
    queuedDeltas.push({ id: msg.id, kind: 'assistant', text: msg.text });
    scheduleFlush();
    return;
  }
  if (msg.t === 'thinking_delta') {
    queuedDeltas.push({ id: msg.id, kind: 'thinking', text: msg.text });
    scheduleFlush();
    return;
  }
  flushDeltas();
  useStore.getState().handleServerMsg(msg);

  // ---- URL routing: keep /c/<id> in sync with the open conversation ----
  if (msg.t === 'draft') {
    // Bootstrap/reconnect lands on a draft; when the URL names a chat
    // (deep link, new tab, refresh), open it instead. "+ New chat" resets
    // the URL to / before requesting, so this never loops.
    const urlId = pathConversationId();
    if (urlId) send({ t: 'open_conversation', conversationId: urlId });
  } else if (msg.t === 'history') {
    // A conversation opened (click, deep link, or the first prompt of a
    // draft minting one) — make the URL reflect it.
    replaceChatUrl(msg.conversationId);
  } else if (msg.t === 'session' && msg.conversationId) {
    // Resume rekeys the conversation to the engine's session id mid-turn.
    const { activeId } = useStore.getState();
    if (activeId === msg.conversationId) replaceChatUrl(msg.conversationId);
  } else if (msg.t === 'error' && msg.message.startsWith('Unknown conversation')) {
    // Stale deep link — back to the draft URL so reconnects don't retry it.
    replaceChatUrl(null);
  }

  if (msg.t === 'permission_request') {
    notifyPermissionRequest(msg.tool, permissionDetail(msg.tool, msg.input));
  } else if (msg.t === 'permission_resolved') {
    const remaining = useStore.getState().permissions;
    if (remaining.length === 0) {
      clearPermissionNotification();
    } else {
      // Surface the next queued request to a still-unfocused user.
      const next = remaining[0];
      notifyPermissionRequest(next.tool, permissionDetail(next.tool, next.input));
    }
  }
}

/** Short human-readable line for permission notifications. */
function permissionDetail(tool: string, rawInput: unknown): string {
  const input = rawInput as Record<string, unknown> | null;
  if (tool === 'AskUserQuestion') {
    const first = (input?.questions as Array<{ question?: string }> | undefined)?.[0];
    if (first?.question) return first.question;
  }
  if (input && typeof input.command === 'string') return input.command;
  if (input && typeof input.file_path === 'string') return input.file_path;
  return JSON.stringify(rawInput ?? {});
}

export function connect(): void {
  // Idempotent: React StrictMode mounts effects twice in dev.
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    retryMs = 500;
    useStore.getState().setConnected(true);
  };

  ws.onmessage = (ev) => {
    try {
      dispatch(JSON.parse(ev.data));
    } catch (err) {
      console.error('Bad server message', err);
    }
  };

  ws.onclose = () => {
    useStore.getState().setConnected(false);
    ws = null;
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 10_000);
  };

  ws.onerror = () => ws?.close();
}

export function send(msg: ClientMsg): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
