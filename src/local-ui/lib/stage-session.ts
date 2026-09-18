import { stageDraft, type ReviseStageDraftBody, type StageDraft, type StageProjection } from "../../local-api/stage-contracts.ts";
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
  private generationDraft: StageDraft | null = null;
  projection: StageProjection | null = null;
  drafts: StageDraft[] = [];
  selectedDraftId: string | null = null;
  private modeRouting = {
    direct: { actorId: "", audienceMode: "unspecified" as "all" | "selected" | "unspecified", audienceIds: [] as string[] },
    perform: { actorId: "", audienceMode: "all" as "all" | "selected" | "unspecified", audienceIds: [] as string[] },
  };
  private retainedReviews = new Map<string, StageDraft>();
  private editorBuffers = new Map<string, string>();
  private correctionBuffers = new Map<string, { audience: string[]; text: string; required: boolean; confirmed: boolean }>();
  correctionAudienceIds: string[] = [];
  correctionText = "";
  audienceRequired = false;
  completeWhisperConfirmed = false;
  get actorId() { return this.modeRouting[this.mode].actorId || this.actors[0]?.id || ""; }
  set actorId(value: string) { this.modeRouting[this.mode].actorId = value; }
  get audienceMode() { return this.modeRouting[this.mode].audienceMode; }
  set audienceMode(value: "all" | "selected" | "unspecified") { this.modeRouting[this.mode].audienceMode = value; }
  get audienceIds() { return this.modeRouting[this.mode].audienceIds; }
  set audienceIds(value: string[]) { this.modeRouting[this.mode].audienceIds = value; }
  selectAllAudience(): void {
    this.audienceMode = "selected";
    this.audienceIds = this.availableAudience.filter(actor => actor.id !== this.actorId).map(actor => actor.id);
  }
  private activeMode: "direct" | "perform" = "direct";
  get mode() { return this.activeMode; }
  set mode(value: "direct" | "perform") {
    if (!this.modeRouting[value].actorId) this.modeRouting[value].actorId = this.actorId;
    this.activeMode = value;
  }
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
  get reviewDrafts(): StageDraft[] {
    return [...this.drafts, ...[...this.retainedReviews.values()].filter(draft => !this.drafts.some(item => item.id === draft.id))];
  }
  get selectedDraft(): StageDraft | null { return this.reviewDrafts.find(draft => draft.id === this.selectedDraftId) || null; }
  get actors() { return playableActors(this.projection?.actors || []); }
  // Explicit per-turn routing uses the authored cast, independently of the
  // persistent presence roster. The API validates every submitted identity.
  get availableAudience() { return this.actors; }
  get resolvedAudience(): string[] {
    return [...new Set([this.actorId, ...(this.audienceMode === "all" ? this.availableAudience.map(actor => actor.id) : this.audienceMode === "selected" ? this.audienceIds : [])])].filter(Boolean);
  }
  get stale(): boolean { return !!this.selectedDraft && !!this.projection && isStaleDraftBasis(this.selectedDraft, this.projection.branch); }
  get unsavedReview(): boolean { return !!this.selectedDraft?.artifact && this.reviewText !== this.selectedDraft.artifact.text; }
  get savedCompleteWhisper(): string | null {
    const review = this.selectedDraft?.routingReview;
    if (!review) return null;
    if (review.completeWhisper !== undefined) return review.completeWhisper;
    return review.sourceDraftId !== null || review.originalWhisper.length > 1 ? null : review.originalWhisper[0] ?? "";
  }
  get whisperChanged(): boolean {
    return this.correctionText !== (this.savedCompleteWhisper ?? "") || (this.savedCompleteWhisper === null && this.completeWhisperConfirmed);
  }
  get audienceChanged(): boolean {
    const draft = this.selectedDraft;
    return !!draft && JSON.stringify([...new Set([draft.actorId, ...this.correctionAudienceIds])].sort()) !== JSON.stringify([...draft.audience].sort());
  }
  get hasCorrectionChanges(): boolean {
    const review = this.selectedDraft?.routingReview;
    return !!review && (this.whisperChanged || this.audienceChanged || this.audienceRequired !== (review.correctedAudience !== null));
  }
  setAudienceRequired(required: boolean): void {
    this.audienceRequired = required;
    if (!required) this.correctionAudienceIds = this.selectedDraft?.audience.filter(id => id !== this.selectedDraft?.actorId) ?? [];
  }
  hasBufferedReview(id: string): boolean {
    return this.editorBuffers.has(id) || this.correctionBuffers.has(id);
  }
  get unsaved(): boolean { return this.editorBuffers.size > 0 || this.correctionBuffers.size > 0 || this.unsavedReview || this.hasCorrectionChanges || !!this.direction.trim() || !!this.performance.trim(); }
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
      let generated = recovery.drafts.find(draft => draft.generationCommandId === this.generationId);
      // Finished records disappear from discovery, regardless of which draft is
      // selected. Retain and refresh the identity associated with the live lease.
      if (!generated && this.generationDraft?.generationCommandId === this.generationId) {
        generated = await this.request<StageDraft>(`/drafts/${encodeURIComponent(this.generationDraft.id)}`);
        if (this.disposed || version !== this.refreshVersion) return;
      }
      // Selection and editor text can change during either terminal read. Gather
      // missing records without applying them, rechecking selection after each await.
      const terminalReads = new Map<string, StageDraft>();
      if (generated) terminalReads.set(generated.id, stageDraft(generated));
      while (true) {
        const selected = this.reviewDrafts.find(draft =>
          (this.editorBuffers.has(draft.id) || this.correctionBuffers.has(draft.id) ||
            (draft.id === this.selectedDraftId && (this.pending || this.unsavedReview || this.hasCorrectionChanges))) &&
          !recovery.drafts.some(item => item.id === draft.id) && !terminalReads.has(draft.id));
        if (!selected) break;
        const terminal = await this.request<StageDraft>(`/drafts/${encodeURIComponent(selected.id)}`);
        if (this.disposed || version !== this.refreshVersion) return;
        terminalReads.set(selected.id, stageDraft(terminal));
      }
      // No awaits below: preserve the CURRENT editor, and retain a terminal record
      // only if the current selection still needs it for review or reconciliation.
      const previous = this.selectedDraft;
      const textDirty = this.unsavedReview;
      const dirty = textDirty || this.hasCorrectionChanges;
      if (previous && (this.pending || dirty) && !recovery.drafts.some(draft => draft.id === previous.id)) {
        const terminal = terminalReads.get(previous.id);
        if (terminal) recovery.drafts.push(terminal);
      }
      for (const [id, terminal] of terminalReads) {
        if (this.hasBufferedReview(id)) this.retainedReviews.set(id, terminal);
      }
      this.projection = projection;
      this.drafts = recovery.drafts;
      if (generated?.generationCommandId === this.generationId) this.generationDraft = stageDraft(generated);
      if (!this.actorId) this.actorId = this.actors[0]?.id || "";
      if (!this.initialized) {
        this.selectDraft(this.drafts[0]?.id || null);
        if (this.selectedDraft) {
          this.actorId = this.selectedDraft.actorId;
          const initial = this.selectedDraft.routingReview ? this.selectedDraft.routingReview.initialAudience : this.selectedDraft.audience;
          this.audienceMode = initial === null ? "unspecified" : "selected";
          this.audienceIds = (initial || []).filter(id => id !== this.actorId);
        }
        this.initialized = true;
      } else {
        if (this.selectedDraft) {
          if (!textDirty) this.reviewText = this.selectedDraft.artifact?.text || "";
          if (!dirty && previous && !previous.artifact && this.selectedDraft.artifact) {
            this.correctionAudienceIds = this.selectedDraft.audience.filter(id => id !== this.selectedDraft!.actorId);
            this.correctionText = this.savedCompleteWhisper ?? "";
            this.audienceRequired = this.selectedDraft.routingReview?.correctedAudience != null;
            this.completeWhisperConfirmed = false;
          }
        } else if (!dirty) this.selectDraft(null);
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
    const generated = this.generationDraft;
    if (!generated || generated.generationCommandId !== this.generationId) return;
    if (generated.status === "accepted" || generated.status === "discarded") this.commands.succeed("generate");
    else if (!settleGenerationLease(this.commands, generated.status)) return;
    this.generationId = null;
    this.generationDraft = null;
  }
  selectDraft(id: string | null): void {
    if (this.selectedDraftId) {
      if (this.unsavedReview) this.editorBuffers.set(this.selectedDraftId, this.reviewText);
      else this.editorBuffers.delete(this.selectedDraftId);
      if (this.hasCorrectionChanges) this.correctionBuffers.set(this.selectedDraftId, { audience: [...this.correctionAudienceIds], text: this.correctionText, required: this.audienceRequired, confirmed: this.completeWhisperConfirmed });
      else this.correctionBuffers.delete(this.selectedDraftId);
    }
    if (this.selectedDraft) {
      if (this.hasBufferedReview(this.selectedDraft.id)) this.retainedReviews.set(this.selectedDraft.id, this.selectedDraft);
      else this.retainedReviews.delete(this.selectedDraft.id);
    }
    if (this.selectedDraftId !== id) this.notice = "";
    this.selectedDraftId = id;
    this.reviewText = (id ? this.editorBuffers.get(id) : undefined) ?? this.selectedDraft?.artifact?.text ?? "";
    const correction = id ? this.correctionBuffers.get(id) : undefined;
    this.correctionAudienceIds = correction?.audience || this.selectedDraft?.audience.filter(actor => actor !== this.selectedDraft?.actorId) || [];
    this.correctionText = correction?.text ?? this.savedCompleteWhisper ?? "";
    this.audienceRequired = correction?.required ?? (this.selectedDraft?.routingReview?.correctedAudience != null);
    this.completeWhisperConfirmed = correction?.confirmed ?? false;
    this.editing = false;
  }
  clearReviewChanges(): void {
    if (!this.selectedDraft) return;
    const draft = this.selectedDraft;
    const completeWhisper = this.savedCompleteWhisper;
    this.retainedReviews.delete(draft.id);
    this.editorBuffers.delete(draft.id);
    this.correctionBuffers.delete(draft.id);
    this.reviewText = draft.artifact?.text || "";
    this.correctionAudienceIds = draft.audience.filter(id => id !== draft.actorId);
    this.correctionText = completeWhisper ?? "";
    this.audienceRequired = draft.routingReview?.correctedAudience != null;
    this.completeWhisperConfirmed = false;
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
    const basis = { ...this.input(), audience: this.audienceMode === "unspecified" ? null : this.resolvedAudience, draftingPolicy: "audience-proposal-v1" };
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
      if (this.generationId !== commandId) this.generationDraft = null;
      this.generationId = commandId;
      const result = await this.request<{ draft: StageDraft }>("/drafts", { ...input, commandId });
      await this.receiveGeneratedDraft(result.draft);
      if (!this.disposed && this.direction.trim() === direction) this.direction = "";
    });
  }
  private async receiveGeneratedDraft(draft: StageDraft): Promise<void> {
    if (draft.generationCommandId === this.generationId) this.generationDraft = stageDraft(draft);
    await this.refresh();
    if (this.disposed) return;
    if (!this.drafts.some(item => item.id === draft.id) && ["ready", "failed", "generating"].includes(draft.status)) this.drafts.push(stageDraft(draft));
    this.selectDraft(draft.id);
  }
  async retry(): Promise<void> {
    const original = this.selectedDraft;
    if (!original || !["ready", "failed", "generating"].includes(original.status) || this.stale || this.hasCorrectionChanges || this.busy || this.pending) return;
    const input = { draftId: original.id };
    await this.execute(async () => {
      await runLeasedMutation(this.commands, "retry", input,
        commandId => this.request<{ draft: StageDraft }>(`/drafts/${encodeURIComponent(original.id)}/retry`, { commandId }),
        result => this.receiveGeneratedDraft(result.draft));
      if (!this.disposed) this.notice = "New draft selected. The earlier draft remains in Saved drafts.";
    });
  }
  async revise(preserveWording: boolean): Promise<void> {
    const original = this.selectedDraft;
    if (!original?.routingReview || original.status !== "ready" || this.stale || this.busy || this.pending) return;
    if (this.savedCompleteWhisper === null && !this.completeWhisperConfirmed && !this.correctionText.trim()) return;
    if (preserveWording && this.whisperChanged) return;
    const input = { draftId: original.id, audience: this.audienceRequired || this.audienceChanged || preserveWording ? [...this.correctionAudienceIds] : null, completeWhisper: this.correctionText,
      ...(preserveWording ? { preservedText: this.reviewText } : {}) };
    if (preserveWording && !this.reviewText.trim()) return;
    await this.execute(async () => {
      await runLeasedMutation(this.commands, "revise", input,
        commandId => this.request<{ draft: StageDraft }>(`/drafts/${encodeURIComponent(original.id)}/revise`, {
          commandId, audience: input.audience, completeWhisper: input.completeWhisper,
          ...(input.preservedText === undefined ? {} : { preservedText: input.preservedText }),
        } satisfies ReviseStageDraftBody), result => this.receiveGeneratedDraft(result.draft));
      if (!this.disposed) this.notice = "Replacement candidate selected. Review its exact wording and recipients before accepting.";
    });
  }
  async accept(): Promise<void> {
    const draft = this.selectedDraft;
    if (!draft?.artifact || draft.status !== "ready" || this.stale || this.hasCorrectionChanges || !this.reviewText.trim() || this.busy || this.pending) return;
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
