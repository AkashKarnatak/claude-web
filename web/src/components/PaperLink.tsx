// Homepage shortcut: paste a paper link, press Enter, and a new chat starts
// in auto mode with the "read this paper and explain it slowly" prompt. Only
// rendered in the draft state, where the first prompt creates the chat.

import { useState } from 'react';
import { useStore } from '../store';
import { send } from '../ws';
import { setMode } from '../modes';

const QUESTION = (link: string) =>
  `curl and read the entire paper ${link} and explain to me in detail. ` +
  'what do they propose and how does it work. explain to me slowly and make sure i understand';

/** Accept a URL as typed, or a bare arXiv id (2610.10528, 2303.06555v2)
 * which expands to its PDF link. alphaXiv mirrors (alphaxiv.org/abs|pdf|
 * overview/<id>) are rewritten to the arxiv.org PDF; every other URL is
 * passed through untouched. Anything else is rejected. */
export function paperUrl(raw: string): string | null {
  const s = raw.trim();
  const alphaxiv = s.match(/^https?:\/\/(?:www\.)?alphaxiv\.org\/(?:abs|pdf|overview)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?\/?(?:[?#].*)?$/i);
  if (alphaxiv) return `https://arxiv.org/pdf/${alphaxiv[1]}`;
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return `https://arxiv.org/pdf/${s}`;
  if (/^arxiv\.org\/\S+$/i.test(s)) return `https://${s}`;
  return null;
}

export function PaperLink() {
  const connected = useStore((s) => s.connected);
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  const onSubmit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const url = paperUrl(value);
    if (!url || !connected) {
      setInvalid(true);
      return;
    }
    // Draft state: the server remembers the mode and applies it when the
    // first prompt creates the session. Same socket, so ordering holds.
    setMode('auto');
    send({ t: 'prompt', text: QUESTION(url) });
    setValue('');
  };

  return (
    <form className="paper-link" onSubmit={onSubmit}>
      <span className="paper-link-icon" aria-hidden>
        ¶
      </span>
      <input
        type="text"
        value={value}
        placeholder="Paste a paper link, press Enter"
        aria-label="Paper link"
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
      />
      <span className="paper-link-hint">
        {invalid
          ? 'Needs a URL or an arXiv id'
          : 'Reads the whole paper and walks you through it · new chat, auto mode'}
      </span>
    </form>
  );
}
