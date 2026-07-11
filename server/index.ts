// HTTP + WebSocket bootstrap (ARCHITECTURE.md §3, §11).
// Binds 127.0.0.1 ONLY. The API key lives in this process's environment and
// is never sent to the browser.

import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession } from './agent.js';
import { suggestFiles } from './files.js';
import { shouldPersist, type ClientMsg, type ServerMsg } from './protocol.js';
import { ConversationStore } from './sessions.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const WORK_DIR = process.env.WORK_DIR || ROOT;
const PERMISSION_MODE = (process.env.PERMISSION_MODE || 'default') as PermissionMode;
// Opt-in: launches sessions with allowDangerouslySkipPermissions so the
// bypassPermissions mode is switchable. Off by default (§11).
const ALLOW_BYPASS = process.env.ALLOW_BYPASS === 'true';
const MODEL = process.env.MODEL || undefined;
const ALLOWED_TOOLS = splitList(process.env.ALLOWED_TOOLS);
const DISALLOWED_TOOLS = splitList(process.env.DISALLOWED_TOOLS);
const STATIC_DIR = path.join(ROOT, 'web', 'dist');

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '[claude-web] ANTHROPIC_API_KEY is not set — the engine will fail to authenticate. ' +
      'Set it in .env or the environment.',
  );
}

