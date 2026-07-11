import { memo } from 'react';
import { Markdown } from './Markdown';

interface Props {
  markdown: string;
  streaming: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({ markdown, streaming }: Props) {
  return (
    <div className={`assistant-message${streaming ? ' streaming' : ''}`}>
      <Markdown markdown={markdown} streaming={streaming} />
      {streaming && markdown === '' && <span className="cursor-blink">▌</span>}
    </div>
  );
});
