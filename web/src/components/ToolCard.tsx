// Tool card (ARCHITECTURE.md §10.3): header with tool name + concise action
// summary, pretty-printed input (diff view for edits, command for Bash),
// collapsible result, running/success/error status.

import { memo } from 'react';
import { ToolResult } from './ToolResult';

interface Props {
  name: string;
  input: unknown;
  status: 'running' | 'ok' | 'error';
  output?: unknown;
}

function field(input: unknown, key: string): string | undefined {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function summarize(name: string, input: unknown): string {
  switch (name) {
    case 'Bash':
      return field(input, 'command') ?? '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return field(input, 'file_path') ?? '';
    case 'Glob':
    case 'Grep':
      return field(input, 'pattern') ?? '';
    case 'WebFetch':
    case 'WebSearch':
      return field(input, 'url') ?? field(input, 'query') ?? '';
    case 'Task':
    case 'Agent':
      return field(input, 'description') ?? '';
    case 'TodoWrite':
      return 'update task list';
    default: {
      const json = JSON.stringify(input);
      return json && json !== '{}' ? json.slice(0, 80) : '';
    }
  }
}

function ToolInput({ name, input }: { name: string; input: unknown }) {
  const obj = (input ?? {}) as Record<string, unknown>;

  if (name === 'Edit' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
    return (
      <div className="diff">
        <pre className="diff-del">{obj.old_string}</pre>
        <pre className="diff-add">{obj.new_string}</pre>
      </div>
    );
  }
  if (name === 'Write' && typeof obj.content === 'string') {
    const content = obj.content;
    return <pre className="diff-add">{content.length > 4000 ? content.slice(0, 4000) + '\n…' : content}</pre>;
  }
  if (name === 'Bash') {
    // The header already shows the command; nothing more to add.
    return null;
  }
  if (name === 'TodoWrite' && Array.isArray(obj.todos)) {
    return (
      <ul className="todo-list">
        {(obj.todos as Array<Record<string, unknown>>).map((todo, i) => (
          <li key={i} className={`todo-${String(todo.status ?? '')}`}>
            {String(todo.content ?? todo.subject ?? '')}
          </li>
        ))}
      </ul>
    );
  }
  const keys = Object.keys(obj);
  if (keys.length === 0 || (keys.length === 1 && ['file_path', 'pattern', 'url', 'query'].includes(keys[0]))) {
    return null; // header summary already covers it
  }
  return <pre className="tool-input-json">{JSON.stringify(obj, null, 2)}</pre>;
}

const STATUS_ICON = { running: null, ok: '✓', error: '✕' } as const;

export const ToolCard = memo(function ToolCard({ name, input, status, output }: Props) {
  const summary = summarize(name, input);
  return (
    <div className={`tool-card status-${status}`}>
      <div className="tool-header">
        {status === 'running' ? (
          <span className="spinner" aria-label="running" />
        ) : (
          <span className={`tool-status-icon ${status}`}>{STATUS_ICON[status]}</span>
        )}
        <span className="tool-name">{name}</span>
        {summary && <code className="tool-summary">{summary}</code>}
      </div>
      <ToolInput name={name} input={input} />
      {status !== 'running' && <ToolResult output={output} isError={status === 'error'} />}
    </div>
  );
});
