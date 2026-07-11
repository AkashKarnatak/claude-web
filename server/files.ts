// File listing + fuzzy matching for @-mention typeahead. Mirrors the TUI's
// file suggestions (bounded walk, fuzzy subsequence scoring, top-N).

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'target',
]);

const MAX_FILES = 5000;
const MAX_DEPTH = 8;
const CACHE_TTL_MS = 10_000;
const MAX_RESULTS = 15;

const cache = new Map<string, { at: number; files: string[] }>();

function walk(root: string): string[] {
  const files: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        files.push(path.relative(root, full));
      }
    }
  }
  return files;
}

function listFiles(root: string): string[] {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.files;
  const files = walk(root);
  cache.set(root, { at: Date.now(), files });
  return files;
}

/**
 * Subsequence fuzzy score; lower is better, null = no match. Contiguous runs
 * and basename matches rank higher, like the TUI's nucleo-style scoring.
 */
function fuzzyScore(query: string, candidate: string): number | null {
  if (!query) return candidate.length;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const base = path.basename(c);
  if (base.startsWith(q)) return 0 + candidate.length / 1000;
  if (base.includes(q)) return 1 + candidate.length / 1000;
  if (c.includes(q)) return 2 + candidate.length / 1000;
  // subsequence match
  let qi = 0;
  let gaps = 0;
  let last = -2;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      if (ci !== last + 1) gaps++;
      last = ci;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return 3 + gaps + candidate.length / 1000;
}

export function suggestFiles(root: string, query: string): string[] {
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of listFiles(root)) {
    const score = fuzzyScore(query, file);
    if (score !== null) scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, MAX_RESULTS).map((s) => s.file);
}
