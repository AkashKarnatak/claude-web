// The Markdown + LaTeX + code pipeline (ARCHITECTURE.md §10.2).
// remark-gfm + remark-math at the mdast stage, rehype-katex + highlighting at
// the hast stage. Raw HTML stays disabled (react-markdown default).
// Text preprocessing (math delimiters, currency `$`, dangling fences) lives
// in ../markdownText.ts.

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { closeDanglingFence, normalizeMath } from '../markdownText';

interface MarkdownProps {
  markdown: string;
  streaming?: boolean;
}

export const Markdown = memo(function Markdown({ markdown, streaming }: MarkdownProps) {
  let src = normalizeMath(markdown);
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
