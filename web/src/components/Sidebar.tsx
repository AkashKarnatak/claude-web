import { useStore } from '../store';
import { send } from '../ws';

export function Sidebar() {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeId);

  return (
    <aside className="sidebar">
      <button className="btn new-chat" onClick={() => send({ t: 'new_conversation' })}>
        + New chat
      </button>
      <nav className="conversation-list">
        {conversations.map((c) => (
          <button
            key={c.id}
            className={`conversation-item${c.id === activeId ? ' active' : ''}`}
            onClick={() => send({ t: 'open_conversation', conversationId: c.id })}
            title={c.title}
          >
            {c.title}
          </button>
        ))}
      </nav>
    </aside>
  );
}
