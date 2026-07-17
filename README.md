# claude-web

A local web app that runs **Claude Code** programmatically and renders its output
beautifully in the browser — full Markdown, LaTeX math (KaTeX), syntax-highlighted
code, and rich tool-call cards. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
full design; this implements it end to end.

- **Backend** (`server/`): Node + TypeScript. Drives the Claude Code engine via
  `@anthropic-ai/claude-agent-sdk` (`query()` with a streaming-input session),
  normalizes engine events into a small stable wire protocol, and serves it over
  a WebSocket bound to **127.0.0.1 only**. Interactive tool permissions go
  through `canUseTool` → an in-browser Allow/Deny prompt. The sidebar lists
  Claude Code's OWN sessions for `WORK_DIR` (the same history `claude
  --resume` shows); opening a chat parses the engine's session JSONL from
  `~/.claude/projects/` — terminal and web chats share one history.
- **Frontend** (`web/`): React + Vite + Zustand. `react-markdown` + `remark-gfm` +
  `remark-math` + `rehype-katex` + `rehype-highlight`, token-level streaming with
  per-animation-frame batching, tool cards with diffs for edits, a thinking
  panel, permission modal, per-turn usage/cost footer, light/dark themes.

TUI-parity extras:

- **Spinner status line** while the agent works: a whimsical verb sampled per
  turn (the TUI's own list), elapsed time, live output-token counter, current
  activity/tool, and `esc to interrupt` (Esc actually interrupts).
- **Permission-mode cycling**: `Shift+Tab` cycles
  `default → accept edits → plan → auto` (plus `bypass permissions` when the
  server is launched with `ALLOW_BYPASS=true`), with the TUI-style colored
  indicator under the input (`⏵⏵ accept edits on`, `⏸ plan mode on`, …).
- **Typeahead**: `/` at the start suggests the engine's slash commands; `@token`
  anywhere suggests project files (fuzzy-matched server-side); ↑/↓ navigate,
  Tab/Enter accept, Esc dismisses. ↑ on an empty input recalls prompt history.
- **Interactive questions**: when Claude uses `AskUserQuestion`, the prompt
  above the input renders the actual question(s) — options with descriptions,
  multi-select checkboxes, previews, and a free-text "Other" — instead of a
  bare Allow/Deny. Arrow keys + Enter, number keys for quick select, Esc
  dismisses. Answers flow back through the permission round-trip
  (`updatedInput.answers`), the same contract the TUI picker fulfills.
- **Conversation search**: Ctrl+K (or the magnifier in the sidebar) opens a
  centered search palette over all of the project's chats. Queries are regex
  with smart-case (literal fallback), like ripgrep — which is also what powers
  it: `rg` shortlists session files at disk speed, then only those are parsed
  (and mtime-cached) for precise, highlighted user/assistant snippets.
- **Image paste/drop**: Ctrl+V a screenshot or drag image files onto the page —
  each becomes an `[Image #N]` token in the text plus a thumbnail chip (× to
  remove), and is sent to the engine as an API image block so Claude can see it.
  Oversized images are downscaled client-side to the API's 1568px optimum.
  Images pasted in the terminal show up in web history too (and vice versa).

## Setup

```bash
npm install
cp .env.example .env   # put your ANTHROPIC_API_KEY in .env
```

The API key lives only in the backend environment; the browser never sees it.

## Run

Development (Vite dev server + backend, WebSocket proxied):

```bash
npm run dev            # UI on http://127.0.0.1:5173, backend on :8787
```

Production (backend serves the built frontend):

```bash
npm start              # builds web/dist, serves http://127.0.0.1:8787
```

## Configuration (.env)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required) | Engine authentication |
| `PORT` | `8787` | Server port |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback values require token auth (see `AUTH_TOKEN`) |
| `AUTH_TOKEN` | generated | Access token required by non-loopback binds; auto-generated to `data/auth-token` if unset. Localhost binds skip auth entirely |
| `WORK_DIR` | project dir | Directory the agent operates in |
| `PERMISSION_MODE` | `default` | `default` \| `acceptEdits` \| `plan` \| `auto` \| `bypassPermissions` |
| `ALLOW_BYPASS` | `false` | Launch sessions with `--dangerously-skip-permissions` so the `bypassPermissions` mode can be switched on from the UI |
| `DATA_DIR` | `./data` | Cache location (engine info for instant typeahead) |
| `MODEL` | engine default | Model override |
| `ALLOWED_TOOLS` / `DISALLOWED_TOOLS` | — | Comma-separated tool gating |

## Notes

- The server binds `127.0.0.1` and rejects WebSocket upgrades from non-localhost
  origins. It is not designed to be exposed to a network.
- Sessions resume across restarts: the engine `session_id` is stored per
  conversation and passed back via `options.resume`.
- Requires Node 20.x (Vite 6 is pinned for Node ≤ 20.12 compatibility).
