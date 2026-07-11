import { memo } from 'react';

interface Props {
  text: string;
  streaming: boolean;
}

export const ThinkingPanel = memo(function ThinkingPanel({ text, streaming }: Props) {
  if (!text && !streaming) return null;
  return (
    <details className="thinking-panel" open={streaming}>
      <summary>{streaming ? 'Thinking…' : 'Thought process'}</summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
});
