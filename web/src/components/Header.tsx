// Status, model, permission-mode selector, Stop button (ARCHITECTURE.md §8).

import { modelDisplayName } from '../models';
import { useStore } from '../store';
import { PanelLeftIcon } from './icons';

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
  const sidebarOpen = useStore((s) => s.sidebarOpen);

  return (
    <header className="header">
      <div className="header-title">
        {!sidebarOpen && (
          <button
            className="icon-btn header-sidebar-toggle"
            title="Open sidebar (Ctrl+B)"
            onClick={() => useStore.setState({ sidebarOpen: true })}
          >
            <PanelLeftIcon />
          </button>
        )}
        <span className={`status-dot ${connected ? status : 'disconnected'}`} />
        <strong>{activeMeta?.title ?? 'claude web'}</strong>
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
            {modelDisplayName(session)}
          </button>
        )}
      </div>
    </header>
  );
}
