// Global conversation search — a centered palette-style dialog (Ctrl+K or
// the magnifier in the header). Type to search all of this project's chats
// server-side (ripgrep-prefiltered); results render rg-style: conversation
// title as the heading, matched snippets under it with highlighted spans.
// ↑/↓ navigate, Enter opens, Esc closes.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SearchSnippet } from '../../../server/protocol';
import { pushChatUrl } from '../router';
import { useStore } from '../store';
import { send } from '../ws';

const DEBOUNCE_MS = 200;

function Highlighted({ snippet }: { snippet: SearchSnippet }) {
  const { text, ranges } = snippet;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="search-match">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return (
    <div className="search-snippet">
      <span className={`search-role role-${snippet.role}`}>
        {snippet.role === 'user' ? 'you' : 'claude'}
      </span>
      <span className="search-snippet-text">{parts}</span>
    </div>
  );
}

export function SearchModal() {
  const open = useStore((s) => s.searchOpen);
  const results = useStore((s) => s.searchResults);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Fresh dialog each open: clear the previous query/results, focus input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    reqRef.current = null;
    useStore.setState({ searchResults: null });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const items = results && results.reqId === reqRef.current ? results.items : null;

  // Keep the selected row visible while navigating with the keyboard.
  useEffect(() => {
    listRef.current
      ?.querySelector('.search-result.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const runSearch = (q: string) => {
    setQuery(q);
    setSelected(0);
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    if (!q.trim()) {
      reqRef.current = null;
      useStore.setState({ searchResults: null });
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      const reqId = crypto.randomUUID();
      reqRef.current = reqId;
      send({ t: 'search', reqId, query: q });
    }, DEBOUNCE_MS);
  };

  const close = () => useStore.setState({ searchOpen: false });

  const openResult = (id: string) => {
    pushChatUrl(id);
    send({ t: 'open_conversation', conversationId: id });
    close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't let the global Esc interrupt the turn
      close();
    } else if (e.key === 'ArrowDown' && items?.length) {
      e.preventDefault();
      setSelected((selected + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items?.length) {
      e.preventDefault();
      setSelected((selected - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && items?.[selected]) {
      e.preventDefault();
      openResult(items[selected].id);
    }
  };

  if (!open) return null;

  return (
    <div className="search-overlay" onMouseDown={close}>
      <div className="search-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={(e) => runSearch(e.target.value)}
          placeholder="Search conversations… (regex, smart-case)"
          spellCheck={false}
        />
        <div className="search-results" ref={listRef}>
          {items && items.length === 0 && (
            <div className="search-empty">No matches for “{query}”</div>
          )}
          {items?.map((r, i) => (
            <button
              key={r.id}
              className={`search-result${i === selected ? ' selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => openResult(r.id)}
            >
              <div className="search-result-head">
                <span className="search-result-title">{r.title}</span>
                <span className="search-result-count">
                  {r.matchCount} {r.matchCount === 1 ? 'match' : 'matches'}
                </span>
              </div>
              {r.snippets.map((s, j) => (
                <Highlighted key={j} snippet={s} />
              ))}
            </button>
          ))}
        </div>
        <div className="typeahead-hint">↑↓ navigate · enter to open · esc to close</div>
      </div>
    </div>
  );
}
