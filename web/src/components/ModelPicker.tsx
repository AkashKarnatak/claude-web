// The /model selector dialog — the web equivalent of the TUI's model picker.
// /model is a client-UI command: headless engines can't draw a picker, so we
// intercept it and render our own, then apply via set_model.

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { send } from '../ws';

export function ModelPicker() {
  const open = useStore((s) => s.modelPickerOpen);
  const session = useStore((s) => s.session);
  const [selected, setSelected] = useState(0);

  const models = session?.models ?? [];
  const current = session?.model ?? '';

  useEffect(() => {
    if (!open) return;
    const idx = models.findIndex((m) => m.value === current || m.label === current);
    setSelected(idx >= 0 ? idx : 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const close = () => useStore.setState({ modelPickerOpen: false });

  const choose = (value: string) => {
    send({ t: 'set_model', model: value === 'default' ? undefined : value });
    // Optimistic; the server confirms/reverts with a `model` message.
    useStore.setState((s) =>
      s.session ? { session: { ...s.session, model: value }, modelPickerOpen: false } : { modelPickerOpen: false },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((selected + 1) % models.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((selected - 1 + models.length) % models.length);
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
    <div className="modal-overlay" onClick={close}>
      <div className="modal model-picker" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown} tabIndex={-1} ref={(el) => el?.focus()}>
        <h3>Select model</h3>
        <p className="model-picker-current">
          Current: <code>{current || 'default'}</code>
        </p>
        {models.length === 0 && (
          <p className="model-picker-current">
            Model list not available yet — the engine is still booting. Try again in a moment.
          </p>
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
        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
