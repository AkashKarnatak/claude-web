# claude-web — Architecture

A local web application that runs **Claude Code** programmatically and renders its
output beautifully in the browser — full Markdown, LaTeX math, syntax-highlighted
code, and rich tool-call cards — the way a polished web chat UI looks, rather than
a raw terminal.

This document is the single source of truth for building the project. It is written
to be handed to an implementing agent with no other context. Read it top to bottom
before writing code.

---

## 1. Goal and intent

Claude Code normally runs as an interactive terminal program (a TUI). Its output on
screen is a stream of text and ANSI escape codes painted into a terminal emulator.
That is great for a terminal, but it means:

- Markdown is flattened into terminal styling (bold via ANSI, tables via box-drawing
  characters `┌─┬─┐`, etc.).
- LaTeX/math is not rendered at all.
- To view it "nicely" you would have to copy the terminal text and reverse-engineer
  the original Markdown out of it — a lossy, fragile process.

**We want the opposite flow.** Instead of scraping rendered terminal output, we get
the *structured source* that Claude Code produces internally — the raw Markdown text
of each assistant message and typed events for every tool call — and render *that*
in the browser with a real Markdown + math + code pipeline.

The result should feel like a first-class web chat client for Claude Code, running
entirely on the user's own machine against their own API key.

### Non-goals

- Not a terminal emulator in the browser. We are **not** mirroring the TUI byte
  stream through something like xterm.js. (That would reproduce the terminal look
  and re-create the exact problem we are solving.)
- Not a hosted/multi-tenant service. This is a local, single-user tool. Network
  exposure and multi-user auth are explicitly out of scope (see §11).
- Not a reimplementation of Claude Code. We drive the official Claude Code engine as
  a subprocess/library; we only build the transport and the UI.

---

## 2. The core insight (read this first)

There are two possible sources of "Claude Code output," and choosing the right one
determines the entire architecture.

| Source | What you get | Suitable for rich rendering? |
|---|---|---|
| **A. TUI byte stream** (PTY → ANSI escape codes) | Text already painted for a terminal: box-drawing tables, ANSI color codes, cursor moves, full-screen redraws. | **No.** You must parse ANSI and guess the original structure. Lossy and brittle. |
| **B. Structured programmatic output** (headless mode / SDK) | Typed JSON events: assistant messages as **raw Markdown strings**, tool calls as structured `tool_use` objects, tool results as structured objects, token usage, cost. | **Yes.** This is exactly what a rich renderer needs. |

**We use Source B.** Claude Code exposes a headless/programmatic mode whose job is to
emit structured events rather than paint a terminal. The assistant's message text
arrives as the *original Markdown* Claude wrote (including `$...$` math and pipe
tables), not as terminal-rendered output. This eliminates every hack that a
paste-and-reparse approach requires:

- No box-drawing-table → Markdown-table conversion. The source already contains real
  Markdown pipe tables.
- No ANSI stripping.
- No copy-paste. The stream arrives live over a socket.
- No guessing where a tool call started/ended. Tool calls are discrete typed events.

Everything below assumes Source B.

---

## 3. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                              User's machine                            │
│                                                                        │
│   Browser (localhost)                    Backend (Node/Bun, localhost) │
│   ┌────────────────────┐                 ┌──────────────────────────┐  │
│   │  Web UI (React)    │                 │   Agent runner            │  │
│   │                    │   WebSocket     │   ┌────────────────────┐  │  │
│   │  - message list    │◀───────────────▶│   │ Claude Code engine │  │  │
│   │  - markdown/latex  │  structured     │   │ (Agent SDK OR      │  │  │
│   │    renderer        │  events + input │   │  headless CLI)     │  │  │
│   │  - tool cards      │                 │   └─────────┬──────────┘  │  │
│   │  - prompt input    │                 │             │ ANTHROPIC_   │  │
│   │  - permission UI   │                 │             │ API_KEY      │  │
│   └────────────────────┘                 └─────────────┼────────────┘  │
│                                                         │               │
└─────────────────────────────────────────────────────────┼─────────────┘
                                                            ▼
                                                  Anthropic API (inference)
