// Renders the transcript; completed messages are memoized components so
// token streaming only re-renders the live message (ARCHITECTURE.md §7).
//
// Scroll model (claude.ai-style): sending a message anchors your bubble at
// the TOP of the view, and the reply streams in below. A trailing spacer is
// continuously resized so that "scrolled to the bottom" means exactly
// "anchor at top" while the reply is shorter than the viewport — and once
// the reply outgrows it, following the bottom follows the streaming text.
// Scrolling up disengages the follow; sending re-engages it.

import { memo, useEffect, useRef, useState } from 'react';
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

// List bottom padding (120px) + the anchor's offset from the top (12px).
const ANCHOR_MARGIN = 132;

export function MessageList() {
  const items = useStore((s) => s.items);
  const openSeq = useStore((s) => s.openSeq);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const anchoredId = useRef<string | null>(null);
  const follow = useRef(false);
  // Scroll position we last set programmatically: scroll events landing
  // there are ours; anything else is the user and can disengage the follow.
  const expectedScroll = useRef<number | null>(null);
  const [spacer, setSpacer] = useState(0);

  const anim = useRef<number | null>(null);

  const pinToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    expectedScroll.current = el.scrollTop;
  };

  /** Smooth-scroll to the bottom, marking every frame as programmatic so
   * the follow logic can't mistake it for user scrolling. The target is
   * re-read each frame (content/spacer may still be changing). */
  const animateToBottom = (duration = 400) => {
    const el = scrollRef.current;
    if (!el) return;
    if (anim.current !== null) cancelAnimationFrame(anim.current);
    const from = el.scrollTop;
    const t0 = performance.now();
    const step = (now: number) => {
      const el2 = scrollRef.current;
      if (!el2) {
        anim.current = null;
        return;
      }
      const t = Math.min(1, (now - t0) / duration);
      const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const target = el2.scrollHeight - el2.clientHeight;
      el2.scrollTop = from + (target - from) * ease;
      expectedScroll.current = el2.scrollTop;
      anim.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    anim.current = requestAnimationFrame(step);
  };

  /** Spacer sized so max-scroll puts the anchor at the top while the reply
   * is short; shrinks to 0 as the reply grows (no leftover blank scroll). */
  const recompute = () => {
    const el = scrollRef.current;
    const spacerEl = spacerRef.current;
    const anchor = anchoredId.current
      ? el?.querySelector<HTMLElement>(`[data-msg-id="${anchoredId.current}"]`)
      : null;
    if (!el || !spacerEl) return;
    let next = 0;
    if (anchor) {
      const belowAnchor =
        spacerEl.getBoundingClientRect().top - anchor.getBoundingClientRect().top;
      next = Math.max(0, el.clientHeight - belowAnchor - ANCHOR_MARGIN);
    }
    setSpacer(next);
    // While the send animation runs it tracks the moving bottom itself.
    if (follow.current && anim.current === null) {
      // Account for the spacer change applying on the next frame.
      requestAnimationFrame(pinToBottom);
    }
  };

  // Content growth (streaming, late KaTeX/highlight layout) → keep model.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(inner);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual scrolling away from the bottom disengages the follow; returning
  // to the bottom re-engages it.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (expectedScroll.current !== null && Math.abs(el.scrollTop - expectedScroll.current) < 2) {
      return; // our own pin/animation frame
    }
    expectedScroll.current = null;
    if (anim.current !== null) {
      // User grabbed the scroll mid-animation; stop fighting them.
      cancelAnimationFrame(anim.current);
      anim.current = null;
    }
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Opening/switching a conversation (NOT session-id rekeys, which happen
  // mid-turn): land on the latest content.
  useEffect(() => {
    anchoredId.current = null;
    follow.current = false;
    setSpacer(0);
    requestAnimationFrame(pinToBottom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSeq]);

  // A newly sent message becomes the anchor and re-engages the follow.
  useEffect(() => {
    const last = items[items.length - 1];
    if (!last || last.kind !== 'user' || anchoredId.current === last.id) return;
    anchoredId.current = last.id;
    follow.current = true;
    // Start the animation before recompute so its instant pin stands down;
    // the animation glides to the (moving) bottom, which with a fresh
    // anchor means the bubble lands at the top of the view.
    requestAnimationFrame(() => {
      animateToBottom();
      recompute();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return (
    <div className="message-list" ref={scrollRef} onScroll={onScroll}>
      <div className="message-list-inner" ref={innerRef}>
        {items.length === 0 && (
          <div className="empty-state">
            <h2>claude web</h2>
            <p>
              Start a new chat below — a conversation is created with your first
              message. Past chats live in the sidebar.
            </p>
          </div>
        )}
        {items.map((item) => (
          <div key={item.id} data-msg-id={item.id}>
            <Item item={item} />
          </div>
        ))}
        <div ref={spacerRef} style={{ height: spacer }} aria-hidden />
      </div>
    </div>
  );
}
