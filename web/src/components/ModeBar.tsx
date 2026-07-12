// Footer line under the prompt: permission-mode indicator + shift+tab hint.
// The indicator is a tappable chip that cycles modes — the touch equivalent
// of Shift+Tab — and is always shown so mobile users have something to tap.

import { cycleMode, MODE_CONFIG } from '../modes';
import { useStore } from '../store';

export function ModeBar() {
  const mode = useStore((s) => s.session?.permissionMode ?? 'default');
  const config = MODE_CONFIG[mode] ?? MODE_CONFIG.default;

  return (
    <div className="mode-bar">
      <button
        className={`mode-chip ${config.className}`}
        onClick={cycleMode}
        title="Cycle permission mode (shift+tab)"
      >
        {config.symbol && <span>{config.symbol} </span>}
        {mode === 'default' ? 'default mode' : config.label}
      </button>
      <span className="mode-hint">shift+tab to cycle modes</span>
    </div>
  );
}