```

Three layers:

1. **Agent runner (backend).** Owns the Claude Code engine, holds the API key, turns
   the engine's structured events into a clean wire protocol, and relays user input,
   permission decisions, and interrupts back into the engine.
2. **Transport.** A WebSocket between backend and browser carrying our normalized
   message protocol (§6) in both directions.
3. **Web UI (frontend).** Renders each typed event with the right component and
   provides the chat/prompt/permission interaction surface.

The API key lives **only** in the backend process environment. The browser never
sees it.

---

## 4. Driving the Claude Code engine

There are two supported ways to run Claude Code programmatically. Prefer Option 1.

### Option 1 (recommended): the Claude Agent SDK

- **Package (TypeScript/Node):** `@anthropic-ai/claude-agent-sdk`
- **Package (Python):** `claude-agent-sdk` (Python 3.10+), if the backend is Python.

The SDK exposes a `query()` function that returns an async iterator of typed
messages. This is the cleanest integration: no subprocess parsing, typed events,
first-class session/permission/interrupt controls.

TypeScript shape (verify exact types against the installed SDK version):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const session = query({
  // A plain string for a one-shot prompt, OR an AsyncIterable<SDKUserMessage>
  // for a persistent, multi-turn streaming-input session (preferred for chat).
  prompt: promptStream,
  options: {
    // System prompt: use Claude Code's own preset so behavior matches the CLI.
    systemPrompt: { type: "preset", preset: "claude_code" },

    // Permission handling — see §8.
    permissionMode: "default",                 // 'default'|'acceptEdits'|'plan'|'bypassPermissions'|...
    canUseTool: async (toolName, input) => {   // async approval callback
      // Forward to the browser, await the user's decision, return it.
      return { behavior: "allow", updatedInput: input };
      // or { behavior: "deny", message: "..." }
    },

    // Optional tool gating
    allowedTools: [/* "Read", "Edit", "Bash", ... */],
    disallowedTools: [],

    // Token-level streaming of assistant text (see §7).
    includePartialMessages: true,

    // Session continuity (see §9).
    resume: existingSessionId,   // omit to start fresh

    // Working directory the agent operates in.
    cwd: projectDir,

    // model, mcpServers, hooks, etc. as needed.
  },
});

for await (const message of session) {
  // message.type is one of: "system" | "assistant" | "user" |
  // "stream_event" | "result" | ... (see §5)
  handleEngineMessage(message);
}
```

