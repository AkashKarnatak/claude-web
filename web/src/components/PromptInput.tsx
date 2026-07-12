// Prompt input with typeahead, mirroring the TUI's useTypeahead:
// - "/" at the start → slash-command suggestions (from the engine's init)
// - "@token" anywhere → file suggestions (fuzzy-matched server-side)
// - Up/Down navigate, Tab/Enter accept, Esc dismiss
// - Up on an empty input recalls prompt history

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ensureNotifyPermission } from '../notify';
import { useStore } from '../store';
import { send } from '../ws';
import { ModelPicker } from './ModelPicker';
import { PermissionModal } from './PermissionModal';

interface SuggestionItem {
  value: string;
  description?: string;
}

interface Typeahead {
  type: 'command' | 'file';
  items: SuggestionItem[];
  selected: number;
  /** Token boundaries in the input text that acceptance replaces. */
  start: number;
  end: number;
}

const MAX_COMMAND_ITEMS = 8;

// Stable fallback: a fresh [] per selector call would re-render forever.
const NO_COMMANDS: Array<{ name: string; description: string }> = [];

function fuzzyFilter(
  query: string,
  commands: Array<{ name: string; description: string }>,
): SuggestionItem[] {
  const q = query.toLowerCase();
  const scored: Array<{ item: SuggestionItem; score: number }> = [];
  for (const c of commands) {
    const lc = c.name.toLowerCase();
    const item = { value: c.name, description: c.description };
    if (lc.startsWith(q)) scored.push({ item, score: 0 });
    else if (lc.includes(q)) scored.push({ item, score: 1 });
    else {
      // subsequence
      let qi = 0;
      for (let ci = 0; ci < lc.length && qi < q.length; ci++) {
        if (lc[ci] === q[qi]) qi++;
      }
      if (qi === q.length && q.length > 0) scored.push({ item, score: 2 });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.item.value.length - b.item.value.length);
  return scored.slice(0, MAX_COMMAND_ITEMS).map((s) => s.item);
}

/** Whitespace-delimited token containing the caret. */
function tokenAt(text: string, caret: number): { start: number; end: number; token: string } {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { start, end, token: text.slice(start, caret) };
}

export function PromptInput() {
  const [text, setText] = useState('');
  const [typeahead, setTypeahead] = useState<Typeahead | null>(null);
  const connected = useStore((s) => s.connected);
  const slashCommands = useStore((s) => s.session?.slashCommands ?? NO_COMMANDS);
  const fileSuggestions = useStore((s) => s.fileSuggestions);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileReqRef = useRef<{ reqId: string; start: number; end: number } | null>(null);
  const debounceRef = useRef<number | null>(null);
  const historyIdxRef = useRef<number | null>(null);

  // Auto-resize with wrapped lines, not just explicit newlines. Runs on any
  // text change (typing, history recall, typeahead accept, clear on send).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    // Scrollbar only once content exceeds the max height, never before.
    el.style.overflowY = el.scrollHeight > 220 ? 'auto' : 'hidden';
  }, [text]);

  // Attach server file suggestions when they answer our latest request.
  useEffect(() => {
    const req = fileReqRef.current;
    if (!fileSuggestions || !req || fileSuggestions.reqId !== req.reqId) return;
    if (fileSuggestions.items.length === 0) {
      setTypeahead(null);
      return;
    }
    setTypeahead({
      type: 'file',
      items: fileSuggestions.items.map((f) => ({ value: f })),
      selected: 0,
      start: req.start,
      end: req.end,
    });
  }, [fileSuggestions]);

  const refreshTypeahead = (value: string, caret: number) => {
    const { start, end, token } = tokenAt(value, caret);

    // Slash commands: only for the first token, at the start of the input.
    if (start === 0 && token.startsWith('/')) {
      const items = fuzzyFilter(token.slice(1), slashCommands);
      setTypeahead(
        items.length > 0 ? { type: 'command', items, selected: 0, start, end } : null,
      );
      return;
    }

    // @-file mentions anywhere in the text.
    if (token.startsWith('@')) {
      const reqId = crypto.randomUUID();
      fileReqRef.current = { reqId, start, end };
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        send({ t: 'suggest_files', reqId, query: token.slice(1) });
      }, 120);
      return;
    }

    fileReqRef.current = null;
    setTypeahead(null);
  };

  const onChange = (value: string) => {
    setText(value);
    historyIdxRef.current = null;
    const caret = textareaRef.current?.selectionStart ?? value.length;
    refreshTypeahead(value, caret);
  };

  const accept = (ta: Typeahead) => {
    const item = ta.items[ta.selected].value;
    const replacement = ta.type === 'command' ? `/${item} ` : `@${item} `;
    const next = text.slice(0, ta.start) + replacement + text.slice(ta.end);
    setText(next);
    setTypeahead(null);
    fileReqRef.current = null;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const caret = ta.start + replacement.length;
        el.setSelectionRange(caret, caret);
      }
    });
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    // User gesture: the right moment to ask for notification permission,
    // so permission-request alerts can reach an unfocused tab later.
    ensureNotifyPermission();
    // /model is a client-UI command (the TUI intercepts it too): with no
    // args open our picker; with an arg switch directly.
    const modelMatch = trimmed.match(/^\/model(?:\s+(.*))?$/);
    if (modelMatch) {
      const arg = modelMatch[1]?.trim();
      if (arg) {
        send({ t: 'set_model', model: arg === 'default' ? undefined : arg });
      } else {
        useStore.setState({ modelPickerOpen: true });
      }
    } else {
      send({ t: 'prompt', text: trimmed });
    }
    setText('');
    setTypeahead(null);
    historyIdxRef.current = null;
  };

  const recallHistory = (direction: -1 | 1): boolean => {
    const prompts = useStore
      .getState()
      .items.filter((it) => it.kind === 'user')
      .map((it) => (it as { text: string }).text);
    if (prompts.length === 0) return false;
    let idx = historyIdxRef.current;
    if (idx === null) {
      if (direction === 1) return false;
      idx = prompts.length - 1;
    } else {
      idx += direction;
    }
    if (idx < 0) idx = 0;
    if (idx >= prompts.length) {
      historyIdxRef.current = null;
      setText('');
      return true;
    }
    historyIdxRef.current = idx;
    setText(prompts[idx]);
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (typeahead) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setTypeahead({ ...typeahead, selected: (typeahead.selected + 1) % typeahead.items.length });
          return;
        case 'ArrowUp':
          e.preventDefault();
          setTypeahead({
            ...typeahead,
            selected: (typeahead.selected - 1 + typeahead.items.length) % typeahead.items.length,
          });
          return;
        case 'Tab':
        case 'Enter':
          e.preventDefault();
          accept(typeahead);
          return;
        case 'Escape':
          // Dismiss suggestions only; don't let the global Esc interrupt.
          e.preventDefault();
          e.stopPropagation();
          setTypeahead(null);
          fileReqRef.current = null;
          return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }

    // History recall on an empty (or already-recalling) input.
    if (e.key === 'ArrowUp' && (text === '' || historyIdxRef.current !== null)) {
      if (recallHistory(-1)) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' && historyIdxRef.current !== null) {
      if (recallHistory(1)) e.preventDefault();
      return;
    }
  };

  return (
    <div className="prompt-input">
      <PermissionModal />
      <ModelPicker />
      {typeahead && (
        <div className="typeahead">
          {typeahead.items.map((item, i) => (
            <button
              key={item.value}
              className={`typeahead-item${i === typeahead.selected ? ' selected' : ''}`}
              onMouseEnter={() => setTypeahead({ ...typeahead, selected: i })}
              onMouseDown={(e) => {
                e.preventDefault();
                accept({ ...typeahead, selected: i });
              }}
            >
              {typeahead.type === 'file' && <span className="typeahead-icon">+</span>}
              <span className="typeahead-value">
                {typeahead.type === 'command' ? `/${item.value}` : item.value}
              </span>
              {item.description && <span className="typeahead-desc">{item.description}</span>}
            </button>
          ))}
          <div className="typeahead-hint">tab/enter to accept · esc to dismiss</div>
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onClick={() => {
          const el = textareaRef.current;
          if (el) refreshTypeahead(text, el.selectionStart);
        }}
        placeholder={
          !connected
            ? 'Connecting…'
            : window.matchMedia('(pointer: coarse)').matches
              ? 'Message Claude Code…'
              : 'Message Claude Code… ("/" for commands, "@" for files, Enter to send)'
        }
        rows={1}
        disabled={!connected}
      />
      {/* Touch devices get a send button (Enter is awkward there); hidden on
          fine-pointer devices via CSS. */}
      <button
        className="send-btn"
        onClick={submit}
        disabled={!connected || !text.trim()}
        title="Send"
        aria-label="Send"
      >
        ➤
      </button>
    </div>
  );
}
