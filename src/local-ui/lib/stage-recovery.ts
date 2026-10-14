import type { StageRecoveryIdentity } from "../../local-api/stage-contracts.ts";

export type RecoveryScope = StageRecoveryIdentity & { apiBase: string; simulationId: string; branchId: string };
export type RecoveryRecord<T> = { version: 1; scope: RecoveryScope; writer: string; clock: Record<string, number>; data: T };
export type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "key" | "length">;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dominates = (a: Record<string, number>, b: Record<string, number>) => Object.entries(b).every(([id, n]) => (a[id] ?? 0) >= n);

/** One slot per tab, vector clocks detect even simultaneous read/write races.
 * No last-writer-wins, automatic merging, expiry or eviction of other buffers. */
export class StageRecovery<T> {
  readonly prefix: string;
  readonly writer: string;
  private clock: Record<string, number> = {};
  private serialized = "";
  warning = "";
  saved = false;
  conflicts: RecoveryRecord<T>[] = [];
  readonly scope: RecoveryScope;
  private storage: BrowserStorage;
  private validate: (value: unknown) => value is T;
  constructor(scope: RecoveryScope, storage: BrowserStorage,
    validate: (value: unknown) => value is T, writer: string = crypto.randomUUID()) {
    this.scope = scope; this.storage = storage; this.validate = validate;
    this.writer = writer;
    this.prefix = `doxvelt.stage.v1:${encodeURIComponent(JSON.stringify(scope))}:`;
  }
  private records(): RecoveryRecord<T>[] {
    const result: RecoveryRecord<T>[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(this.prefix)) continue;
      const r = JSON.parse(this.storage.getItem(key) ?? "null") as RecoveryRecord<T>;
      if (!r || Object.keys(r).sort().join() !== ["version", "scope", "writer", "clock", "data"].sort().join() || r.version !== 1 || !same(r.scope, this.scope) || typeof r.writer !== "string" || key !== this.prefix + r.writer ||
        !r.clock || Array.isArray(r.clock) || !Object.keys(r.clock).every(k => /^[a-zA-Z0-9_-]+$/.test(k) && !["__proto__", "constructor", "prototype"].includes(k)) || !Object.values(r.clock).every(n => Number.isSafeInteger(n) && n >= 0) ||
        !r.clock[r.writer] || !this.validate(r.data)) throw new Error("Corrupt or unsupported Stage recovery record. Copy current text before resolving browser storage.");
      result.push(r);
    }
    return result;
  }
  private heads(records: RecoveryRecord<T>[]) {
    return records.filter(r => !records.some(other => other !== r && dominates(other.clock, r.clock) && !dominates(r.clock, other.clock)));
  }
  load(): T | null {
    try {
      const heads = this.heads(this.records());
      this.conflicts = heads.length > 1 ? heads : [];
      if (this.conflicts.length) throw new Error("Another tab has conflicting Stage buffers. Both versions are retained; choose a version explicitly.");
      const r = heads[0];
      if (!r) return null;
      this.clock = { ...r.clock };
      this.serialized = JSON.stringify(r.data);
      this.saved = true;
      return r.data;
    } catch (error) { this.fail(error); return null; }
  }
  check(): boolean {
    try {
      const heads = this.heads(this.records());
      const foreign = heads.filter(r => !dominates(this.clock, r.clock));
      if (foreign.length) {
        this.conflicts = heads;
        throw new Error("Stage changed in another tab. Your in-memory text and the stored versions are retained. Resolve before continuing.");
      }
      this.conflicts = [];
      return true;
    } catch (error) { this.fail(error); return false; }
  }
  save(data: T): boolean {
    // Publish our version even when a concurrent writer won the first check.
    // Its separate slot is untouched, so both versions remain recoverable.
    try {
      if (!this.validate(data)) throw new Error("Invalid Stage recovery state; text remains in memory.");
      if (!this.check()) {
        if (this.conflicts.length) this.write(data);
        return false;
      }
      if (JSON.stringify(data) !== this.serialized || !this.records().some(r => dominates(r.clock, this.clock) && JSON.stringify(r.data) === this.serialized)) this.write(data);
      if (!this.check()) return false;
      this.saved = true; this.warning = "";
      return true;
    } catch (error) { this.fail(error); return false; }
  }
  private write(data: T): void {
    const clock = { ...this.clock, [this.writer]: (this.clock[this.writer] ?? 0) + 1 };
    const record: RecoveryRecord<T> = { version: 1, scope: this.scope, writer: this.writer, clock, data };
    this.storage.setItem(this.prefix + this.writer, JSON.stringify(record));
    this.clock = clock; this.serialized = JSON.stringify(data);
  }
  reviseConflict(record: RecoveryRecord<T>, data: T): void {
    const writer = crypto.randomUUID();
    const next: RecoveryRecord<T> = { version: 1, scope: this.scope, writer, clock: { ...record.clock, [writer]: 1 }, data };
    this.storage.setItem(this.prefix + writer, JSON.stringify(next));
    this.conflicts = this.heads(this.records());
  }
  /** Caller first reconciles server state; choosing does not merge editor text. */
  resolve(data: T): boolean {
    try {
      for (const r of this.records()) for (const [id, n] of Object.entries(r.clock)) this.clock[id] = Math.max(this.clock[id] ?? 0, n);
      this.serialized = "";
      return this.save(data);
    } catch (error) { this.fail(error); return false; }
  }
  private fail(error: unknown) {
    this.saved = false;
    this.warning = error instanceof Error ? error.message : "Browser storage failed. Text remains in memory; copy it out.";
  }
}
