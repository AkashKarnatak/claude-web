// Status, model, permission-mode selector, Stop button (ARCHITECTURE.md §8).

import { availableModes, setMode } from '../modes';
import { useStore } from '../store';
import { send } from '../ws';

const STATUS_LABEL = {
  idle: 'Idle',
  thinking: 'Thinking…',
  running_tool: 'Running tool…',
} as const;

export function Header() {
  const status = useStore((s) => s.status);
  const session = useStore((s) => s.session);
  const connected = useStore((s) => s.connected);
  const activeMeta = useStore((s) => s.activeMeta);

  return (
    <header className="header">
      <div className="header-title">
        <span className={`status-dot ${connected ? status : 'disconnected'}`} />
        <strong>{activeMeta?.title ?? 'claude-web'}</strong>
        <span className="header-status">
          {connected ? STATUS_LABEL[status] : 'Disconnected'}
        </span>
      </div>
      <div className="header-controls">
        {session && (
          <button
            className="header-model"
            onClick={() => useStore.setState({ modelPickerOpen: true })}
            title="Change model (/model)"
          >
            {session.model || 'default'}
          </button>
        )}
        <select
          value={session?.permissionMode ?? 'default'}
          onChange={(e) => setMode(e.target.value)}
          title="Permission mode (shift+tab to cycle)"
        >
          {availableModes(session?.bypassAvailable ?? false).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {status !== 'idle' && (
          <button className="btn stop" onClick={() => send({ t: 'interrupt' })}>
            ◼ Stop
          </button>
        )}
      </div>
    </header>
  );
}
