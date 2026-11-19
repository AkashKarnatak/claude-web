// Pure text preprocessing that runs before react-markdown (ARCHITECTURE.md
// §10.2). Kept free of React so it can be unit-tested with plain tsx.
//
// Two jobs:
//  1. Convert Claude's `\(...\)` / `\[...\]` math delimiters to the `$`
//     forms remark-math understands.
//  2. Stop currency from being parsed as math. micromark's math-text
//     tokenizer pairs ANY two single `$` in a paragraph, so "costs $100 and
//     the full $100K" turns " 100 and the full " into KaTeX. We apply pandoc's
//     `tex_math_dollars` rules instead and backslash-escape every `$` that
//     cannot be a delimiter under them:
//       - opening `$` must be followed by a non-space (and not `$`)
//       - closing `$` must be preceded by a non-space
//       - closing `$` must NOT be followed by a digit
//       - a pair cannot span a blank line (paragraph boundary)
//     `\$` is a CommonMark character escape, so an escaped `$` renders as a
//     literal dollar and is invisible to remark-math.

// Segments we must not touch: fenced code blocks (possibly unterminated while
// streaming) and inline code spans.
const CODE_SEGMENT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/g;

const isSpace = (ch: string | undefined): boolean =>
  ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isDigit = (ch: string | undefined): boolean =>
  ch !== undefined && ch >= '0' && ch <= '9';

/** Index of the first blank line (paragraph boundary) at or after `from`, or text.length. */
function paragraphEnd(text: string, from: number): number {
  const re = /\n[ \t]*\n/g;
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : text.length;
}

/**
 * Escape `$` characters that cannot form a valid inline-math pair under
 * pandoc's rules, leaving real `$...$` / `$$...$$` math untouched.
 */
export function escapeCurrencyDollars(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }
    // Already escaped by the author: pass through.
    if (i > 0 && text[i - 1] === '\\') {
      out += ch;
      i++;
      continue;
    }
    // `$$`: display (or double-dollar inline) math. Copy through to its
    // closing `$$` verbatim so inner single `$` are not re-examined. Unclosed
    // `$$` is left alone — remark renders it literally anyway.
    if (text[i + 1] === '$') {
      const close = text.indexOf('$$', i + 2);
      if (close === -1) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    // Single `$`: look for a valid closing `$` inside this paragraph.
    const limit = paragraphEnd(text, i);
    let close = -1;
    if (!isSpace(text[i + 1])) {
      let j = i + 1;
      while (j < limit) {
        const c = text[j];
        if (c === '$') {
          if (text[j + 1] === '$') {
            j += 2; // a `$$` inside cannot close a single-`$` span
            continue;
          }
          if (text[j - 1] !== '\\' && !isSpace(text[j - 1]) && !isDigit(text[j + 1])) {
            close = j;
            break;
          }
          // An invalid closer is also not a new opener for this scan; a
          // later `$` may still close the span (e.g. "$a $ b$" → "a $ b").
        }
        j++;
      }
    }
    if (close === -1) {
      out += '\\$';
      i++;
    } else {
      out += text.slice(i, close + 1);
      i = close + 1;
    }
  }
  return out;
}

/**
 * Convert `\[...\]` → `$$...$$` and `\(...\)` → `$...$`. Bodies are trimmed so
 * a `\( x \)` becomes `$x$` rather than a space-padded span.
 */
export function convertTexDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `$$${body.trim()}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);
}

/**
 * Full math-delimiter normalization on protected text (code excluded).
 * Currency escaping runs first so that stray `$` from prose can never pair
 * with the `$` we generate from `\(...\)`.
 */
export function normalizeMath(md: string): string {
  return md
    .split(CODE_SEGMENT)
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // code segment — leave untouched
      return convertTexDelimiters(escapeCurrencyDollars(segment));
    })
    .join('');
}

/**
 * Streaming policy (§7): partial Markdown may have an unbalanced code fence;
 * treat the tail as an open code block by appending a closing fence. The
 * canonical parse on assistant_end replaces this.
 */
export function closeDanglingFence(md: string): string {
  const fences = md.match(/```/g);
  if (fences && fences.length % 2 === 1) return md + '\n```';
  return md;
}
