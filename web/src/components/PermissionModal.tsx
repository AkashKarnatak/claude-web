// In-browser approval prompt for the canUseTool round-trip
// (ARCHITECTURE.md §8). Shows the first pending request.

import { useStore } from '../store';
import { send } from '../ws';

export function PermissionModal() {
  const permissions = useStore((s) => s.permissions);
  const req = permissions[0];
  if (!req) return null;

  const decide = (decision: 'allow' | 'deny') =>
    send({ t: 'permission', reqId: req.reqId, decision });

  const input = req.input as Record<string, unknown> | null;
  const command = input && typeof input.command === 'string' ? input.command : null;

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Permission request</h3>
        <p>
          Claude wants to run <strong>{req.tool}</strong>
          {permissions.length > 1 && (
            <span className="modal-queue"> ({permissions.length - 1} more pending)</span>
          )}
        </p>
        <pre className="modal-input">
          {command ?? JSON.stringify(req.input, null, 2)}
        </pre>
        <div className="modal-actions">
          <button className="btn deny" onClick={() => decide('deny')}>
            Deny
          </button>
          <button className="btn allow" onClick={() => decide('allow')} autoFocus>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
