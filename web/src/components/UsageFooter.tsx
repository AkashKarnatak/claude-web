import { memo } from 'react';
import type { Usage } from '../../../server/protocol';

interface Props {
  usage: Usage;
  costUsd: number;
  durationMs: number;
  isError: boolean;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export const UsageFooter = memo(function UsageFooter({ usage, costUsd, durationMs, isError }: Props) {
  return (
    <div className={`usage-footer${isError ? ' error' : ''}`}>
      {(durationMs / 1000).toFixed(1)}s · ↑{tokens(usage.input_tokens)} ↓
      {tokens(usage.output_tokens)} tokens
      {usage.cache_read_input_tokens ? ` · ${tokens(usage.cache_read_input_tokens)} cached` : ''}
      {' · $'}
      {costUsd.toFixed(4)}
    </div>
  );
});
