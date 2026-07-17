// Global conversation search over Claude Code's session store.
//
// Raw ripgrep over the session JSONL alone would be noisy — lines are JSON
// records full of base64 images, tool outputs, and escape sequences. So the
// pipeline is hybrid:
//   1. ripgrep (when installed and the query is escape-safe) shortlists which
//      session FILES contain the query, at disk speed, without parsing.
//   2. Shortlisted files are parsed into clean user/assistant text segments,
//      cached by mtime, and matched precisely in JS.
// Queries are regex with smart-case, falling back to literal on bad syntax —
// the same feel as rg itself. Repeat searches hit the segment cache.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { findSessionFile, listConversations } from './engineSessions.js';
import type { SearchResult, SearchSnippet } from './protocol.js';

const execFileAsync = promisify(execFile);

const MAX_RESULTS = 30;
const MAX_SNIPPETS_PER_CONV = 3;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 100;

interface Segment {
  role: 'user' | 'assistant';
  text: string;
}

// Extracted segments per session file, invalidated by mtime.
const segmentCache = new Map<string, { mtimeMs: number; segments: Segment[] }>();

let rgAvailable: boolean | null = null;

async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await execFileAsync('rg', ['--version']);
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

interface Matcher {
  regex: RegExp; // global, ready for exec() loops
  /** Pattern/flags rg can prefilter with, or null when raw-JSONL bytes may
   * not contain the same sequence the parsed text does. */
  rg: { pattern: string; fixed: boolean; ignoreCase: boolean } | null;
}

function buildMatcher(query: string): Matcher {
  const ignoreCase = !/[A-Z]/.test(query); // smart case, like rg -S
  const flags = ignoreCase ? 'gi' : 'g';
  // JSON strings escape ", \ and control chars — a query containing them (or
  // non-ASCII, which some writers escape) may look different in the raw bytes
  // than in the parsed text, so rg prefiltering would silently miss files.
  const escapeSafe = /^[ !#-[\]-~]*$/.test(query); // printable ASCII minus " and \
  try {
    return {
      regex: new RegExp(query, flags),
      rg: escapeSafe ? { pattern: query, fixed: false, ignoreCase } : null,
    };
  } catch {
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      regex: new RegExp(literal, flags),
      rg: escapeSafe ? { pattern: query, fixed: true, ignoreCase } : null,
    };
  }
}

/** Files that contain the pattern, per rg; null = prefilter unusable. */
async function rgShortlist(files: string[], m: Matcher): Promise<Set<string> | null> {
  if (!m.rg || files.length === 0 || !(await hasRipgrep())) return null;
  const args = ['-l', '--no-messages', '--no-config'];
  if (m.rg.ignoreCase) args.push('-i');
  if (m.rg.fixed) args.push('-F');
  args.push('--', m.rg.pattern, ...files);
  try {
    const { stdout } = await execFileAsync('rg', args, { maxBuffer: 16 * 1024 * 1024 });
    return new Set(stdout.split('\n').filter(Boolean));
  } catch (err) {
    // Exit 1 = clean "no matches"; anything else (bad pattern for rust's
    // regex, argv too long…) → fall back to scanning everything.
    if ((err as { code?: number }).code === 1) return new Set();
    return null;
  }
}

/** Parse a session JSONL into searchable text segments (mtime-cached).
 * Mirrors readEngineTranscript's filtering: no sidechains, no CLI plumbing,
 * no tool traffic — just what the user reads as the conversation. */
function getSegments(file: string): Segment[] {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const cached = segmentCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.segments;

  const segments: Segment[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: Record<string, any>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.isSidechain || r.isMeta) continue;
    const content = r.message?.content;
    if (r.type === 'user') {
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((b) => b.type === 'text')
                .map((b) => b.text as string)
                .join('\n\n')
            : '';
      if (text && !text.startsWith('<')) segments.push({ role: 'user', text });
    } else if (r.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          segments.push({ role: 'assistant', text: block.text });
        }
      }
    }
  }
  segmentCache.set(file, { mtimeMs, segments });
  return segments;
}

/** Snippet window around a match, with all in-window highlight ranges. */
function makeSnippet(seg: Segment, regex: RegExp, from: number, to: number): SearchSnippet {
  let start = Math.max(0, from - SNIPPET_BEFORE);
  let end = Math.min(seg.text.length, to + SNIPPET_AFTER);
  // Snap to whitespace so words aren't cut mid-glyph (bounded look-around).
  while (start > 0 && start > from - SNIPPET_BEFORE - 20 && !/\s/.test(seg.text[start - 1])) start--;
  while (end < seg.text.length && end < to + SNIPPET_AFTER + 20 && !/\s/.test(seg.text[end])) end++;

  const prefix = start > 0 ? '…' : '';
  const suffix = end < seg.text.length ? '…' : '';
  const window = seg.text.slice(start, end).replace(/\s+/g, ' ');

  // Re-find matches inside the normalized window for accurate offsets.
  const ranges: Array<[number, number]> = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(window)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    ranges.push([prefix.length + m.index, prefix.length + m.index + m[0].length]);
  }
  return { role: seg.role, text: prefix + window + suffix, ranges };
}

export async function searchConversations(dir: string, query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const matcher = buildMatcher(query);

  // Most-recent first, so result order (and the MAX_RESULTS cut) is recency.
  const conversations = (await listConversations(dir)).sort((a, b) => b.updatedAt - a.updatedAt);
  const files = new Map<string, string>(); // sessionId → file
  for (const c of conversations) {
    const file = findSessionFile(c.id);
    if (file) files.set(c.id, file);
  }

  const shortlist = await rgShortlist([...files.values()], matcher);

  const results: SearchResult[] = [];
  for (const conv of conversations) {
    if (results.length >= MAX_RESULTS) break;
    const file = files.get(conv.id);
    if (!file || (shortlist && !shortlist.has(file))) continue;

    let matchCount = 0;
    const snippets: SearchSnippet[] = [];
    for (const seg of getSegments(file)) {
      matcher.regex.lastIndex = 0;
      // Matches falling inside the previous snippet's window are already
      // highlighted there — count them, don't mint a duplicate snippet.
      let coveredUntil = -1;
      let m: RegExpExecArray | null;
      while ((m = matcher.regex.exec(seg.text)) !== null) {
        if (m[0].length === 0) {
          matcher.regex.lastIndex++;
          continue;
        }
        matchCount++;
        if (snippets.length < MAX_SNIPPETS_PER_CONV && m.index >= coveredUntil) {
          snippets.push(makeSnippet(seg, new RegExp(matcher.regex), m.index, m.index + m[0].length));
          coveredUntil = m.index + m[0].length + SNIPPET_AFTER + 20;
        }
      }
    }
    if (matchCount > 0) {
      results.push({
        id: conv.id,
        title: conv.title,
        updatedAt: conv.updatedAt,
        matchCount,
        snippets,
      });
    }
  }
  return results;
}
