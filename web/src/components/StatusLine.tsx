// The TUI's spinner row, web edition: animated glyph, whimsical verb,
// elapsed time, live token counter, current activity, esc-to-interrupt hint.

import { useEffect, useState } from 'react';
import { useStore } from '../store';

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function StatusLine() {
  const status = useStore((s) => s.status);
  const turn = useStore((s) => s.turn);
  const activity = useStore((s) => s.activity);
  const currentTool = useStore((s) => s.currentTool);
  const [, tick] = useState(0);

  const active = status !== 'idle' && turn !== null;

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [active]);

  if (!active || !turn) return null;

  const parts: string[] = ['esc to interrupt', formatDuration(Date.now() - turn.startedAt)];
  if (turn.tokens > 0) parts.push(`↓ ${turn.tokens} tokens`);
  if (activity === 'thinking') parts.push('thinking');
  if (activity === 'tool' && currentTool) parts.push(currentTool);

  return (
    <div className="status-line">
      <span className={`status-glyph activity-${activity}`}>✳</span>
      <span className="status-verb">{turn.verb}…</span>
      <span className="status-parts">({parts.join(' · ')})</span>
    </div>
  );
}
