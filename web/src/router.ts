// Minimal URL routing: each conversation is a page at /c/<id> (draft = /),
// so chats are linkable/bookmarkable and open in new tabs. The server (and
// Vite in dev) serve index.html for unknown paths, so deep links just work.

/** Conversation id encoded in the current URL, or null for the draft. */
export function pathConversationId(): string | null {
  const m = location.pathname.match(/^\/c\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function chatHref(id: string): string {
  return `/c/${encodeURIComponent(id)}`;
}

/** User-initiated navigation: a new history entry (Back returns here). */
export function pushChatUrl(id: string | null): void {
  const next = id ? chatHref(id) : '/';
  if (location.pathname !== next) history.pushState(null, '', next);
}

/** Follow-along sync (server opened/rekeyed a chat): no new history entry. */
export function replaceChatUrl(id: string | null): void {
  const next = id ? chatHref(id) : '/';
  if (location.pathname !== next) history.replaceState(null, '', next);
}
