import { stageDraft, type StageDraft, type StageProjection } from "../../local-api/stage-contracts.ts";
import {
  acceptDraftBody, createCommandLease, isStaleDraftBasis, playableActors,
  runLeasedMutation, settleGenerationLease, type CommandAction,
} from "./stage-play.ts";

export class StageApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export type StageScope = { apiBase: string; simulationId: string; branchId: string };

/** Each instance owns one immutable API/run/branch scope, including its command leases. */
export class StageSession {
  readonly scope: StageScope;
  private fetcher: typeof fetch;
  private disposed = false;
  private refreshVersion = 0;
  private initialized = false;
  private commands = createCommandLease(() => crypto.randomUUID());
  private pending: (() => Promise<void>) | null = null;
  private generationId: string | null = null;
  projection: StageProjection | null = null;
  drafts: StageDraft[] = [];
  selectedDraftId: string | null = null;
  actorId = "";
  audienceMode: "all" | "selected" = "all";
  audienceIds: string[] = [];
  mode: "direct" | "perform" = "direct";
  direction = "";
  performance = "";
  reviewText = "";
  editing = false;
  busy = false;
  error = "";
  notice = "";

  constructor(scope: StageScope, fetcher: typeof fetch = fetch) {
    this.scope = Object.freeze({ ...scope });
    this.fetcher = fetcher;
  }
  get selectedDraft(): StageDraft | null { return this.drafts.find(draft => draft.id === this.selectedDraftId) || null; }
  get actors() { return playableActors(this.projection?.actors || []); }
  // Explicit per-turn routing uses the authored cast, independently of the
  // persistent presence roster. The API validates every submitted identity.
  get availableAudience() { return this.actors; }
  get resolvedAudience(): string[] {
    return [...new Set([this.actorId, ...(this.audienceMode === "all" ? this.availableAudience.map(actor => actor.id) : this.audienceIds)])].filter(Boolean);
  }
  get stale(): boolean { return !!this.selectedDraft && !!this.projection && isStaleDraftBasis(this.selectedDraft, this.projection.branch); }
  get unsavedReview(): boolean { return !!this.selectedDraft?.artifact && this.reviewText !== this.selectedDraft.artifact.text; }
  get unsaved(): boolean { return this.unsavedReview || !!this.direction.trim() || !!this.performance.trim(); }
  get needsReconcile(): boolean { return this.pending !== null; }
  dispose(): void { this.disposed = true; this.refreshVersion++; }

