// Renders the transcript; completed messages are memoized components so
// token streaming only re-renders the live message (ARCHITECTURE.md §7).

import { memo, useEffect, useRef } from 'react';
import { useStore, type TranscriptItem } from '../store';
import { AssistantMessage } from './AssistantMessage';
import { ThinkingPanel } from './ThinkingPanel';
import { ToolCard } from './ToolCard';
import { UsageFooter } from './UsageFooter';

const Item = memo(function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="user-message">{item.text}</div>;
    case 'assistant':
      return <AssistantMessage markdown={item.markdown} streaming={item.streaming} />;
    case 'thinking':
      return <ThinkingPanel text={item.text} streaming={item.streaming} />;
    case 'tool':
      return (
        <ToolCard name={item.name} input={item.input} status={item.status} output={item.output} />
      );
    case 'result':
      return (
        <UsageFooter
          usage={item.usage}
          costUsd={item.costUsd}
          durationMs={item.durationMs}
          isError={item.isError}
        />
      );
    case 'error':
      return <div className="error-banner">{item.message}</div>;
  }
});

export function MessageList() {
  const items = useStore((s) => s.items);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Pin to bottom on ANY size change while stuck: content growth (streaming,
  // late KaTeX/highlight layout) and viewport shrink (spinner status line
  // appearing under the list) — not just item-count changes.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const pin = () => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // Sending your own message always snaps to the bottom, even if you had
    // scrolled up to read history.
    if (items.length > 0 && items[items.length - 1].kind === 'user') {
      stickToBottom.current = true;
    }
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  return (
    <div className="message-list" ref={scrollRef} onScroll={onScroll}>
      <div className="message-list-inner" ref={innerRef}>
        {items.length === 0 && (
          <div className="empty-state">
            <h2>claude-web</h2>
            <p>
              Start a new chat below — a conversation is created with your first
              message. Past chats live in the sidebar.
            </p>
          </div>
        )}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
