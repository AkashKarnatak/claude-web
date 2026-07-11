// Permission modes: labels/symbols/colors and the Shift+Tab cycle order,
// mirroring the TUI's PERMISSION_MODE_CONFIG and getNextPermissionMode.

import { useStore } from './store';
import { send } from './ws';

export interface ModeConfig {
  label: string;
  symbol: string;
  className: string;
}

export const MODE_CONFIG: Record<string, ModeConfig> = {
  default: { label: 'default', symbol: '', className: 'mode-default' },
  acceptEdits: { label: 'accept edits on', symbol: '⏵⏵', className: 'mode-accept' },
  plan: { label: 'plan mode on', symbol: '⏸', className: 'mode-plan' },
  auto: { label: 'auto mode on', symbol: '⏵⏵', className: 'mode-auto' },
  bypassPermissions: { label: 'bypass permissions on', symbol: '⏵⏵', className: 'mode-bypass' },
};

/**
 * TUI cycle: default → acceptEdits → plan → bypass (only when the session was
 * launched to allow it) → auto → default. If the engine rejects a mode (e.g.
 * auto's gate is off), it replies with an authoritative `mode` revert.
 */
function nextMode(current: string, bypassAvailable: boolean): string {
  switch (current) {
    case 'default':
      return 'acceptEdits';
    case 'acceptEdits':
      return 'plan';
    case 'plan':
      return bypassAvailable ? 'bypassPermissions' : 'auto';
    case 'bypassPermissions':
      return 'auto';
    default: // auto, dontAsk, anything unknown
      return 'default';
  }
}

export function setMode(mode: string): void {
  send({ t: 'set_mode', mode });
  // Optimistic; the server confirms or reverts with a `mode` message.
  useStore.setState((s) => (s.session ? { session: { ...s.session, permissionMode: mode } } : {}));
}

export function cycleMode(): void {
  const session = useStore.getState().session;
  const current = session?.permissionMode ?? 'default';
  setMode(nextMode(current, session?.bypassAvailable ?? false));
}