function splitList(v: string | undefined): string[] {
  return (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Conversation manager: live engine sessions + subscribers + persistence.
// ---------------------------------------------------------------------------

const store = new ConversationStore(process.env.DATA_DIR || path.join(ROOT, 'data'));
const liveSessions = new Map<string, AgentSession>();
const subscribers = new Map<string, Set<WebSocket>>();
// Mode/model chosen while in the draft state (no conversation yet); applied
// when the first prompt creates the session.
const pendingModes = new Map<WebSocket, string>();
const pendingModels = new Map<WebSocket, string>();
// Merged-thinking persistence buffers (protocol.ts skips per-token deltas).
const thinkingBuffers = new Map<string, { id: string; text: string }>();
// Last engine init info (model, tools, slash commands). Sent to clients
// opening a conversation so typeahead works before the first turn, and
// persisted so it survives server restarts (tsx watch restarts often).
type SessionInfoMsg = Extract<ServerMsg, { t: 'session' }>;
const ENGINE_INFO_FILE = path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'engine-info.json');
let lastSessionInfo: SessionInfoMsg | null = null;
try {
  lastSessionInfo = JSON.parse(fs.readFileSync(ENGINE_INFO_FILE, 'utf8'));
} catch {
  // none yet
}

function cacheSessionInfo(msg: SessionInfoMsg): void {
  lastSessionInfo = msg;
  try {
    fs.writeFileSync(ENGINE_INFO_FILE, JSON.stringify(msg, null, 2));
  } catch {
    // persistence is best-effort
  }
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(conversationId: string, msg: ServerMsg): void {
  if (msg.t === 'session') cacheSessionInfo(msg);
  persist(conversationId, msg);
  const subs = subscribers.get(conversationId);
  if (!subs) return;
  const data = JSON.stringify(msg);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function persist(conversationId: string, msg: ServerMsg): void {
  // Buffer thinking deltas; write one merged trio at thinking_end so the
  // transcript keeps the panel without a line per token.
  if (msg.t === 'thinking_start') {
    thinkingBuffers.set(conversationId, { id: msg.id, text: '' });
    return;
  }
  if (msg.t === 'thinking_delta') {
    const buf = thinkingBuffers.get(conversationId);
    if (buf && buf.id === msg.id) buf.text += msg.text;
    return;
  }
  if (msg.t === 'thinking_end') {
    const buf = thinkingBuffers.get(conversationId);
    thinkingBuffers.delete(conversationId);
    if (buf && buf.text) {
      store.appendTranscript(conversationId, { t: 'thinking_start', id: buf.id });
      store.appendTranscript(conversationId, { t: 'thinking_delta', id: buf.id, text: buf.text });
      store.appendTranscript(conversationId, { t: 'thinking_end', id: buf.id });
    }
    return;
  }
  if (!shouldPersist(msg)) return;
  store.appendTranscript(conversationId, msg);
  if (msg.t === 'user_prompt') {
    const meta = store.get(conversationId);
    if (meta && meta.title === 'New conversation') {
      store.update(conversationId, { title: msg.text.slice(0, 60) });
    } else {
      store.update(conversationId, {});
    }
    broadcastConversationList();
  }
}

function ensureSession(
  conversationId: string,
  initialMode?: string,
  initialModel?: string,
): AgentSession {
  let session = liveSessions.get(conversationId);
  if (session) return session;
  const meta = store.get(conversationId);
  if (!meta) throw new Error(`Unknown conversation ${conversationId}`);
  session = new AgentSession({
    conversationId,
    cwd: meta.cwd,
    permissionMode: (initialMode ?? PERMISSION_MODE) as PermissionMode,
    model: initialModel ?? MODEL,
    resume: meta.sessionId ?? undefined,
    allowBypass: ALLOW_BYPASS,
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    onMessage: (msg) => broadcast(conversationId, msg),
    onSessionId: (sessionId) => store.update(conversationId, { sessionId }),
  });
  liveSessions.set(conversationId, session);
  return session;
}

function broadcastConversationList(): void {
  const msg: ServerMsg = { t: 'conversations', items: store.list() };
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function subscribe(ws: WebSocket, conversationId: string): void {
  // One conversation per socket: drop any previous subscription.
  for (const subs of subscribers.values()) subs.delete(ws);
  let subs = subscribers.get(conversationId);
  if (!subs) {
    subs = new Set();
    subscribers.set(conversationId, subs);
  }
  subs.add(ws);
}

function openConversation(ws: WebSocket, conversationId: string): void {
  const meta = store.get(conversationId);
  if (!meta) {
    send(ws, { t: 'error', message: `Unknown conversation ${conversationId}` });
    return;
  }
  subscribe(ws, conversationId);
  send(ws, {
    t: 'history',
    conversationId,
    meta,
    messages: store.readTranscript(conversationId),
  });
  if (lastSessionInfo) {
    send(ws, { ...lastSessionInfo, conversationId });
  }
  // Re-surface pending permission prompts to the (re)connecting client.
  const session = liveSessions.get(conversationId);
  if (session) {
    for (const req of session.permissions.list()) {
      send(ws, { t: 'permission_request', reqId: req.reqId, tool: req.tool, input: req.input });
    }
  }
  // Boot the engine eagerly (like the TUI does on launch) so slash commands,
  // model info, and mode switching work before the first prompt.
  try {
    ensureSession(conversationId);
  } catch (err) {
    send(ws, { t: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function activeConversationId(ws: WebSocket): string | null {
  for (const [id, subs] of subscribers) {
    if (subs.has(ws)) return id;
  }
  return null;
}

function handleClientMsg(ws: WebSocket, msg: ClientMsg): void {
  switch (msg.t) {
    case 'list_conversations':
      send(ws, { t: 'conversations', items: store.list() });
      return;

    case 'new_conversation': {
      // Back to the blank draft state; a record is only created on first
      // prompt, so abandoned "new chats" never litter the sidebar.
      for (const subs of subscribers.values()) subs.delete(ws);
      pendingModes.delete(ws);
      pendingModels.delete(ws);
      send(ws, { t: 'draft' });
      return;
    }

    case 'open_conversation':
      openConversation(ws, msg.conversationId);
      return;

    case 'prompt': {
      if (!msg.text.trim()) return;
      let id = activeConversationId(ws);
      if (!id) {
        // First prompt of a draft: create the conversation now.
        const meta = store.create(WORK_DIR);
        id = meta.id;
        subscribe(ws, id);
        broadcastConversationList();
        send(ws, { t: 'history', conversationId: id, meta, messages: [] });
      }
      const mode = pendingModes.get(ws);
      const model = pendingModels.get(ws);
      pendingModes.delete(ws);
      pendingModels.delete(ws);
      ensureSession(id, mode, model).sendPrompt(msg.text);
      return;
    }

    case 'permission': {
      const id = activeConversationId(ws);
      const session = id ? liveSessions.get(id) : undefined;
      session?.permissions.decide(msg.reqId, msg.decision, msg.updatedInput, msg.reason);
      return;
    }

    case 'interrupt': {
      const id = activeConversationId(ws);
      const session = id ? liveSessions.get(id) : undefined;
      void session?.interrupt();
      return;
    }

    case 'set_mode': {
      const id = activeConversationId(ws);
      if (id) {
        void ensureSession(id).setPermissionMode(msg.mode);
      } else {
        // Draft state: remember the choice for when the session is created.
        pendingModes.set(ws, msg.mode);
        send(ws, { t: 'mode', mode: msg.mode });
      }
      return;
    }

    case 'set_model': {
      const id = activeConversationId(ws);
      if (id) {
        void ensureSession(id).setModel(msg.model);
      } else if (msg.model) {
        pendingModels.set(ws, msg.model);
        send(ws, { t: 'model', model: msg.model });
      } else {
        pendingModels.delete(ws);
        send(ws, { t: 'model', model: 'default' });
      }
      return;
    }

    case 'suggest_files': {
      const id = activeConversationId(ws);
      const cwd = (id && store.get(id)?.cwd) || WORK_DIR;
      send(ws, { t: 'file_suggestions', reqId: msg.reqId, items: suggestFiles(cwd, msg.query) });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP server: static frontend (web/dist) + health endpoint.
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Static frontend (production). In dev, Vite serves the UI and proxies /ws.
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(STATIC_DIR, rel);
  if (file.startsWith(STATIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const index = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(index)) {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    fs.createReadStream(index).pipe(res);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('claude-web backend running. Build the frontend (npm run build) or use npm run dev.');
});

// ---------------------------------------------------------------------------
// WebSocket server with Origin check (§11: blunt cross-site WS hijacking).
// ---------------------------------------------------------------------------

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (curl, tests)
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/ws' || !originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  send(ws, { t: 'conversations', items: store.list() });
  // Engine info (slash commands, model) so typeahead works in the draft.
  if (lastSessionInfo) send(ws, { ...lastSessionInfo, conversationId: '' });
  // Land on a blank draft; past chats are one sidebar click away.
  send(ws, { t: 'draft' });

  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { t: 'error', message: 'Malformed client message' });
      return;
    }
    try {
      handleClientMsg(ws, msg);
    } catch (err) {
      send(ws, { t: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });

  ws.on('close', () => {
    for (const subs of subscribers.values()) subs.delete(ws);
    pendingModes.delete(ws);
    pendingModels.delete(ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[claude-web] listening on http://${HOST}:${PORT} (cwd for agent: ${WORK_DIR})`);
});
