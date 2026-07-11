// Collapsible tool result: terminal-style output for Bash, code for reads,
// truncation for very large outputs (ARCHITECTURE.md §10.3, §16).

import { memo, useState } from 'react';

const TRUNCATE_AT = 20_000;

/** Tool results arrive as a string or as [{type:'text', text}] blocks. */
export function outputToText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text: unknown }).text)
          : JSON.stringify(block),
      )
      .join('\n');
  }
  return JSON.stringify(output, null, 2);
}

interface Props {
  output: unknown;
  isError: boolean;
}

export const ToolResult = memo(function ToolResult({ output, isError }: Props) {
  const [expanded, setExpanded] = useState(false);
  const text = outputToText(output).trimEnd();
  if (!text) return <div className="tool-result empty">(no output)</div>;

  const truncated = !expanded && text.length > TRUNCATE_AT;
  const shown = truncated ? text.slice(0, TRUNCATE_AT) : text;

  return (
    <details className="tool-result">
      <summary>{isError ? 'Error output' : 'Output'}</summary>
      <pre className={`tool-output${isError ? ' error' : ''}`}>{shown}</pre>
      {truncated && (
        <button className="link-button" onClick={() => setExpanded(true)}>
          Show {(text.length - TRUNCATE_AT).toLocaleString()} more characters
        </button>
      )}
    </details>
  );
});