Useful runtime controls on the returned object (names may vary by version — check the
SDK's exported types):

- `session.interrupt()` — stop the current turn (wire to a Stop button).
- `session.setPermissionMode(mode)` — change permission mode mid-session.
- `session.setModel(model?)` — switch models.
- `session.close()` — tear down.

**Multi-turn chat:** pass `prompt` as an `AsyncIterable` you control (e.g. an async
queue). Push a new `SDKUserMessage` each time the user sends a prompt; the same
iterator/session stays alive, preserving context without re-`resume`ing every turn.

### Option 2 (fallback): headless CLI, stream-json

If you cannot use the SDK, spawn the `claude` binary in headless mode and parse its
newline-delimited JSON.

```bash
claude -p \
  --output-format stream-json \
  --input-format stream-json \
  --include-partial-messages \
  --verbose \
  --permission-mode default
```

- `-p` / `--print`: non-interactive.
- `--output-format stream-json`: emit one JSON object per line (an event stream).
- `--input-format stream-json`: read newline-delimited JSON user messages from stdin,
  keeping the process alive for multi-turn input.
- `--include-partial-messages`: emit token-level deltas (§7).
- `--verbose`: include the detailed event stream.
- Session resume: `--resume <SESSION_ID>` or `--continue` (most recent).
- Permissions: `--permission-mode`, `--allowedTools "Tool1,Tool2"`. Note that the
  rich `canUseTool` callback (interactive per-tool approval) is an SDK feature; the
  CLI relies on pre-approval flags and permission modes. If you want interactive
  in-browser approval prompts, prefer the SDK.

The backend reads the child's stdout line by line, `JSON.parse`s each line, and maps
it to the wire protocol (§6). User prompts are written to the child's stdin as JSON
lines. Guard against stdout lines split across chunk boundaries (buffer until `\n`).
Stdin has a size cap (on the order of 10 MB per message); chunk very large inputs.

**Trade-off summary:** SDK = typed events, interactive permission callback, cleaner
lifecycle. CLI = no extra dependency, but you parse JSON yourself and lose the
interactive `canUseTool` ergonomics.

---

## 5. Engine event model (what the engine emits)

Whether via SDK messages or CLI stream-json lines, the engine emits a sequence of
typed events. The important types for rendering:

- **`system` / subtype `init`** — session bootstrap. Carries `session_id`, `model`,
  available `tools`, MCP servers, etc. **Capture `session_id` here** for resume (§9).
- **`assistant`** — a complete assistant message. Its content is the **raw Markdown**
  the model produced, plus any `tool_use` blocks. This is the primary thing to render.
- **`stream_event`** — low-level streaming deltas (only when partial messages are
  enabled). Wraps raw Claude API streaming events:
  - `content_block_start` — a text block or a `tool_use` block begins.
  - `content_block_delta` with `delta.type === "text_delta"` → `delta.text` is a token
    chunk of assistant Markdown. Accumulate these for live typing.
  - `content_block_delta` with `delta.type === "input_json_delta"` → `delta.partial_json`
    is a chunk of a tool call's JSON input. Accumulate to reconstruct tool args.
  - `content_block_stop`, `message_delta`, `message_stop` — boundaries.
- **`user`** — tool results fed back into the model (the output of a tool the engine
  ran), and echoes of user input. Tool results are structured — render them as
  result/diff cards, not raw text.
- **`result`** — end of a turn. Carries final `result` text, `session_id`, token
  counts, and `total_cost_usd`. Use for the per-turn usage/cost footer.

Notes:
- Streaming is **token-level** for text (`text_delta`) and for tool inputs
  (`input_json_delta`). A single assistant response is one logical message assembled
  from many deltas; tools execute *between* turns.
- Treat these exact field names as representative and verify against the installed
  SDK's exported TypeScript types (or the headless docs) at build time — schemas can
  evolve between versions. The **shape** (init → streamed assistant text → tool_use →
  tool_result → result) is stable; specific field names should be pinned to the
  version you build against.

---

## 6. Wire protocol (backend ↔ browser)

Do **not** forward raw engine events to the browser. Normalize them into a small,
stable protocol so the frontend is decoupled from engine-version quirks. Suggested
message envelope (JSON over WebSocket):

### Server → client

```ts
type ServerMsg =
  | { t: "session";      sessionId: string; model: string; tools: string[] }
  | { t: "assistant_start"; id: string }                       // new assistant msg begins
  | { t: "assistant_delta"; id: string; text: string }         // append Markdown tokens
  | { t: "assistant_end";   id: string; markdown: string }     // final canonical Markdown
  | { t: "thinking_delta";  id: string; text: string }         // extended-thinking stream (optional)
  | { t: "tool_use";     id: string; name: string; input: unknown; status: "running" }
  | { t: "tool_result";  id: string; forToolId: string; output: unknown; isError: boolean }
  | { t: "permission_request"; reqId: string; tool: string; input: unknown; explanation?: string }
  | { t: "result";       turnId: string; usage: Usage; costUsd: number }
  | { t: "error";        message: string }
  | { t: "status";       state: "idle" | "thinking" | "running_tool" };
```

### Client → server

```ts
type ClientMsg =
  | { t: "prompt";     text: string }                          // user sends a message
  | { t: "permission"; reqId: string; decision: "allow" | "deny"; updatedInput?: unknown; reason?: string }
  | { t: "interrupt" }                                          // stop current turn
  | { t: "set_mode";   mode: string }                          // change permission mode
  | { t: "set_model";  model?: string };
```

The backend maintains the mapping between engine tool-use IDs and our `id`s, buffers
`text_delta`s into `assistant_delta` messages, and emits `assistant_end` with the
fully assembled Markdown so the client can replace its incrementally-built copy with
a canonical one (avoids drift from dropped frames).

**Transport choice:** WebSocket (bidirectional) is required because we need
client→server input (prompts, permission decisions, interrupts) *and* live
server→client streaming. SSE + POST could work but is clumsier for interrupts and
permission round-trips; use WebSocket.

---

## 7. Streaming strategy

Enable token-level streaming (`includePartialMessages` / `--include-partial-messages`)
so text appears as it is generated.

- The backend accumulates `text_delta` chunks and forwards them as `assistant_delta`.
- The frontend appends deltas to the current message's Markdown buffer and re-renders.

**Rendering incrementally.** Re-parsing the whole Markdown string on every token is
fine for typical message sizes and is the simplest correct approach. Optimizations if
needed later:
- Debounce re-render to animation frames (e.g. render at most once per rAF).
- Only re-render the last/streaming message; completed messages are static.
- Keep completed messages memoized so React does not re-render them on each token.

**Partial Markdown is messy.** Mid-stream you will have unbalanced code fences,
half-written tables, and incomplete `$...$`. Choose a policy:
- Simplest: render partial Markdown as-is; it self-corrects as more tokens arrive.
- Nicer: while streaming, if an odd number of ``` fences is present, treat the tail as
  an open code block; render math only after the message completes (or on balanced
  delimiters). Replace with the canonical parse on `assistant_end`.

---

## 8. Permissions and interaction

Claude Code asks for permission before running sensitive tools (editing files,
running shell commands, etc.). In a web UI this becomes an in-browser prompt.

- With the **SDK**, provide a `canUseTool(toolName, input)` callback. When the engine
  calls it, the backend emits a `permission_request` to the browser, shows a modal
  ("Claude wants to run `Bash`: `rm -rf build/` — Allow / Deny"), and awaits the
  user's `permission` reply. Resolve the callback with
  `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }`.
- **Permission modes** set the baseline:
  - `default` — ask for risky actions.
  - `acceptEdits` — auto-approve file edits, still gate shell/other.
  - `plan` — planning only, no mutations.
  - `bypassPermissions` — approve everything (dangerous; only for trusted, sandboxed
    dirs — see §11).
  Expose a mode selector in the UI (`set_mode`).
- **Interrupt.** Wire a Stop button to `session.interrupt()` (SDK) so the user can
  halt a long turn. Emit a `status` change back.
- **Tool gating.** `allowedTools` / `disallowedTools` let you restrict which tools are
  even available (e.g. a read-only viewer that disallows `Bash`/`Edit`).

---

## 9. Sessions and conversation model

- **Capture** `session_id` from the `system/init` event and store it per conversation.
- **Multi-turn within a live session:** the preferred pattern is a single long-lived
  `query()` with a streaming-input `AsyncIterable` prompt (§4, Option 1). Push each
  user turn as a new message; context is retained automatically.
- **Resume across restarts:** to continue a conversation after the backend or browser
  restarts, start a new `query()` with `options.resume = savedSessionId` (SDK) or
  `--resume <id>` (CLI). `--continue` resumes the most recent session.
- **Persistence:** store a small record per conversation locally (JSON file or SQLite):
  `{ id, sessionId, title, cwd, createdAt, updatedAt }`, plus the rendered message log
  if you want history to survive reloads. The engine also persists its own session
  state; ours is for the UI's conversation list and titles.

---

## 10. The rendering pipeline (the heart of the UI)

This is what makes the project worth building. Each wire message type maps to a
component; the assistant text path is the rich one.

### 10.1 Message-type → component map

| Wire message | Rendered as |
|---|---|
| `assistant_delta` / `assistant_end` | Markdown block (see 10.2) |
| `thinking_delta` | Collapsible, dimmed "thinking" panel |
| `tool_use` | Tool card: tool name, pretty-printed input, running spinner |
| `tool_result` | Collapsible result under its tool card; diffs for edits, output for Bash |
| `permission_request` | Modal / inline approval card with Allow / Deny |
| `result` | Small footer: tokens in/out, cost, duration |
| `error` | Error banner |

### 10.2 Markdown + LaTeX + code pipeline

Use a real AST-based Markdown renderer, not regex string surgery. Recommended stack
(React):

- **`react-markdown`** — Markdown → React elements via an mdast/hast pipeline.
- **`remark-gfm`** — GitHub-flavored Markdown: real pipe tables, task lists,
  strikethrough, autolinks. **This is why we get proper tables for free** — the source
  already contains pipe tables, so no box-drawing conversion is ever needed.
- **`remark-math`** — parses `$...$` (inline) and `$$...$$` (display) math into math
  nodes.
- **`rehype-katex`** — renders math nodes to HTML using **KaTeX** (include KaTeX CSS).
- **Code highlighting** — **Shiki** (VS Code-grade, matches the look of Claude's web
  UI) via a rehype integration, or `rehype-highlight`/`highlight.js` for a lighter
  dependency. Shiki is heavier but produces the nicest, theme-consistent output.

Pipeline order matters: `remark-gfm` + `remark-math` at the remark (mdast) stage, then
`rehype-katex` + syntax highlighting at the rehype (hast) stage.

**LaTeX delimiter coverage.** `remark-math` handles `$...$` and `$$...$$` out of the
box. Claude also sometimes emits `\( ... \)` and `\[ ... \]`. To support those either:
- add a small remark plugin / preprocessing step that converts `\(...\)` → `$...$` and
  `\[...\]` → `$$...$$` before `remark-math`, or
- use a math plugin variant configured to accept those delimiters.
Do the conversion on the AST or on protected text, not naively, to avoid touching
code blocks.

**Single-`$` vs. currency.** Because the source is real Markdown (not terminal text),
prefer letting `remark-math` handle `$` disambiguation rather than custom regex. If
false positives appear (e.g. "it costs $5 and $10"), consider requiring `$$` for
display math and treating lone `$` conservatively, or gate inline `$` math behind the
known conventions Claude uses. Test with real transcripts.

**Sanitization.** react-markdown does not render raw HTML unless you opt in. Keep raw
HTML disabled (default) for safety, or if you enable it, run `rehype-sanitize`. KaTeX
output is trusted; set KaTeX `throwOnError: false` so a bad expression degrades to
visible source instead of crashing the render.

### 10.3 Tool cards

Render each `tool_use` as a distinct card so the transcript reads like the web client:

- **Header:** tool name + concise summary of the action (e.g. `Edit  src/app.ts`,
  `Bash  npm test`).
- **Input:** pretty-printed, syntax-highlighted arguments. For file edits, show a
  diff view (old/new) rather than raw JSON. For `Bash`, show the command.
- **Result** (`tool_result`): collapsible. Bash → terminal-style output block
  (this is the *one* place a monospace/ANSI-ish look is appropriate). File reads →
  syntax-highlighted code with a line range. Edits → a diff with additions/deletions.
- **Status:** running spinner → success/error state.

### 10.4 Visual design

Aim for the clean, readable feel of a modern web chat client: comfortable line length
for prose, distinct styling for assistant prose vs. tool activity, light/dark themes
(follow `prefers-color-scheme`), and code/tool blocks visually separated from prose.
Keep prose in a proportional font and only code/tool-output in monospace.

---

## 11. Security

This is a local tool, but it drives an agent that can read files and run commands.
Treat that seriously.

- **Bind to localhost only.** The backend HTTP/WebSocket server must listen on
  `127.0.0.1`, never `0.0.0.0`. Do not expose it to the network. If remote access is
  ever wanted, that is a separate design with real authentication and is out of scope
  here.
- **API key stays server-side.** Read `ANTHROPIC_API_KEY` from the backend
  environment. Never send it to the browser or embed it in frontend code.
- **The agent can execute code.** Any tool that runs `Bash` or edits files acts with
  the privileges of the backend process. Constrain the working directory (`cwd`),
  consider `allowedTools`/`disallowedTools`, and default to a permission mode that
  asks before mutations. Reserve `bypassPermissions` for throwaway/sandboxed dirs.
- **Origin checks.** Verify the WebSocket `Origin` header matches the local UI origin
  to blunt cross-site WebSocket hijacking from a malicious page in the same browser.
- **Do not log the API key** or full environment in debug output.

---

## 12. Authentication / configuration

The engine authenticates to Anthropic via environment, in this precedence (simplified):

1. Cloud provider routing (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, …) if set.
2. `ANTHROPIC_AUTH_TOKEN` (bearer, for gateways/proxies).
3. **`ANTHROPIC_API_KEY`** (Console API key, sent as `X-Api-Key`). In headless/SDK use
   this is picked up automatically when present — **this is the expected path for this
   project.**
4. `apiKeyHelper` script (dynamic/rotating creds).
5. `CLAUDE_CODE_OAUTH_TOKEN` / subscription OAuth (requires a paid plan).

For this project: set `ANTHROPIC_API_KEY` in the backend environment. No interactive
login, no subscription required. Keep all config in backend env / a local `.env` that
is git-ignored.

Config surface to support:
- `ANTHROPIC_API_KEY` (required)
- `PORT` (localhost port for the server)
- `WORK_DIR` / per-conversation `cwd` (where the agent operates)
- default `permissionMode`, `allowedTools`/`disallowedTools`
- `model`

---

## 13. Recommended tech stack

- **Backend:** Node.js or Bun + TypeScript. Use `@anthropic-ai/claude-agent-sdk`
  (Option 1). HTTP + WebSocket via a minimal server (`ws` for the socket; any small
  HTTP framework or the built-in server for static assets + health).
- **Frontend:** React + TypeScript. Vite or Next.js.
  - `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` (+ KaTeX CSS).
  - Shiki (or `rehype-highlight`) for code.
  - A small state store (e.g. Zustand) for the conversation/message list.
- **Persistence:** a local JSON file or SQLite for the conversation list + transcripts.
- **Python alternative:** if the backend must be Python, use `claude-agent-sdk`
  (Python) with the same event model; the frontend is unchanged.

---

## 14. Suggested project structure

```
claude-web/
  ARCHITECTURE.md            ← this file
  package.json
  .env                       ← ANTHROPIC_API_KEY, PORT (git-ignored)
  server/
    index.ts                 ← HTTP + WebSocket bootstrap (localhost only)
    agent.ts                 ← wraps Agent SDK query(); lifecycle, interrupt, resume
    protocol.ts              ← ServerMsg/ClientMsg types + engine→wire mapping
    permissions.ts           ← canUseTool → permission_request round-trip
    sessions.ts              ← session store (id, sessionId, title, cwd, transcript)
  web/
    src/
      App.tsx
      ws.ts                  ← WebSocket client, dispatch to store
      store.ts               ← conversation + streaming message state
      components/
        MessageList.tsx
        AssistantMessage.tsx ← the markdown/latex/code pipeline
        Markdown.tsx         ← react-markdown config (gfm + math + katex + shiki)
        ThinkingPanel.tsx
        ToolCard.tsx
        ToolResult.tsx       ← diffs, bash output, file reads
        PermissionModal.tsx
        PromptInput.tsx
        UsageFooter.tsx
    index.html
