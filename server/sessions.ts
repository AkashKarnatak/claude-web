// Local persistence for the UI's conversation list and transcripts
// (ARCHITECTURE.md §9). The engine persists its own session state; this is
// only what the sidebar and history replay need.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConversationMeta, ServerMsg } from './protocol.js';

export class ConversationStore {
  private indexFile: string;
  private transcriptsDir: string;
  private conversations: ConversationMeta[] = [];

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.indexFile = path.join(dataDir, 'conversations.json');
    this.transcriptsDir = path.join(dataDir, 'transcripts');
    fs.mkdirSync(this.transcriptsDir, { recursive: true });
    if (fs.existsSync(this.indexFile)) {
      try {
        this.conversations = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      } catch {
        this.conversations = [];
      }
    }
  }

  list(): ConversationMeta[] {
    return [...this.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): ConversationMeta | undefined {
    return this.conversations.find((c) => c.id === id);
  }

  create(cwd: string): ConversationMeta {
    const now = Date.now();
    const meta: ConversationMeta = {
      id: randomUUID(),
      sessionId: null,
      title: 'New conversation',
      cwd,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.push(meta);
    this.flush();
    return meta;
  }

  update(id: string, patch: Partial<ConversationMeta>): void {
    const meta = this.get(id);
    if (!meta) return;
    Object.assign(meta, patch, { updatedAt: Date.now() });
    this.flush();
  }

  appendTranscript(id: string, msg: ServerMsg): void {
    fs.appendFileSync(this.transcriptFile(id), JSON.stringify(msg) + '\n');
  }

  readTranscript(id: string): ServerMsg[] {
    const file = this.transcriptFile(id);
    if (!fs.existsSync(file)) return [];
    const out: ServerMsg[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip corrupt line
      }
    }
    return out;
  }

  private transcriptFile(id: string): string {
    // ids are our own UUIDs, but never trust them as path segments blindly.
    return path.join(this.transcriptsDir, id.replace(/[^a-zA-Z0-9-]/g, '') + '.jsonl');
  }

  private flush(): void {
    fs.writeFileSync(this.indexFile, JSON.stringify(this.conversations, null, 2));
  }
}
