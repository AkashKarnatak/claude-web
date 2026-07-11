// The Markdown + LaTeX + code pipeline (ARCHITECTURE.md §10.2).
// remark-gfm + remark-math at the mdast stage, rehype-katex + highlighting at
// the hast stage. Raw HTML stays disabled (react-markdown default).

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';

// Segments we must not touch when normalizing math delimiters: fenced code
// blocks (possibly unterminated while streaming) and inline code spans.
const CODE_SEGMENT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/g;

/**
 * remark-math only parses $...$ / $$...$$. Claude also emits \(...\) and
 * \[...\]; convert those on protected text (code excluded), per §10.2.
 */
function normalizeMathDelimiters(md: string): string {
  return md
    .split(CODE_SEGMENT)
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // code segment — leave untouched
      return segment
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `$$${body}$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body}$`);
    })
    .join('');
}

/**
 * Streaming policy (§7): partial Markdown may have an unbalanced code fence;
 * treat the tail as an open code block by appending a closing fence. The
 * canonical parse on assistant_end replaces this.
 */
function closeDanglingFence(md: string): string {
  const fences = md.match(/```/g);
  if (fences && fences.length % 2 === 1) return md + '\n```';
  return md;
}

interface MarkdownProps {
  markdown: string;
  streaming?: boolean;
}

export const Markdown = memo(function Markdown({ markdown, streaming }: MarkdownProps) {
  let src = normalizeMathDelimiters(markdown);
  if (streaming) src = closeDanglingFence(src);
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          // A bad expression degrades to visible source instead of crashing.
          [rehypeKatex, { throwOnError: false }],
          rehypeHighlight,
        ]}
      >
        {src}
      </ReactMarkdown>
    </div>
  );
});
