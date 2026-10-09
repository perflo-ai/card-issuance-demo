import { redact } from './redact.js';
import type { LogEntry } from './views.js';

const MAX_ENTRIES = 500;

/** In-memory, redacted at the door. Nothing unredacted is ever stored here. */
export class EventLog {
  private entries: LogEntry[] = [];
  private nextId = 1;

  /**
   * With `collapse`, an entry that says exactly what this person's previous
   * entry said is not added again: while a status is being watched, the log
   * shows one line per change, not one per look.
   */
  add(demoUserId: string | null, kind: LogEntry['kind'], summary: string, detail?: unknown, options: { collapse?: boolean } = {}): void {
    const entry: LogEntry = {
      id: 0,
      at: new Date().toISOString(),
      demoUserId,
      kind,
      summary,
      ...(detail === undefined ? {} : { detail: redact(detail) }),
    };
    if (options.collapse && this.sameAsPrevious(entry)) return;
    entry.id = this.nextId++;
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  private sameAsPrevious(entry: LogEntry): boolean {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const previous = this.entries[i];
      if (previous?.demoUserId !== entry.demoUserId) continue;
      return (
        previous.kind === entry.kind &&
        previous.summary === entry.summary &&
        JSON.stringify(previous.detail) === JSON.stringify(entry.detail)
      );
    }
    return false;
  }

  forUser(demoUserId: string, afterId = 0): LogEntry[] {
    return this.entries.filter((e) => e.demoUserId === demoUserId && e.id > afterId);
  }
}
