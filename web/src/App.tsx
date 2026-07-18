import { useEffect } from 'react';
import { connect, send } from './ws';
import { cycleMode } from './modes';
import { clearPermissionNotification } from './notify';
import { pathConversationId } from './router';
import { useStore } from './store';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { ModeBar } from './components/ModeBar';
import { PromptInput } from './components/PromptInput';
import { SearchModal } from './components/SearchModal';
import { Sidebar } from './components/Sidebar';
import { StatusLine } from './components/StatusLine';
import { TasksPanel } from './components/TasksPanel';
import { Unlock } from './components/Unlock';

export default function App() {
  const pendingPermissions = useStore((s) => s.permissions.length);
  const authState = useStore((s) => s.authState);
  const chatTitle = useStore((s) => s.activeMeta?.title ?? null);

  // Title bar: permission indicator wins, else the open chat's title.
  useEffect(() => {
    document.title =
      pendingPermissions > 0
        ? '● Permission needed — claude web'
        : chatTitle
          ? `${chatTitle} — claude web`
          : 'claude web';
    return () => {
      document.title = 'claude web';
    };
  }, [pendingPermissions, chatTitle]);

  useEffect(() => {
    connect();
    // Coming back to the tab addresses the notification's purpose.
    window.addEventListener('focus', clearPermissionNotification);

    // Back/forward: the URL is the source of truth for the open chat.
    const onPopState = () => {
      const id = pathConversationId();
      if (id) send({ t: 'open_conversation', conversationId: id });
      else send({ t: 'new_conversation' });
    };
    window.addEventListener('popstate', onPopState);

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
      // Ctrl/Cmd+K opens conversation search.
      if (e.key === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        useStore.setState({ searchOpen: true });
        return;
      }
      // Esc interrupts the running turn (typeahead/modal Esc is handled and
      // stopped before it reaches here).
      if (e.key === 'Escape') {
        const { status, permissions, modelPickerOpen, searchOpen } = useStore.getState();
        if (modelPickerOpen) {
          useStore.setState({ modelPickerOpen: false });
          return;
        }
        if (searchOpen) {
          useStore.setState({ searchOpen: false });
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
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('focus', clearPermissionNotification);
    };
  }, []);

  if (authState !== 'ok') {
    return <Unlock />;
  }

  return (
    <div className="app">
      <SearchModal />
      <Sidebar />
      <main className="main">
        <Header />
        <MessageList />
        <div className="composer">
          <TasksPanel />
          <StatusLine />
          <PromptInput />
          <ModeBar />
        </div>
      </main>
    </div>
  );
}
