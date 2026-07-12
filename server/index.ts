// HTTP + WebSocket bootstrap (ARCHITECTURE.md §3, §11).
// Binds 127.0.0.1 ONLY. The API key lives in this process's environment and
// is never sent to the browser.

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession } from './agent.js';
import { listConversations, readEngineTranscript } from './engineSessions.js';
import { suggestFiles } from './files.js';
import type { ClientMsg, ConversationMeta, ServerMsg } from './protocol.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
// Default: loopback only (ARCHITECTURE.md §11). Binding a LAN address (or
// 0.0.0.0) exposes an unauthenticated agent that can run shell commands and
// spend your API key to everyone on that network — prefer an SSH tunnel.
const HOST = process.env.HOST || '127.0.0.1';
const WORK_DIR = process.env.WORK_DIR || ROOT;
const PERMISSION_MODE = (process.env.PERMISSION_MODE || 'default') as PermissionMode;
// Opt-in: launches sessions with allowDangerouslySkipPermissions so the
// bypassPermissions mode is switchable. Off by default (§11).
const ALLOW_BYPASS = process.env.ALLOW_BYPASS === 'true';
const MODEL = process.env.MODEL || undefined;
const ALLOWED_TOOLS = splitList(process.env.ALLOWED_TOOLS);
const DISALLOWED_TOOLS = splitList(process.env.DISALLOWED_TOOLS);
const STATIC_DIR = path.join(ROOT, 'web', 'dist');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

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
// Conversations: Claude Code's own session store for WORK_DIR is the source
// of truth (same list as `claude --resume`). No app-side transcript store —
// history replay parses the engine's session JSONL.
// ---------------------------------------------------------------------------

const liveSessions = new Map<string, AgentSession>();
const subscribers = new Map<string, Set<WebSocket>>();
// Known sessions by id (refreshed from listSessions) + drafts that have sent
// a first prompt but whose engine session id isn't known yet.
const conversationCache = new Map<string, ConversationMeta>();
const draftMetas = new Map<string, ConversationMeta>();
// Mode/model chosen while in the draft state (no conversation yet); applied
// when the first prompt creates the session.
const pendingModes = new Map<WebSocket, string>();
const pendingModels = new Map<WebSocket, string>();

async function refreshConversations(): Promise<ConversationMeta[]> {
  try {
    const items = await listConversations(WORK_DIR);
    conversationCache.clear();
    for (const item of items) conversationCache.set(item.id, item);
    return items;
  } catch (err) {
    console.error('[claude-web] listSessions failed:', err);
    return [...conversationCache.values()];
  }
}

function getMeta(id: string): ConversationMeta | undefined {
  return conversationCache.get(id) ?? draftMetas.get(id);
}

// Last engine init info (model, tools, slash commands). Sent to clients on
// connect so typeahead works before any engine boots; persisted so it
// survives server restarts (tsx watch restarts often).
type SessionInfoMsg = Extract<ServerMsg, { t: 'session' }>;
const ENGINE_INFO_FILE = path.join(DATA_DIR, 'engine-info.json');
let lastSessionInfo: SessionInfoMsg | null = null;
try {
  lastSessionInfo = JSON.parse(fs.readFileSync(ENGINE_INFO_FILE, 'utf8'));
} catch {
  // none yet
}

function cacheSessionInfo(msg: SessionInfoMsg): void {
  lastSessionInfo = msg;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ENGINE_INFO_FILE, JSON.stringify(msg, null, 2));
  } catch {
    // persistence is best-effort
  }
}

// The user's last explicit /model choice. New sessions launch on it (resumed
// sessions restore their own model natively) and the draft header shows it.
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let selectedModel: string | undefined;
try {
  selectedModel = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).model || undefined;
} catch {
  // none yet
}

/** What a NEW chat will launch on — shown in the draft state's header. */
function draftModel(): string {
  return selectedModel ?? MODEL ?? 'default';
}

