import { redact } from './redact.js';
import type { LogEntry } from './views.js';

const MAX_ENTRIES = 500;

/** In-memory, redacted at the door. Nothing unredacted is ever stored here. */
export class EventLog {
  private entries: LogEntry[] = [];
  private nextId = 1;

  add(demoUserId: string | null, kind: LogEntry['kind'], summary: string, detail?: unknown): void {
    this.entries.push({
      id: this.nextId++,
      at: new Date().toISOString(),
      demoUserId,
      kind,
      summary,
      ...(detail === undefined ? {} : { detail: redact(detail) }),
    });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  forUser(demoUserId: string, afterId = 0): LogEntry[] {
    return this.entries.filter((e) => e.demoUserId === demoUserId && e.id > afterId);
  }
}
