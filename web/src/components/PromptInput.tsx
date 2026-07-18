// Prompt input with typeahead, mirroring the TUI's useTypeahead:
// - "/" at the start → slash-command suggestions (from the engine's init)
// - "@token" anywhere → file suggestions (fuzzy-matched server-side)
// - Up/Down navigate, Tab/Enter accept, Esc dismiss
// - Up on an empty input recalls prompt history
// - Pasted/dropped images become "[Image #N]" tokens + attachment chips,
//   like the TUI's Ctrl+V image paste

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import type { PromptImage } from '../../../server/protocol';
import { fileToImage } from '../images';
import { ensureNotifyPermission } from '../notify';
import { useStore } from '../store';
import { send } from '../ws';
import { ModelPicker } from './ModelPicker';
import { PermissionModal } from './PermissionModal';

interface Attachment extends PromptImage {
  /** The number in this attachment's "[Image #N]" token. Stable once
   * assigned (no renumbering while composing); submit renumbers to 1..k. */
  n: number;
}

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

// Touch devices: Enter inserts a newline; the send button sends.
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const imageCounter = useRef(0);
  const connected = useStore((s) => s.connected);
  const slashCommands = useStore((s) => s.session?.slashCommands ?? NO_COMMANDS);
  const fileSuggestions = useStore((s) => s.fileSuggestions);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileReqRef = useRef<{ reqId: string; start: number; end: number } | null>(null);
  const debounceRef = useRef<number | null>(null);
  const historyIdxRef = useRef<number | null>(null);

  // Focus the box as soon as it's usable so typing can start immediately.
  // Skipped on touch devices (popping the keyboard on load is hostile, and
  // mobile browsers block programmatic focus anyway). Once only — reconnects
  // mid-session must not steal focus.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (connected && !focusedOnce.current && !IS_TOUCH) {
      focusedOnce.current = true;
      textareaRef.current?.focus();
    }
  }, [connected]);

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

  /** Attach image files: each gets a chip and a "[Image #N]" token inserted
   * at the caret (or the end), mirroring the TUI's paste behavior. */
  const addImages = async (files: File[]) => {
    if (files.length === 0) return;
    const el = textareaRef.current;
    const caret = el && document.activeElement === el ? el.selectionStart : text.length;
    const processed = (await Promise.all(files.map(fileToImage))).filter(
      (img): img is PromptImage => img !== null,
    );
    if (processed.length === 0) return;
    const withNumbers = processed.map((img) => ({ ...img, n: ++imageCounter.current }));
    setAttachments((prev) => [...prev, ...withNumbers]);
    const tokens = withNumbers.map((a) => `[Image #${a.n}]`).join(' ');
    setText((t) => {
      const at = Math.min(caret, t.length);
      const before = t.slice(0, at);
      const after = t.slice(at);
      const lead = before && !/\s$/.test(before) ? ' ' : '';
      const trail = after && !/^\s/.test(after) ? ' ' : '';
      return before + lead + tokens + trail + after;
    });
    el?.focus();
  };

  // Keep a ref to the latest addImages so the window-level drop listeners
  // (registered once) never call a stale closure.
  const addImagesRef = useRef(addImages);
  addImagesRef.current = addImages;

  const removeAttachment = (n: number) => {
    setAttachments((prev) => prev.filter((a) => a.n !== n));
    // Strip the token (and one adjacent space) from the text.
    setText((t) => t.replace(new RegExp(`\\[Image #${n}\\] ?`, 'g'), ''));
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return; // normal text paste
    e.preventDefault();
    void addImages(files);
  };

  // Drag-and-drop anywhere in the window: show an overlay while a file drag
  // is over the page, attach image files on drop.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault(); // required to allow the drop
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) =>
        f.type.startsWith('image/'),
      );
      void addImagesRef.current(files);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

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
    let trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || !connected) return;
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
      setText('');
      setTypeahead(null);
      historyIdxRef.current = null;
      return; // keep attachments — /model isn't a prompt
    } else {
      let images: PromptImage[] | undefined;
      if (attachments.length > 0) {
        // Composing numbers can have gaps after removals; the wire contract
        // is "[Image #N] = the Nth image", so renumber tokens to 1..k here.
        const renumber = new Map(attachments.map((a, i) => [a.n, i + 1]));
        trimmed = trimmed.replace(/\[Image #(\d+)\]/g, (m, d: string) => {
          const to = renumber.get(Number(d));
          return to === undefined ? m : `[Image #${to}]`;
        });
        images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
      }
      send({ t: 'prompt', text: trimmed, ...(images ? { images } : {}) });
    }
    setText('');
    setAttachments([]);
    imageCounter.current = 0;
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

    // Alt+Enter inserts a newline like Shift+Enter — but browsers don't do
    // it natively, so insert at the caret ourselves.
    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      const el = textareaRef.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? start;
      setText(text.slice(0, start) + '\n' + text.slice(end));
      historyIdxRef.current = null;
      requestAnimationFrame(() => el?.setSelectionRange(start + 1, start + 1));
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (IS_TOUCH) return; // newline; sending is the button's job
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
    <>
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-label">Drop images to attach</div>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <div key={a.n} className="attachment-chip" title={`[Image #${a.n}]`}>
              <img src={`data:${a.mediaType};base64,${a.data}`} alt={`Image #${a.n}`} />
              <span className="attachment-label">#{a.n}</span>
              <button
                className="attachment-remove"
                onClick={() => removeAttachment(a.n)}
                title="Remove image"
                aria-label={`Remove image #${a.n}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
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
        onPaste={onPaste}
        onClick={() => {
          const el = textareaRef.current;
          if (el) refreshTypeahead(text, el.selectionStart);
        }}
        placeholder={
          !connected
            ? 'Connecting…'
            : IS_TOUCH
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
        disabled={!connected || (!text.trim() && attachments.length === 0)}
        title="Send"
        aria-label="Send"
      >
        ➤
      </button>
    </div>
    </>
  );
}
