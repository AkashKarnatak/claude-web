import { useEffect } from 'react';
import { connect, send } from './ws';
import { cycleMode } from './modes';
import { useStore } from './store';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { ModeBar } from './components/ModeBar';
import { ModelPicker } from './components/ModelPicker';
import { PermissionModal } from './components/PermissionModal';
import { PromptInput } from './components/PromptInput';
import { Sidebar } from './components/Sidebar';
import { StatusLine } from './components/StatusLine';

export default function App() {
  useEffect(() => {
    connect();

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      // Shift+Tab cycles permission modes, like the TUI.
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        cycleMode();
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
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
      <PermissionModal />
      <ModelPicker />
    </div>
  );
}
