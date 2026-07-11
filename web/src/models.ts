// Map the engine's model id (alias like 'sonnet' or full wire id like
// 'claude-opus-4-8[1m]') to the human-readable name from the model list.

import type { SessionInfo } from './store';

type ModelRow = SessionInfo['models'][number];

function matches(row: ModelRow, id: string): boolean {
  return row.value === id || row.resolvedModel === id || row.label === id;
}

export function modelDisplayName(session: SessionInfo | null): string {
  if (!session) return '';
  // No explicit selection = the engine default; resolve it through the
  // 'default' row so the header shows the actual model it points at.
  const id = session.model || 'default';
  // Prefer a concrete row; the 'default' alias row can resolve to the same
  // wire id as the model it currently points at.
  const hit =
    session.models.find((r) => r.value !== 'default' && matches(r, id)) ??
    session.models.find((r) => matches(r, id));
  if (!hit) return id;
  if (hit.value === 'default') {
    // "Use the default model (currently Opus 4.8 (1M context))" → the name.
    const m = hit.description.match(/currently (.+)\)/);
    if (m) return m[1];
  }
  // Descriptions read "Sonnet 5 · Efficient for routine tasks · …" — the
  // first segment is the actual model name; the label ('Sonnet') is coarser.
  const name = hit.description.split('·')[0]?.trim();
  return name || hit.label;
}