```

---

## 15. Build phases (suggested milestones)

1. **Spike the engine.** Backend script that runs `query()` with a hardcoded prompt,
   `includePartialMessages: true`, and logs every event type to understand the real
   schema of the installed SDK version. Pin field names from this.
2. **Wire protocol + WebSocket.** Backend maps engine events → `ServerMsg`; a trivial
   HTML page logs them. Prove streaming text and tool events arrive.
3. **Markdown pipeline.** Build `Markdown.tsx` (gfm + math + katex + code). Validate
   against real transcripts containing tables, math, and code. This is where the
   `rendercc` prototype's rendering goals are fully realized — but now fed clean
   source, so no box-table/ANSI hacks are needed.
4. **Chat loop.** Prompt input → `prompt` message → streaming assistant render →
   `result` footer. Multi-turn via streaming-input session.
5. **Tool cards + results.** Render `tool_use`/`tool_result` as rich cards; diffs for
   edits, output for Bash.
6. **Permissions + interrupt.** `permission_request` modal round-trip; Stop button.
7. **Sessions + persistence.** Conversation list, resume, titles, transcript history.
8. **Polish.** Themes, incremental-render performance, error states, config UI.

---

## 16. Key risks / edge cases

- **Schema drift.** Engine event field names can change across versions. Isolate all
  engine-specific parsing in `protocol.ts`; the frontend only ever sees our stable
  wire protocol. Pin the SDK version and re-verify on upgrade (Phase 1 spike).
- **Partial-Markdown flicker.** Streaming produces transiently invalid Markdown; use
  the `assistant_end` canonical parse to settle (§7).
- **Math false positives.** Currency `$` vs. inline math; test on real output (§10.2).
- **Large tool outputs.** Bash/read results can be huge; make result cards collapsible
  and virtualize or truncate very long outputs.
- **Ordering.** Tool results arrive after their tool_use; keep an id map so results
  attach to the correct card even when multiple tools run in a turn.
- **Backpressure.** Fast token streams can flood the socket/UI; batch deltas per
  animation frame.

---

## 17. Reference documentation

- Headless mode (CLI, stream-json): https://code.claude.com/docs/en/headless.md
- Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview.md
- Agent SDK — TypeScript reference: https://code.claude.com/docs/en/agent-sdk/typescript.md
- Agent SDK — Python reference: https://code.claude.com/docs/en/agent-sdk/python.md
- Agent SDK — streaming output: https://code.claude.com/docs/en/agent-sdk/streaming-output.md
- Sessions: https://code.claude.com/docs/en/sessions.md
- Authentication: https://code.claude.com/docs/en/authentication.md
- Rendering libs: react-markdown, remark-gfm, remark-math, rehype-katex, KaTeX, Shiki.

Always verify exact SDK identifiers, option names, and event field names against the
version you install (Phase 1 spike) — treat the shapes in this document as the design
contract and the specific names as version-pinned details.
