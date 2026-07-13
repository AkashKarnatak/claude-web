// The sidebar's source of truth: Claude Code's OWN session store for the
// working directory — the same list `claude --resume` shows. Session
// metadata comes from the SDK's listSessions(); transcript display comes
// from parsing the engine's session JSONL under ~/.claude/projects/.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationMeta, PromptImage, ServerMsg } from './protocol.js';

export async function listConversations(dir: string): Promise<ConversationMeta[]> {
  const sessions = await listSessions({ dir });
  return sessions.map((s) => ({
    id: s.sessionId,
    sessionId: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || 'Untitled session',
    cwd: s.cwd || dir,
    createdAt: s.createdAt ?? s.lastModified,
    updatedAt: s.lastModified,
  }));
}

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Locate a session file without relying on the CLI's path-munging scheme. */
function findSessionFile(sessionId: string): string | null {
  const name = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(PROJECTS_DIR, dir, `${name}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Parse the engine's session JSONL into wire messages for history replay.
 * Records are one content block per line; subagent traffic (isSidechain) and
 * meta records are skipped, matching what the TUI transcript shows.
 */
export function readEngineTranscript(sessionId: string): {
  messages: ServerMsg[];
  lastModel: string | null;
} {
  const file = findSessionFile(sessionId);
  if (!file) return { messages: [], lastModel: null };
  const out: ServerMsg[] = [];
  let lastModel: string | null = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, any>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // Assistant records carry the API model that produced them — the last
    // one is the model this session is currently on (resume restores it).
    if (record.type === 'assistant' && !record.isSidechain && record.message?.model) {
      lastModel = record.message.model;
    }
    mapRecord(record, out);
  }
  return { messages: out, lastModel };
}

function mapRecord(r: Record<string, any>, out: ServerMsg[]): void {
  if (r.isSidechain || r.isMeta) return;

  if (r.type === 'user') {
    const content = r.message?.content;
    if (typeof content === 'string') {
      pushUserPrompt(out, content);
    } else if (Array.isArray(content)) {
      const text = content
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('\n\n');
      // Pasted images (from the web UI or the TUI) are base64 image blocks.
      const images: PromptImage[] = content
        .filter((b) => b.type === 'image' && b.source?.type === 'base64')
        .map((b) => ({ mediaType: b.source.media_type as string, data: b.source.data as string }));
      pushUserPrompt(out, text, images);
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        out.push({
          t: 'tool_result',
          id: randomUUID(),
          forToolId: block.tool_use_id,
          output: block.content ?? '',
          isError: block.is_error ?? false,
        });
      }
    }
    return;
  }

  if (r.type === 'assistant') {
    const content = r.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        out.push({ t: 'assistant_end', id: r.uuid ?? randomUUID(), markdown: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        const id = randomUUID();
        out.push({ t: 'thinking_start', id });
        out.push({ t: 'thinking_delta', id, text: block.thinking });
        out.push({ t: 'thinking_end', id });
      } else if (block.type === 'tool_use') {
        out.push({ t: 'tool_use', id: block.id, name: block.name, input: block.input, status: 'running' });
      }
    }
  }
}

function pushUserPrompt(out: ServerMsg[], text: string, images: PromptImage[] = []): void {
  // Tagged content (<local-command-…>, <command-name>, <system-reminder>…)
  // is CLI plumbing the TUI hides too.
  if (text.startsWith('<')) return;
  if (!text && images.length === 0) return;
  out.push({
    t: 'user_prompt',
    id: randomUUID(),
    text,
    ...(images.length ? { images } : {}),
  });
}
