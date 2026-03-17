import type { AgentEvent } from "./types.ts";

type Listener = (event: AgentEvent) => void;

export interface ApprovalResult {
  approved: boolean;
  reason: "user" | "timeout";
}

interface PendingApproval {
  resolve: (result: ApprovalResult) => void;
}

/**
 * Buffered event emitter for agent events.
 * Stores all events so late-connecting SSE clients get the full history on subscribe.
 * Also supports approval gating: agent waits for user decision before executing tools.
 */
export class AgentEventEmitter {
  private listeners: Set<Listener> = new Set();
  private buffer: AgentEvent[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();

  /** Subscribe — immediately replays all buffered events, then streams new ones. */
  on(listener: Listener): void {
    for (const event of this.buffer) {
      listener(event);
    }
    this.listeners.add(listener);
  }

  off(listener: Listener): void {
    this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    this.buffer.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getBuffer(): readonly AgentEvent[] {
    return this.buffer;
  }

  /**
   * Called by agent — blocks until user approves/rejects or timeout expires.
   * Defaults to reject after 1 hour of no response.
   */
  waitForApproval(requestId: string, timeoutMs = 60 * 60 * 1000): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          resolve({ approved: false, reason: "timeout" });
        }
      }, timeoutMs);

      this.pendingApprovals.set(requestId, {
        resolve: (result: ApprovalResult) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
    });
  }

  /** Called by HTTP handler when user responds. Returns false if requestId not found. */
  resolveApproval(requestId: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    pending.resolve({ approved, reason: "user" });
    return true;
  }
}