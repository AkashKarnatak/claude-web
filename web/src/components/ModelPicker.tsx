// The /model selector — a popover anchored above the chat input (like the
// TUI, which renders its picker in the footer area, not a centered dialog).
// /model is a client-UI command: headless engines can't draw a picker, so we
// intercept it and render our own, then apply via set_model.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { send } from '../ws';

export function ModelPicker() {
  const open = useStore((s) => s.modelPickerOpen);
  const session = useStore((s) => s.session);
  const [selected, setSelected] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);

  const models = session?.models ?? [];
  const current = session?.model ?? '';

  useEffect(() => {
    if (!open) return;
    const idx = models.findIndex((m) => m.value === current || m.label === current);
    setSelected(idx >= 0 ? idx : 0);
    popoverRef.current?.focus();
    // Click-away closes (no backdrop since this is a popover, not a modal).
    const onMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        useStore.setState({ modelPickerOpen: false });
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const close = () => useStore.setState({ modelPickerOpen: false });

  const choose = (value: string) => {
    send({ t: 'set_model', model: value === 'default' ? undefined : value });
    // Optimistic; the server confirms/reverts with a `model` message.
    useStore.setState((s) =>
      s.session
        ? { session: { ...s.session, model: value }, modelPickerOpen: false }
        : { modelPickerOpen: false },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((selected + 1) % Math.max(models.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((selected - 1 + models.length) % Math.max(models.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (models[selected]) choose(models[selected].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="model-popover" ref={popoverRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="model-popover-header">
        Select model — current: <code>{current || 'default'}</code>
      </div>
      {models.length === 0 && (
        <div className="model-popover-header">
          Model list not available yet — the engine is still booting. Try again in a moment.
        </div>
      )}
      <div className="model-list">
        {models.map((m, i) => {
          const isCurrent = m.value === current || m.label === current;
          return (
            <button
              key={m.value}
              className={`model-item${i === selected ? ' selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => choose(m.value)}
            >
              <span className="model-label">
                {m.label}
                {isCurrent && ' ✓'}
              </span>
              {m.description && <span className="model-desc">{m.description}</span>}
            </button>
          );
        })}
      </div>
      <div className="typeahead-hint">↑↓ navigate · enter to select · esc to close</div>
    </div>
  );
}