function saveSelectedModel(model: string | undefined): void {
  selectedModel = model && model !== 'default' ? model : undefined;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ model: selectedModel ?? null }, null, 2));
  } catch {
    // persistence is best-effort
  }
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(conversationId: string, msg: ServerMsg): void {
  if (msg.t === 'session') cacheSessionInfo(msg);
  if (msg.t === 'model') saveSelectedModel(msg.model);
  // Turn completion changes titles/timestamps in the engine store — refresh
  // now and again shortly after (the engine flushes its files lazily).
  if (msg.t === 'result') {
    void broadcastConversationList();
    setTimeout(() => void broadcastConversationList(), 2500);
  }
  const subs = subscribers.get(conversationId);
  if (!subs) return;
  const data = JSON.stringify(msg);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

async function broadcastConversationList(): Promise<void> {
  const items = await refreshConversations();
  const data = JSON.stringify({ t: 'conversations', items } satisfies ServerMsg);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

/**
 * Resuming forks the engine session under a new id. Rekey our maps to the
 * new id and tell clients, so the conversation identity follows the engine's.
 */
function rekeyConversation(session: AgentSession, oldId: string, newId: string): void {
  if (oldId === newId) return;
  session.conversationId = newId;
  liveSessions.delete(oldId);
  liveSessions.set(newId, session);
  const subs = subscribers.get(oldId);
  if (subs) {
    subscribers.delete(oldId);
    subscribers.set(newId, subs);
  }
  const meta = getMeta(oldId);
  draftMetas.delete(oldId);
  if (meta && !conversationCache.has(newId)) {
    conversationCache.set(newId, { ...meta, id: newId, sessionId: newId });
  }
  void broadcastConversationList();
}

function ensureSession(
  conversationId: string,
  initialMode?: string,
  initialModel?: string,
): AgentSession {
  const existing = liveSessions.get(conversationId);
  if (existing) return existing;
  const meta = getMeta(conversationId);
  if (!meta) throw new Error(`Unknown conversation ${conversationId}`);
  const session: AgentSession = new AgentSession({
    conversationId,
    cwd: meta.cwd,
    permissionMode: (initialMode ?? PERMISSION_MODE) as PermissionMode,
    // Resumed sessions restore their own model natively; this only sets the
    // launch model for NEW sessions: pending draft choice, then the user's
    // last selection, then the env default.
    model: initialModel ?? (meta.sessionId ? undefined : selectedModel) ?? MODEL,
    resume: meta.sessionId ?? undefined,
    allowBypass: ALLOW_BYPASS,
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    // Read the CURRENT id at emit time — it changes when init rekeys.
    onMessage: (msg) => broadcast(session.conversationId, msg),
    onSessionId: (sessionId) => rekeyConversation(session, session.conversationId, sessionId),
  });
  liveSessions.set(conversationId, session);
  return session;
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

async function openConversation(ws: WebSocket, conversationId: string): Promise<void> {
  let meta = getMeta(conversationId);
  if (!meta) {
    await refreshConversations();
    meta = getMeta(conversationId);
  }
  if (!meta) {
    send(ws, { t: 'error', message: `Unknown conversation ${conversationId}` });
    return;
  }
  subscribe(ws, conversationId);
  // File parse covers settled history; a live session's in-memory buffer is
  // layered on top since the engine flushes its JSONL lazily.
  const parsed = readEngineTranscript(meta.sessionId ?? conversationId);
  let messages = parsed.messages;
  const live = liveSessions.get(conversationId);
  if (live && live.transcript.length > 0) {
    const firstLive = live.transcript.find((m) => m.t === 'user_prompt');
    if (firstLive && firstLive.t === 'user_prompt') {
      const overlap = messages.findIndex(
        (m) => m.t === 'user_prompt' && m.text === firstLive.text,
      );
      if (overlap >= 0) messages = messages.slice(0, overlap);
    }
    messages = [...messages, ...live.transcript];
  }
  send(ws, { t: 'history', conversationId, meta, messages });
  if (lastSessionInfo) {
    send(ws, { ...lastSessionInfo, conversationId });
    // Show the model this session actually uses: the live session's if one
    // is running (file flush lags), else the last one in its transcript
    // (resume restores it natively).
    const sessionModel = (live && live.modelId) || parsed.lastModel;
    if (sessionModel) send(ws, { t: 'model', model: sessionModel });
  }
  // Re-surface pending permission prompts to the (re)connecting client.
  const session = liveSessions.get(conversationId);
  if (session) {
    for (const req of session.permissions.list()) {
      send(ws, { t: 'permission_request', reqId: req.reqId, tool: req.tool, input: req.input });
    }
  }
  // NOTE: no eager engine boot here — resuming forks a new engine session,
  // so merely browsing history must not mint session files. The engine
  // starts on the first prompt (or mode/model change).
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
      void refreshConversations().then((items) => send(ws, { t: 'conversations', items }));
      return;

    case 'new_conversation': {
      // Back to the blank draft state; nothing is created until the first
      // prompt, so abandoned "new chats" never litter the history.
      for (const subs of subscribers.values()) subs.delete(ws);
      pendingModes.delete(ws);
      pendingModels.delete(ws);
      send(ws, { t: 'draft' });
      // Reset the header from the previous conversation's model to what a
      // new chat will actually launch on.
      if (lastSessionInfo) send(ws, { t: 'model', model: draftModel() });
      return;
    }

    case 'open_conversation':
      void openConversation(ws, msg.conversationId);
      return;

    case 'prompt': {
      if (!msg.text.trim()) return;
      let id = activeConversationId(ws);
      if (!id) {
        // First prompt of a draft: start a fresh engine session. The id is
        // temporary until the engine's init reports the real session id.
        id = randomUUID();
        const now = Date.now();
        const meta: ConversationMeta = {
          id,
          sessionId: null,
          title: msg.text.slice(0, 60),
          cwd: WORK_DIR,
          createdAt: now,
          updatedAt: now,
        };
        draftMetas.set(id, meta);
        subscribe(ws, id);
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
        saveSelectedModel(msg.model);
        send(ws, { t: 'model', model: msg.model });
      } else {
        pendingModels.delete(ws);
        saveSelectedModel(undefined);
        send(ws, { t: 'model', model: 'default' });
      }
      return;
    }

    case 'suggest_files': {
      const id = activeConversationId(ws);
      const cwd = (id && getMeta(id)?.cwd) || WORK_DIR;
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

function originAllowed(origin: string | undefined, requestHost: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (curl, tests)
  try {
    const url = new URL(origin);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    // Non-loopback binds: accept same-origin only — the page was served from
    // whatever host:port the user browsed to, so its Origin matches the
    // request's Host header; a malicious site's origin won't.
    return requestHost !== undefined && url.host === requestHost;
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/ws' || !originAllowed(req.headers.origin, req.headers.host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  void refreshConversations().then((items) => send(ws, { t: 'conversations', items }));
  // Engine info (slash commands, model) so typeahead works in the draft; the
  // model shown is the user's last selection, which new chats launch on.
  if (lastSessionInfo) {
    send(ws, { ...lastSessionInfo, conversationId: '', model: draftModel() });
  }
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
