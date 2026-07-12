import { useEffect } from 'react';
import { connect, send } from './ws';
import { cycleMode } from './modes';
import { clearPermissionNotification } from './notify';
import { useStore } from './store';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { ModeBar } from './components/ModeBar';
import { PromptInput } from './components/PromptInput';
import { Sidebar } from './components/Sidebar';
import { StatusLine } from './components/StatusLine';
import { Unlock } from './components/Unlock';

export default function App() {
  const pendingPermissions = useStore((s) => s.permissions.length);
  const authState = useStore((s) => s.authState);

  // Title-bar indicator while permission requests are waiting.
  useEffect(() => {
    document.title = pendingPermissions > 0 ? '● Permission needed — claude web' : 'claude web';
    return () => {
      document.title = 'claude web';
    };
  }, [pendingPermissions]);

  useEffect(() => {
    connect();
    // Coming back to the tab addresses the notification's purpose.
    window.addEventListener('focus', clearPermissionNotification);

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      // Shift+Tab cycles permission modes, like the TUI.
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        cycleMode();
        return;
      }
      // Ctrl+B toggles the sidebar.
      if (e.key === 'b' && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen }));
        return;
      }
      // Esc interrupts the running turn (typeahead/modal Esc is handled and
      // stopped before it reaches here).
      if (e.key === 'Escape') {
        const { status, permissions, modelPickerOpen } = useStore.getState();
        if (modelPickerOpen) {
          useStore.setState({ modelPickerOpen: false });
          return;
        }
        if (permissions.length === 0 && status !== 'idle') {
          send({ t: 'interrupt' });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('focus', clearPermissionNotification);
    };
  }, []);

  if (authState !== 'ok') {
    return <Unlock />;
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Header />
        <MessageList />
        <div className="composer">
          <StatusLine />
          <PromptInput />
          <ModeBar />
        </div>
      </main>
    </div>
  );
}
