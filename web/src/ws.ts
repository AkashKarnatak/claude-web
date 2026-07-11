// WebSocket client: connect, dispatch to store, reconnect with backoff.
// Streaming deltas are batched per animation frame (ARCHITECTURE.md §7, §16
// backpressure) so fast token streams don't flood React with re-renders.

import type { ClientMsg, ServerMsg } from '../../server/protocol';
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

function dispatch(msg: ServerMsg): void {
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
