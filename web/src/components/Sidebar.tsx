import { chatHref, pushChatUrl } from '../router';
import { useStore } from '../store';
import { send } from '../ws';
import { PanelLeftIcon, SearchIcon } from './icons';

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
          <div className="sidebar-head-actions">
            <button
              className="icon-btn"
              title="Search conversations (Ctrl+K)"
              onClick={() => useStore.setState({ searchOpen: true })}
              tabIndex={open ? 0 : -1}
            >
              <SearchIcon />
            </button>
            <button
              className="icon-btn"
              title="Close sidebar (Ctrl+B)"
              onClick={() => useStore.setState({ sidebarOpen: false })}
              tabIndex={open ? 0 : -1}
            >
              <PanelLeftIcon />
            </button>
          </div>
        </div>
        <button
          className="btn new-chat"
          onClick={() => {
            // Reset the URL first: the draft the server answers with must
            // not re-open the chat named by the old URL.
            pushChatUrl(null);
            send({ t: 'new_conversation' });
            closeIfOverlay();
          }}
          tabIndex={open ? 0 : -1}
        >
          + New chat
        </button>
        <nav className="conversation-list">
          {conversations.map((c) => (
            // Real links, so middle/ctrl-click opens the chat in a new tab;
            // plain clicks navigate in place over the existing socket.
            <a
              key={c.id}
              href={chatHref(c.id)}
              className={`conversation-item${c.id === activeId ? ' active' : ''}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                pushChatUrl(c.id);
                send({ t: 'open_conversation', conversationId: c.id });
                closeIfOverlay();
              }}
              title={c.title}
              tabIndex={open ? 0 : -1}
            >
              {c.title}
            </a>
          ))}
        </nav>
      </div>
      </aside>
    </>
  );
}
