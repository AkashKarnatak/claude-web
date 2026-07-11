// canUseTool → permission_request round-trip (ARCHITECTURE.md §8).
// The engine's canUseTool callback blocks until the user answers in the
// browser; this broker holds the pending resolvers keyed by reqId.

import { randomUUID } from 'node:crypto';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

export interface PendingPermission {
  reqId: string;
  tool: string;
  input: Record<string, unknown>;
}

interface PendingEntry extends PendingPermission {
  resolve: (result: PermissionResult) => void;
}

export class PermissionBroker {
  private pending = new Map<string, PendingEntry>();

  constructor(
    private emit: (req: PendingPermission) => void,
    private emitResolved: (reqId: string) => void,
  ) {}

  /** Called from the SDK's canUseTool. Resolves when the user decides. */
  request(
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PermissionResult> {
    const reqId = randomUUID();
    return new Promise<PermissionResult>((resolve) => {
      const entry: PendingEntry = { reqId, tool, input, resolve };
      this.pending.set(reqId, entry);
      // If the engine aborts the turn (interrupt), deny so it can unwind.
      signal?.addEventListener('abort', () => {
        this.settle(reqId, { behavior: 'deny', message: 'Turn interrupted' });
      });
      this.emit({ reqId, tool, input });
    });
  }

  /** Called when the browser sends a `permission` client message. */
  decide(
    reqId: string,
    decision: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    reason?: string,
  ): void {
    const entry = this.pending.get(reqId);
    if (!entry) return;
    this.settle(
      reqId,
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: updatedInput ?? entry.input }
        : { behavior: 'deny', message: reason || 'Denied by user' },
    );
  }

  /** Pending requests, so a client that (re)connects can re-render prompts. */
  list(): PendingPermission[] {
    return [...this.pending.values()].map(({ reqId, tool, input }) => ({ reqId, tool, input }));
  }

  /** Deny everything outstanding (used on session teardown). */
  denyAll(message: string): void {
    for (const reqId of [...this.pending.keys()]) {
      this.settle(reqId, { behavior: 'deny', message });
    }
  }

  private settle(reqId: string, result: PermissionResult): void {
    const entry = this.pending.get(reqId);
    if (!entry) return;
    this.pending.delete(reqId);
    entry.resolve(result);
    this.emitResolved(reqId);
  }
}