  async request<T>(suffix: string, body?: Record<string, unknown>): Promise<T> {
    const fetcher = this.fetcher;
    const response = await fetcher(`${this.scope.apiBase.replace(/\/$/, "")}/simulations/${encodeURIComponent(this.scope.simulationId)}${suffix}`, {
      method: body ? "POST" : "GET",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new StageApiError(response.status, result.error || `Request failed (${response.status}).`);
    return result as T;
  }

  /** Apply both reads together; never replace a dirty editor with saved artifact text. */
  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    try {
      const query = `?branchId=${encodeURIComponent(this.scope.branchId)}`;
      const [projection, recovery] = await Promise.all([
        this.request<StageProjection>(`/stage${query}`),
        this.request<{ drafts: StageDraft[] }>(`/drafts${query}`),
      ]);
      if (this.disposed || version !== this.refreshVersion) return;
      const previous = this.selectedDraft;
      const dirty = this.unsavedReview;
      // Terminal records are absent from discovery. Read the selected record to
      // preserve dirty text without pretending the saved draft is still pending.
      if (previous && (this.pending || dirty) && !recovery.drafts.some(draft => draft.id === previous.id)) {
        const terminal = await this.request<StageDraft>(`/drafts/${encodeURIComponent(previous.id)}`);
        if (this.disposed || version !== this.refreshVersion) return;
        recovery.drafts.push(stageDraft(terminal));
      }
      this.projection = projection;
      this.drafts = recovery.drafts;
      if (!this.actorId) this.actorId = this.actors[0]?.id || "";
      if (!this.initialized) {
        this.selectDraft(this.drafts[0]?.id || null);
        if (this.selectedDraft) {
          this.actorId = this.selectedDraft.actorId;
          this.audienceMode = "selected";
          this.audienceIds = this.selectedDraft.audience.filter(id => id !== this.actorId);
        }
        this.initialized = true;
      } else if (!dirty) {
        if (this.selectedDraft) this.reviewText = this.selectedDraft.artifact?.text || "";
        else this.selectDraft(null);
      }
      this.settleGenerationIfConverged();
    } catch (error) {
      if (!this.disposed && version === this.refreshVersion) {
        this.error = error instanceof Error ? error.message : "Could not refresh Stage.";
        throw error;
      }
    }
  }
  private settleGenerationIfConverged(): void {
    // Discovery may find a completed draft after its POST response was lost.
    // Keep that command leased until the pending operation itself converges.
    if (this.pending) return;
    const generated = this.drafts.find(draft => draft.generationCommandId === this.generationId);
    if (generated && settleGenerationLease(this.commands, generated.status)) this.generationId = null;
  }
  selectDraft(id: string | null): void {
    if (this.selectedDraftId !== id) this.notice = "";
    this.selectedDraftId = id;
    this.reviewText = this.selectedDraft?.artifact?.text || "";
    this.editing = false;
  }
  compose(): void { if (!this.busy && !this.pending) this.selectDraft(null); }

  private async execute(operation: () => Promise<void>): Promise<void> {
    if (this.busy || this.pending || this.disposed) return;
    this.notice = "";
    this.pending = operation;
    await this.resume();
  }
  async resume(): Promise<void> {
    if (this.busy || !this.pending || this.disposed) return;
    this.busy = true;
    this.error = "";
    try {
      await this.pending();
      if (!this.disposed) {
        this.pending = null;
        this.settleGenerationIfConverged();
      }
    } catch (error) {
      if (this.disposed) return;
      this.error = error instanceof Error ? error.message : "The request did not converge.";
      if (error instanceof StageApiError && error.status >= 400 && error.status < 500) {
        this.pending = null;
        try { await this.refresh(); } catch { /* retain the refresh error */ }
      }
    } finally { if (!this.disposed) this.busy = false; }
  }
  private input() {
    if (!this.projection || !this.actors.some(actor => actor.id === this.actorId)) throw new Error("Choose a valid actor.");
    if (this.audienceMode === "selected" && this.audienceIds.some(id => !this.availableAudience.some(actor => actor.id === id) && id !== this.actorId))
      throw new Error("Audience changed. Choose available actors before submitting.");
    return { branchId: this.scope.branchId, expectedHead: this.projection.branch.headCommitId, actorId: this.actorId, audience: this.resolvedAudience };
  }
  async perform(): Promise<void> {
    if (!this.performance.trim() || this.busy || this.pending) return;
    const text = this.performance;
    const input = { ...this.input(), manualText: text, stageWhisperIds: [] };
    await this.execute(async () => {
      await runLeasedMutation(this.commands, "perform", input,
        commandId => this.request("/turns", { ...input, commandId }),
        () => this.refresh());
      if (this.disposed) return;
      if (this.performance === text) this.performance = "";
      this.notice = "Performed.";
    });
  }
  async generate(): Promise<void> {
    if (this.busy || this.pending) return;
    const basis = this.input();
    const direction = this.direction.trim();
    let whisperId: string | null = null;
    await this.execute(async () => {
      if (direction && !whisperId) {
        const whisperInput = { branchId: basis.branchId, expectedHead: basis.expectedHead, targetActorId: basis.actorId, text: direction };
        const whisper = await this.request<{ id: string }>("/whispers", { ...whisperInput, commandId: this.commands.for("whisper", whisperInput) });
        whisperId = whisper.id;
        this.commands.succeed("whisper");
      }
      if (this.disposed) return;
      const input = { ...basis, stageWhisperIds: whisperId ? [whisperId] : [] };
      const commandId = this.commands.for("generate", input);
      this.generationId = commandId;
      const result = await this.request<{ draft: StageDraft }>("/drafts", { ...input, commandId });
      await this.receiveGeneratedDraft(result.draft);
      if (!this.disposed && this.direction.trim() === direction) this.direction = "";
    });
  }
  private async receiveGeneratedDraft(draft: StageDraft): Promise<void> {
    await this.refresh();
    if (this.disposed) return;
    if (!this.drafts.some(item => item.id === draft.id) && ["ready", "failed", "generating"].includes(draft.status)) this.drafts.push(stageDraft(draft));
    this.selectDraft(draft.id);
  }
  async retry(): Promise<void> {
    const original = this.selectedDraft;
    if (!original || this.stale || this.busy || this.pending) return;
    const input = { draftId: original.id };
    await this.execute(async () => {
      await runLeasedMutation(this.commands, "retry", input,
        commandId => this.request<{ draft: StageDraft }>(`/drafts/${encodeURIComponent(original.id)}/retry`, { commandId }),
        result => this.receiveGeneratedDraft(result.draft));
      if (!this.disposed) this.notice = "New draft selected. The earlier draft remains in Saved drafts.";
    });
  }
  async accept(): Promise<void> {
    const draft = this.selectedDraft;
    if (!draft?.artifact || draft.status !== "ready" || this.stale || !this.reviewText.trim() || this.busy || this.pending) return;
    const body = acceptDraftBody("", draft.artifact.text, this.reviewText);
    const input = { draftId: draft.id, ...(body.finalText === undefined ? {} : { finalText: body.finalText }) };
    await this.finishDraft("accept", draft, input, commandId => ({ ...body, commandId }));
  }
  async discard(): Promise<void> {
    const draft = this.selectedDraft;
    if (!draft || this.busy || this.pending) return;
    await this.finishDraft("discard", draft, { draftId: draft.id }, commandId => ({ commandId }));
  }
  private async finishDraft(action: CommandAction, draft: StageDraft, input: { draftId: string; finalText?: string }, body: (commandId: string) => Record<string, unknown>): Promise<void> {
    await this.execute(async () => {
      await runLeasedMutation(this.commands, action, input,
        commandId => this.request(`/drafts/${encodeURIComponent(draft.id)}/${action}`, body(commandId)),
        () => this.refresh());
      if (this.disposed) return;
      this.drafts = this.drafts.filter(item => item.id !== draft.id);
      this.selectDraft(null);
      this.notice = action === "accept" ? "Accepted." : "Discarded.";
    });
  }
}
