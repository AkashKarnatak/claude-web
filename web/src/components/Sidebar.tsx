import { useStore } from '../store';
import { send } from '../ws';
import { PanelLeftIcon } from './icons';

export function Sidebar() {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeId);
  const open = useStore((s) => s.sidebarOpen);

  // On narrow screens the sidebar overlays the chat; picking something (or
  // tapping the backdrop) should dismiss it.
  const closeIfOverlay = () => {
    if (window.matchMedia('(max-width: 720px)').matches) {
      useStore.setState({ sidebarOpen: false });
    }
  };

  return (
    <>
      {open && (
        <div
          className="sidebar-backdrop"
          onClick={() => useStore.setState({ sidebarOpen: false })}
        />
      )}
      <aside className={`sidebar${open ? '' : ' collapsed'}`} aria-hidden={!open}>
      <div className="sidebar-inner">
        <div className="sidebar-head">
          <span className="sidebar-title">Chats</span>
          <button
            className="icon-btn"
            title="Close sidebar (Ctrl+B)"
            onClick={() => useStore.setState({ sidebarOpen: false })}
            tabIndex={open ? 0 : -1}
          >
            <PanelLeftIcon />
          </button>
        </div>
        <button
          className="btn new-chat"
          onClick={() => {
            send({ t: 'new_conversation' });
            closeIfOverlay();
          }}
          tabIndex={open ? 0 : -1}
        >
          + New chat
        </button>
        <nav className="conversation-list">
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`conversation-item${c.id === activeId ? ' active' : ''}`}
              onClick={() => {
                send({ t: 'open_conversation', conversationId: c.id });
                closeIfOverlay();
              }}
              title={c.title}
              tabIndex={open ? 0 : -1}
            >
              {c.title}
            </button>
          ))}
        </nav>
      </div>
      </aside>
    </>
  );
}
