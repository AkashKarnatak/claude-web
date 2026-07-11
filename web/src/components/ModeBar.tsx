// Footer line under the prompt: permission-mode indicator + shift+tab hint,
// mirroring the TUI's PromptInputFooterLeftSide.

import { MODE_CONFIG } from '../modes';
import { useStore } from '../store';

export function ModeBar() {
  const mode = useStore((s) => s.session?.permissionMode ?? 'default');
  const config = MODE_CONFIG[mode] ?? MODE_CONFIG.default;

  return (
    <div className="mode-bar">
      {mode !== 'default' && (
        <span className={`mode-indicator ${config.className}`}>
          {config.symbol} {config.label}
        </span>
      )}
      <span className="mode-hint">shift+tab to cycle modes</span>
    </div>
  );
}
