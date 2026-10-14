import type { HistoricalOriginBody, SavedAlternativeBody, StageAlternative, StageAlternativeDetail, StageAlternatives, StageOrigin, StageProjection } from "../../local-api/stage-contracts.ts";
import type { TranscriptTurn } from "../../core/types.ts";
import type { StageSession } from "./stage-session.ts";

export type HistoryEditor = { selection: HistoricalOriginBody; action: "manual" | "generate"; performance: string; whisper: string;
  confirmed: boolean; audience: string[]; propose: boolean; revision: number };
export type HistoryCommand = { suffix: string; body: Record<string, unknown>; editor: HistoryEditor; operationId: string | null };
export type HistoryBuffer = { editor: HistoryEditor | null; command: HistoryCommand | null };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class StageHistory {
  editor: HistoryEditor | null = null;
  command: HistoryCommand | null = null;
  origin: StageOrigin | null = null;
  discovery: StageAlternatives | null = null;
  operations: StageAlternative[] = [];
  busy = false;
  error = "";
  notice = "";
  target: StageProjection | null = null;
  private generation = 0;
  private preserveEditorOnNavigation = false;
  private get performanceChanged() {
    return !!this.editor && this.editor.performance !== this.session.projection?.transcript.find(t => t.messageVersionId === this.editor!.selection.messageVersionId)?.text;
  }
  private get whisperChanged() { return !!this.editor && this.editor.whisper !== (this.origin?.completeWhisper ?? ""); }
  private get changed() {
    const turn = this.session.projection?.transcript.find(t => t.messageVersionId === this.editor?.selection.messageVersionId);
    return this.performanceChanged || this.whisperChanged || !!this.editor?.propose || JSON.stringify([...(this.editor?.audience ?? [])].sort()) !== JSON.stringify([...(turn?.audience ?? [])].sort());
  }
  leaveForTarget() {
    this.target = null;
    if (!this.preserveEditorOnNavigation) this.cancel();
    else { this.generation++; this.session.autosave(); }
  }
  private disposed = false;
  private session: StageSession;
  constructor(session: StageSession) { this.session = session; }
  dispose() { this.disposed = true; this.generation++; }
  snapshot(): HistoryBuffer { return copy({ editor: this.editor, command: this.command }); }
  restore(buffer: HistoryBuffer) { this.editor = copy(buffer.editor); this.command = copy(buffer.command); this.generation++; }
  get stale() { return !!this.editor && this.editor.selection.expectedHead !== this.session.projection?.branch.headCommitId; }
  get locked() { return this.busy || !!this.command || this.session.recoveryBlocked; }
  touch() { if (this.editor) this.editor.revision++; this.session.autosave(); }
  async open(turn: TranscriptTurn) {
    if (this.locked || this.session.busy || this.session.needsReconcile || !turn.commitId || !turn.messageVersionId || !turn.logicalMessageId) return;
    if (!this.session.autosave()) return;
    this.editor = { selection: { sourceBranchId: this.session.scope.branchId, expectedHead: this.session.projection!.branch.headCommitId,
      sourceCommitId: turn.commitId, messageVersionId: turn.messageVersionId, logicalMessageId: turn.logicalMessageId, actorId: turn.actorId },
      action: "manual", performance: turn.text, whisper: "", confirmed: false, audience: [...turn.audience], propose: false, revision: 0 };
    this.origin = null; this.discovery = null; this.error = ""; this.notice = ""; this.target = null;
    this.generation++; this.session.autosave();
    await this.refresh();
  }
  cancel() { this.generation++; this.editor = null; this.origin = null; this.discovery = null; this.target = null; this.session.autosave(); }
  async refresh(strict = false) {
    this.error = "";
    const generation = this.generation, editor = this.editor, revision = editor?.revision;
    try {
      const all = await this.session.request<{ operations: StageAlternative[] }>("/alternatives");
      if (this.disposed || generation !== this.generation) return;
      this.operations = all.operations;
      if (!editor) return;
      const [origin, discovery] = await Promise.all([
        this.session.request<StageOrigin>("/alternatives/origin", editor.selection),
        this.session.request<StageAlternatives>(`/alternatives?${new URLSearchParams(editor.selection)}`),
      ]);
      if (this.disposed || generation !== this.generation || this.editor !== editor) return;
      this.origin = origin; this.discovery = discovery;
      if (editor.revision === revision && revision === 0 && origin.completeWhisper !== null) {
        editor.whisper = origin.completeWhisper; editor.confirmed = true; editor.revision++;
      }
      this.session.autosave();
    } catch (error) { if (!this.disposed && generation === this.generation) { this.error = String(error); if (strict) throw error; } }
  }
  async submit() {
    const e = this.editor;
    if (!e || this.locked || this.stale || !this.origin || (e.action === "generate" && !e.confirmed) || (e.action === "manual" && !e.performance.trim())) return;
    const body: SavedAlternativeBody = { ...e.selection, commandId: crypto.randomUUID(), action: e.action,
      audience: e.action === "generate" && e.propose ? null : [...new Set([e.selection.actorId, ...e.audience])],
      ...(e.action === "manual" ? { manualText: e.performance } : { completeWhisper: e.whisper }) };
    this.command = { suffix: "/alternatives", body, editor: copy(e), operationId: null };
    if (!this.session.autosave()) return;
    await this.resume();
  }
  async resume() {
    const command = this.command;
    if (!command || this.busy || this.disposed || !this.session.autosave()) return;
    const generation = this.generation;
    this.busy = true; this.error = "";
    let received = false;
    try {
      // Exact replay never restarts a provider. Pending work is an honest durable state.
      const result = await this.session.request<{ operation: StageAlternativeDetail } | StageAlternativeDetail>(command.suffix, command.body);
      const op = "operation" in result ? result.operation : result;
      received = true;
      if (this.disposed) return;
      command.operationId = op.id;
      this.session.autosave();
      await this.refresh();
      if (op.status === "saved" && op.outcome) {
        const projection = await this.projectionFor(op.outcome.branchId, op.outcome.commitId, { actorId: op.actorId, logicalMessageId: op.logicalMessageId });
        if (this.disposed) return;
        if (!command.suffix.endsWith("/discard") && generation === this.generation && this.editor && JSON.stringify(this.editor) === JSON.stringify(command.editor)) {
          this.preserveEditorOnNavigation = command.suffix === "/alternatives"
            ? command.body.action === "manual" ? this.whisperChanged : this.performanceChanged
            : this.changed;
          this.target = projection;
        }
        else this.notice = "Alternative saved. Newer editor text is preserved; select its path explicitly.";
      } else this.notice = op.status === "pending" ? "Pending operation; no running worker is assumed. Check again or discard it." : `Operation ${op.status}. Your wording remains available.`;
      this.command = null;
      this.session.autosave();
    } catch (error) {
      if (!this.disposed) {
        this.error = String(error);
        if (!received && command.operationId === null && typeof error === "object" && error && "status" in error && Number(error.status) >= 400 && Number(error.status) < 500) {
          this.command = null; this.session.autosave();
        }
      }
    } finally { if (!this.disposed) this.busy = false; }
  }
  private async projectionFor(branchId: string, commitId: string, identity: { actorId: string; logicalMessageId: string; messageVersionId?: string }): Promise<StageProjection> {
    const projection = await this.session.request<StageProjection>(`/stage?branchId=${encodeURIComponent(branchId)}`);
    if (projection.branch.id !== branchId || !projection.transcript.some(t => t.commitId === commitId && t.actorId === identity.actorId && t.logicalMessageId === identity.logicalMessageId && (!identity.messageVersionId || t.messageVersionId === identity.messageVersionId)))
      throw new Error("Saved outcome has not converged with its branch projection. Check again; do not submit another alternative.");
    return projection;
  }
  async cycle(path: StageAlternatives["paths"][number]) {
    if (this.locked || !this.session.autosave()) return;
    const generation = this.generation, revision = this.editor?.revision;
    this.busy = true;
    try {
      const projection = await this.projectionFor(path.branchId, path.commitId, path);
      if (!this.disposed && generation === this.generation && revision === this.editor?.revision) { this.preserveEditorOnNavigation = this.changed; this.target = projection; }
    } catch (error) { if (!this.disposed) this.error = String(error); }
    finally { if (!this.disposed) this.busy = false; }
  }
  async inspectOperation(id: string) {
    const generation = this.generation;
    const op = await this.session.request<StageAlternativeDetail>(`/alternatives/${encodeURIComponent(id)}`);
    if (this.disposed || generation !== this.generation) return;
    this.notice = `Operation ${op.status}. ${op.status === "pending" ? "A running worker is not assumed." : ""}`;
    await this.refresh();
    return op;
  }
  async retry(id: string) {
    if (this.locked || !this.editor) return;
    const editor = this.editor, revision = editor.revision;
    const op = await this.inspectOperation(id);
    if (this.editor !== editor || editor.revision !== revision) return;
    if (!op || !["failed", "discarded"].includes(op.status) || !this.editor) return;
    this.command = { suffix: `/alternatives/${encodeURIComponent(id)}/retry`, body: { commandId: crypto.randomUUID() }, editor: copy(this.editor), operationId: null };
    if (this.session.autosave()) await this.resume();
  }
  async discard(id: string) {
    if (this.locked || !this.editor) return;
    this.command = { suffix: `/alternatives/${encodeURIComponent(id)}/discard`, body: {}, editor: copy(this.editor), operationId: id };
    if (this.session.autosave()) await this.resume();
  }
}
