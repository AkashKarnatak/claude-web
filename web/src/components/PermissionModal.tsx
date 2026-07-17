// In-browser approval prompt for the canUseTool round-trip
// (ARCHITECTURE.md §8) — anchored above the chat input like the TUI's
// footer prompts, not a centered modal. Shows the first pending request.
// AskUserQuestion gets an interactive answer picker instead of Allow/Deny.

import { useStore } from '../store';
import { send } from '../ws';
import { parseQuestions, QuestionPrompt } from './QuestionPrompt';

export function PermissionModal() {
  const permissions = useStore((s) => s.permissions);
  const req = permissions[0];
  if (!req) return null;

  if (req.tool === 'AskUserQuestion') {
    const questions = parseQuestions(req.input);
    // keyed by reqId so answer state never leaks across requests
    if (questions) return <QuestionPrompt key={req.reqId} req={req} questions={questions} />;
  }

  const decide = (decision: 'allow' | 'deny') =>
    send({ t: 'permission', reqId: req.reqId, decision });

  const input = req.input as Record<string, unknown> | null;
  const command = input && typeof input.command === 'string' ? input.command : null;

  return (
    <div className="permission-popover">
      <div className="permission-header">
        Claude wants to run <strong>{req.tool}</strong>
        {permissions.length > 1 && (
          <span className="permission-queue"> · {permissions.length - 1} more pending</span>
        )}
      </div>
      <pre className="permission-input">{command ?? JSON.stringify(req.input, null, 2)}</pre>
      <div className="permission-actions">
        <button className="btn deny" onClick={() => decide('deny')}>
          Deny
        </button>
        <button className="btn allow" onClick={() => decide('allow')} autoFocus>
          Allow
        </button>
      </div>
    </div>
  );
}
