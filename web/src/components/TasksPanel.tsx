// Live view of background tasks and fanned-out subagents (Task tool agents,
// deep-research fan-out, workflows, background shells) — the web version of
// the TUI's tasks display. A one-line summary sits above the status line;
// clicking it expands per-task rows with status, elapsed, token/tool-use
// counters, the tool each agent is currently running, and final summaries.

import { useEffect, useState } from 'react';
import type { TaskItem } from '../../../server/protocol';
import { useStore } from '../store';

const RUNNING = new Set(['running', 'pending']);
// How long finished tasks stay on the panel before fading out client-side.
const LINGER_MS = 60_000;

function isActive(t: TaskItem): boolean {
  return RUNNING.has(t.status) || t.status === 'paused';
}

function elapsed(t: TaskItem, now: number): string {
  const ms = (t.endedAt ?? now) - t.startedAt;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Short badge: subagent type for agents, else the engine task type. */
function badge(t: TaskItem): string {
  if (t.subagentType) return t.subagentType;
  if (t.workflowName) return `workflow:${t.workflowName}`;
  switch (t.taskType) {
    case 'local_bash':
      return 'shell';
    case 'local_workflow':
      return 'workflow';
    default:
      return t.taskType ?? 'task';
  }
}

const STATUS_ICON: Record<string, string> = {
  completed: '✓',
  failed: '✕',
  killed: '✕',
  stopped: '◼',
  paused: '⏸',
};

function TaskRow({ task, now }: { task: TaskItem; now: number }) {
  const running = RUNNING.has(task.status);
  const parts: string[] = [elapsed(task, now)];
  if (task.totalTokens) parts.push(`↓ ${tokens(task.totalTokens)} tok`);
  if (task.toolUses) parts.push(`${task.toolUses} tools`);
  if (running && task.lastToolName) parts.push(task.lastToolName);

  return (
    <div className={`task-row status-${task.status}`}>
      <span className="task-icon">
        {running ? (
          <span className="spinner" aria-label="running" />
        ) : (
          <span className={`task-status-icon ${task.status}`}>
            {STATUS_ICON[task.status] ?? '•'}
          </span>
        )}
      </span>
      <span className="task-badge">{badge(task)}</span>
      <span className="task-body">
        <span className="task-desc" title={task.description}>
          {task.description}
        </span>
        {(task.summary || task.error) && (
          <span className={`task-summary${task.error ? ' error' : ''}`}>
            {task.error ?? task.summary}
          </span>
        )}
      </span>
      <span className="task-meta">{parts.join(' · ')}</span>
    </div>
  );
}

export function TasksPanel() {
  const tasks = useStore((s) => s.tasks);
  const expanded = useStore((s) => s.tasksExpanded);
  const [now, setNow] = useState(() => Date.now());

  const anyRunning = tasks.some(isActive);

  // Tick elapsed while anything runs; also refreshes the linger cutoff.
  useEffect(() => {
    if (tasks.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [tasks.length]);

  // Finished tasks linger a bit (so quick completions are noticed), then
  // drop off the panel; the server prunes its own copy independently.
  const visible = tasks.filter(
    (t) => isActive(t) || !t.endedAt || now - t.endedAt < LINGER_MS,
  );
  if (visible.length === 0) return null;

  const running = visible.filter(isActive).length;
  const done = visible.length - running;
  const summary =
    running > 0
      ? `${running} task${running === 1 ? '' : 's'} running${done > 0 ? ` · ${done} finished` : ''}`
      : `${done} task${done === 1 ? '' : 's'} finished`;

  return (
    <div className={`tasks-panel${anyRunning ? ' active' : ''}`}>
      <button
        className="tasks-header"
        onClick={() => useStore.setState({ tasksExpanded: !expanded })}
        title={expanded ? 'Collapse tasks' : 'Expand tasks'}
      >
        <span className={`tasks-caret${expanded ? ' open' : ''}`}>▸</span>
        {anyRunning && <span className="spinner small" aria-hidden />}
        <span className="tasks-summary">{summary}</span>
      </button>
      {expanded && (
        <div className="tasks-list">
          {visible.map((t) => (
            <TaskRow key={t.taskId} task={t} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
