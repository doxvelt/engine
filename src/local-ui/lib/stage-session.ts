import { StageHistory } from "./stage-history.ts";
import { StageRecovery, type BrowserStorage } from "./stage-recovery.ts";
import { validStageBuffer, type StageBuffer, type FrozenRequest } from "./stage-buffer.ts";
import type { StageRecoveryIdentity } from "../../local-api/stage-contracts.ts";
import { ACTOR_KNOWLEDGE_POLICY, type GenerateStageDraftBody, type PerformStageTurnBody, stageDraft, type ReviseStageDraftBody, type StageDraft, type StageProjection } from "../../local-api/stage-contracts.ts";
import {
  CommandConvergenceError, acceptDraftBody, createCommandLease, isStaleDraftBasis, playableActors,
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
  history: StageHistory;
  recovery: StageRecovery<StageBuffer> | null = null;
  recoveryWarning = "";
  recoveryReady = true;
  continuationBasis = "";
  private recoveryRequired = false;
  private requests: FrozenRequest[] = [];
  private mutationEditor = "";
  private editorIdentity() { return JSON.stringify({ selected: this.selectedDraftId, review: this.reviewText, correction: this.correctionText,
    audience: this.correctionAudienceIds, required: this.audienceRequired, confirmed: this.completeWhisperConfirmed, direction: this.direction, performance: this.performance, mode: this.mode, routing: this.modeRouting }); }
  private restoring = false;
  private awaitingRecovery: StageBuffer | null = null;
  get recoveryBlocked() { return this.recoveryRequired && (!this.recoveryReady || !!this.recoveryWarning || !!this.recovery?.warning || !!this.recovery?.conflicts.length); }
  get continuationStale() { return !!this.continuationBasis && this.continuationBasis !== this.projection?.branch.headCommitId; }
  snapshot(): StageBuffer {
    const reviews = this.reviewDrafts.filter(d => this.hasBufferedReview(d.id) || d.id === this.selectedDraftId).map(d => ({
      id: d.id, basis: d.basisHeadCommitId,
      text: d.id === this.selectedDraftId ? this.reviewText : this.editorBuffers.get(d.id) ?? d.artifact?.text ?? "",
      correction: d.id === this.selectedDraftId ? { audience: [...this.correctionAudienceIds], text: this.correctionText, required: this.audienceRequired, confirmed: this.completeWhisperConfirmed }
        : this.correctionBuffers.get(d.id) ?? { audience: d.audience.filter(id => id !== d.actorId), text: d.routingReview?.completeWhisper ?? "", required: d.routingReview?.correctedAudience != null, confirmed: false },
    }));
    return JSON.parse(JSON.stringify({ basis: this.continuationBasis, mode: this.mode, routing: this.modeRouting, direction: this.direction,
      performance: this.performance, selected: this.selectedDraftId, editing: this.editing, reviews, history: this.history.snapshot(), requests: this.requests }));
  }
  copyOut() { return { scope: this.recovery?.scope ?? this.scope, current: this.snapshot(), awaitingAuthoritativeRecovery: this.awaitingRecovery }; }
  autosave(): boolean {
    if (this.disposed) return false;
    if (!this.recoveryRequired) return true;
    if (this.restoring || !this.recoveryReady || !this.recovery) return false;
    return this.recovery.save(this.snapshot());
  }
  blockRecovery(message: string) { this.recoveryRequired = true; this.recoveryReady = false; this.recoveryWarning = message; }
  async enableRecovery(storage: BrowserStorage): Promise<void> {
    this.recoveryRequired = true; this.recoveryReady = false;
    try {
      const response = await this.fetcher(`${this.scope.apiBase.replace(/\/$/, "")}/recovery-identity`);
      if (!response.ok) throw new Error("Cannot establish installation and owner identity. Local recovery is unavailable.");
      const identity = await response.json() as StageRecoveryIdentity;
      if (typeof identity.installationId !== "string" || !identity.installationId || typeof identity.ownerId !== "string" || !identity.ownerId) throw new Error("Invalid recovery identity.");
      if (this.disposed) return;
      this.recovery = new StageRecovery({ ...identity, ...this.scope }, storage, validStageBuffer);
      const buffer = this.recovery.load();
      this.awaitingRecovery = buffer;
      await this.refresh();
      if (this.disposed) return;
      if (buffer) await this.restoreBuffer(buffer);
      else await this.history.refresh(true);
      if (this.disposed) return;
      this.awaitingRecovery = null;
      this.recoveryReady = true;
      if (!this.recovery.warning) this.autosave();
    } catch (error) { if (!this.disposed) this.recoveryWarning = String(error); }
  }
  private async restoreBuffer(buffer: StageBuffer): Promise<void> {
    if (!validStageBuffer(buffer) || !this.projection) throw new Error("Invalid recovery buffer or missing authoritative projection.");
    const editorBefore = this.editorIdentity();
    const historyBefore = JSON.stringify(this.history.snapshot());
    this.restoring = true;
    try {
      const details = await Promise.all(buffer.reviews.map(r => this.request<StageDraft>(`/drafts/${encodeURIComponent(r.id)}`)));
      if (this.disposed) return;
      if (editorBefore !== this.editorIdentity()) throw new Error("Newer typing arrived during recovery. It remains in memory; resolve before restoring another version.");
      for (const [i, d] of details.entries()) {
        if (d.id !== buffer.reviews[i]!.id || d.branchId !== this.scope.branchId || d.basisHeadCommitId !== buffer.reviews[i]!.basis) throw new Error("Candidate recovery scope mismatch.");
      }
      const selection = buffer.history.editor?.selection;
      if (selection && (selection.sourceBranchId !== this.scope.branchId || !this.projection.transcript.some(t => t.commitId === selection.sourceCommitId && t.messageVersionId === selection.messageVersionId && t.logicalMessageId === selection.logicalMessageId && t.actorId === selection.actorId))) throw new Error("Historical recovery selection is not on this branch.");
      for (const request of [...buffer.requests, ...(buffer.history.command ? [buffer.history.command] : [])]) {
        if (request.body.branchId !== undefined && request.body.branchId !== this.scope.branchId || request.body.sourceBranchId !== undefined && request.body.sourceBranchId !== this.scope.branchId) throw new Error("Recovered command scope mismatch.");
      }
      const recoveredHistory = new StageHistory(this);
      recoveredHistory.restore(buffer.history);
      await recoveredHistory.refresh(true);
      if (this.disposed) return;
      if (editorBefore !== this.editorIdentity() || historyBefore !== JSON.stringify(this.history.snapshot())) throw new Error("Newer typing arrived during recovery. It remains in memory; resolve before restoring another version.");
      this.continuationBasis = buffer.basis; this.activeMode = buffer.mode; this.modeRouting = buffer.routing;
      this.direction = buffer.direction; this.performance = buffer.performance;
      this.editorBuffers.clear(); this.correctionBuffers.clear(); this.retainedReviews.clear();
      for (const [i, d] of details.entries()) {
        const r = buffer.reviews[i]!;
        this.retainedReviews.set(d.id, stageDraft(d)); this.editorBuffers.set(d.id, r.text); this.correctionBuffers.set(d.id, r.correction);
      }
      this.selectedDraftId = null; this.selectDraft(buffer.selected); this.editing = buffer.editing;
      this.history.dispose();
      this.history = recoveredHistory;
      this.pending = null; this.commands.reset(); this.generationId = null; this.generationDraft = null;
      this.requests = buffer.requests;
      if (this.requests.length) this.pending = async () => {
        // Reopen reconciles saved identities first; replay uses the exact captured
        // payload, never the newer editor overlay or an inferred new command.
        let generated: StageDraft | undefined;
        let committedHead: string | undefined;
        for (const r of [...this.requests]) {
          const result = await this.request<{ draft?: StageDraft; branch?: { headCommitId: string } }>(r.suffix, r.body);
          if (r.suffix === "/turns" || r.suffix.endsWith("/accept")) committedHead = result.branch?.headCommitId;
          if (result.draft) generated = result.draft;
        }
        await this.refresh();
        if (committedHead && committedHead === this.projection?.branch.headCommitId) this.continuationBasis = committedHead;
        if (generated && !this.disposed) this.notice = "Saved request reconciled. Its candidate is available in Saved drafts; local edits remain attached to their original candidate.";
      };
    } finally { this.restoring = false; }
  }
  async retryRecovery(): Promise<void> {
    if (!this.recovery || this.busy || this.history.busy) return;
    try {
      await this.refresh();
      if (this.awaitingRecovery) await this.restoreBuffer(this.awaitingRecovery);
      else await this.history.refresh(true);
      if (this.disposed) return;
      this.awaitingRecovery = null; this.recoveryReady = true; this.recoveryWarning = "";
      this.autosave();
    } catch (error) { if (!this.disposed) this.recoveryWarning = String(error); }
  }
  async resolveRecovery(index: number | null): Promise<void> {
    if (!this.recovery || this.busy || this.history.busy) return;
    const buffer = index === null ? this.snapshot() : this.recovery.conflicts[index]?.data;
    if (!buffer) return;
    const frozen = (value: StageBuffer) => JSON.stringify({ requests: value.requests, command: value.history.command });
    const chosen = frozen(buffer);
    if ([this.snapshot(), ...this.recovery.conflicts.map(r => r.data)].some(data => (data.requests.length || data.history.command) && frozen(data) !== chosen)) {
      this.recoveryWarning = "A different version has unresolved requests. Reconcile that version's exact requests before choosing editor text.";
      return;
    }
    this.recoveryReady = false;
    try {
      await this.refresh();
      await this.restoreBuffer(buffer);
      if (this.disposed) return;
      this.recoveryReady = true;
      this.recoveryWarning = "";
      this.recovery.resolve(this.snapshot());
    } catch (error) { this.recoveryWarning = String(error); }
  }
  async reconcileConflict(index: number): Promise<void> {
    const record = this.recovery?.conflicts[index];
    if (!record || this.busy || this.history.busy) return;
    this.busy = true;
    try {
      // Read authoritative projection/status using an isolated controller. The
      // user explicitly chose replay of this already-persisted version, not a merge.
      const other = new StageSession(this.scope, this.fetcher);
      await other.refresh();
      await other.restoreBuffer(JSON.parse(JSON.stringify(record.data)) as StageBuffer);
      const identityResponse = await this.fetcher(`${this.scope.apiBase.replace(/\/$/, "")}/recovery-identity`);
      const identity = await identityResponse.json() as StageRecoveryIdentity;
      if (!identityResponse.ok || identity.installationId !== this.recovery!.scope.installationId || identity.ownerId !== this.recovery!.scope.ownerId) throw new Error("Recovery identity changed.");
      if (this.disposed) return;
      if (other.needsReconcile) await other.resume();
      if (other.history.command) await other.history.resume();
      if (other.needsReconcile || other.history.command) throw new Error(other.error || other.history.error || "Request remains unresolved.");
      if (this.disposed) return;
      this.recovery!.reviseConflict(record, other.snapshot());
      if (JSON.stringify(this.requests) === JSON.stringify(record.data.requests)) { this.requests = []; this.pending = null; }
      const commandIdentity = (c: typeof this.history.command) => c ? JSON.stringify({ suffix: c.suffix, body: c.body }) : "";
      if (commandIdentity(this.history.command) === commandIdentity(record.data.history.command)) this.history.command = null;
      this.autosave();
      this.recoveryWarning = "Requests reconciled. Choose a buffer version explicitly; both texts remain available.";
    } catch (error) { if (!this.disposed) this.recoveryWarning = String(error); }
    finally { if (!this.disposed) this.busy = false; }
  }
  allowFreshContinuation(): void {
    if (this.selectedDraft || this.needsReconcile) return;
    this.continuationBasis = this.projection?.branch.headCommitId ?? "";
    this.autosave();
  }
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
    this.history = new StageHistory(this);
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
  get unsaved(): boolean { return !!this.history.editor || !!this.history.command || this.requests.length > 0 || this.editorBuffers.size > 0 || this.correctionBuffers.size > 0 || this.unsavedReview || this.hasCorrectionChanges || !!this.direction.trim() || !!this.performance.trim(); }
  get needsReconcile(): boolean { return this.pending !== null; }
  dispose(): void { this.autosave(); this.disposed = true; this.refreshVersion++; this.history.dispose(); }

  private async assertRecoveryIdentity(): Promise<void> {
    if (!this.recovery) return;
    const response = await this.fetcher(`${this.scope.apiBase.replace(/\/$/, "")}/recovery-identity`);
    const identity = await response.json() as StageRecoveryIdentity;
    if (this.disposed) throw new Error("Stage scope closed.");
    if (!response.ok || identity.installationId !== this.recovery.scope.installationId || identity.ownerId !== this.recovery.scope.ownerId) {
      this.recoveryWarning = "API installation or owner changed. Reopen Stage to establish scope; current text remains available for copy-out.";
      throw new Error(this.recoveryWarning);
    }
  }

  async request<T>(suffix: string, body?: Record<string, unknown>): Promise<T> {
    const fetcher = this.fetcher;
    if (body && suffix !== "/alternatives/origin" && this.recoveryRequired) {
      if (!this.recoveryReady || !this.recovery) throw new Error("Recovery identity is not ready; mutation not submitted.");
      await this.assertRecoveryIdentity();
      if (this.pending && !suffix.startsWith("/alternatives")) {
        const request = { suffix, body: JSON.parse(JSON.stringify(body)) as Record<string, unknown> };
        if (!this.requests.some(r => JSON.stringify(r) === JSON.stringify(request))) this.requests.push(request);
      }
      if (!this.autosave()) throw new Error("Mutation identity could not be saved locally. Resolve recovery before submitting.");
    }
    const response = await fetcher(`${this.scope.apiBase.replace(/\/$/, "")}/simulations/${encodeURIComponent(this.scope.simulationId)}${suffix}`, {
      method: body ? "POST" : "GET",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (this.recovery) await this.assertRecoveryIdentity();
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
      if (!this.continuationBasis) this.continuationBasis = projection.branch.headCommitId;
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
    if (this.busy || this.pending || this.disposed || this.recoveryBlocked || this.history.editor || this.history.command) return;
    this.notice = "";
    this.mutationEditor = this.editorIdentity();
    this.pending = operation;
    await this.resume();
  }
  async resume(): Promise<void> {
    if (this.busy || !this.pending || this.disposed) return;
    this.mutationEditor = this.editorIdentity();
    this.busy = true;
    this.error = "";
    try {
      await this.pending();
      if (!this.disposed) {
        this.pending = null;
        this.requests = [];
        this.settleGenerationIfConverged();
        this.autosave();
      }
    } catch (error) {
      if (this.disposed) return;
      this.error = error instanceof Error ? error.message : "The request did not converge.";
      if (error instanceof StageApiError && error.status >= 400 && error.status < 500) {
        this.pending = null;
        this.requests = [];
        this.autosave();
        try { await this.refresh(); } catch { /* retain the refresh error */ }
      }
    } finally { if (!this.disposed) this.busy = false; }
  }
  private input() {
    if (this.continuationStale) throw new Error("The continuation basis has advanced. Explicitly start at the current head or return to the original candidate.");
    if (!this.projection || !this.actors.some(actor => actor.id === this.actorId)) throw new Error("Choose a valid actor.");
    if (this.audienceMode === "selected" && this.audienceIds.some(id => !this.availableAudience.some(actor => actor.id === id) && id !== this.actorId))
      throw new Error("Audience changed. Choose available actors before submitting.");
    return { branchId: this.scope.branchId, expectedHead: this.projection.branch.headCommitId, actorId: this.actorId, audience: this.resolvedAudience };
  }
  async perform(): Promise<void> {
    if (!this.performance.trim() || this.busy || this.pending) return;
    const text = this.performance;
    const input = { ...this.input(), manualText: text, stageWhisperIds: [] as string[], knowledgePolicy: ACTOR_KNOWLEDGE_POLICY } as const;
    await this.execute(async () => {
      await runLeasedMutation(this.commands, "perform", input,
        commandId => this.request("/turns", { ...input, commandId } satisfies PerformStageTurnBody),
        () => this.refresh());
      if (this.disposed) return;
      this.continuationBasis = this.projection?.branch.headCommitId ?? this.continuationBasis;
      if (this.performance === text) this.performance = "";
      this.notice = "Performed.";
    });
  }
  async generate(): Promise<void> {
    if (this.busy || this.pending) return;
    const basis = { ...this.input(), audience: this.audienceMode === "unspecified" ? null : this.resolvedAudience, draftingPolicy: ACTOR_KNOWLEDGE_POLICY } as const;
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
      const input = { ...basis, completeWhisper: direction, stageWhisperIds: whisperId ? [whisperId] : [] };
      const commandId = this.commands.for("generate", input);
      if (this.generationId !== commandId) this.generationDraft = null;
      this.generationId = commandId;
      const body: GenerateStageDraftBody = { ...input, commandId };
      const result = await this.request<{ draft: StageDraft }>("/drafts", body);
      await this.receiveGeneratedDraft(result.draft);
      if (!this.disposed && this.direction.trim() === direction) this.direction = "";
    });
  }
  private async receiveGeneratedDraft(draft: StageDraft): Promise<void> {
    if (draft.generationCommandId === this.generationId) this.generationDraft = stageDraft(draft);
    try { await this.refresh(); } catch (error) { throw new CommandConvergenceError(error); }
    if (this.disposed) return;
    if (!this.drafts.some(item => item.id === draft.id) && ["ready", "failed", "generating"].includes(draft.status)) this.drafts.push(stageDraft(draft));
    if (this.editorIdentity() === this.mutationEditor) this.selectDraft(draft.id);
    else this.notice = "Candidate saved. Newer selection and wording remain unchanged.";
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
    const input = { draftingPolicy: ACTOR_KNOWLEDGE_POLICY, draftId: original.id, audience: this.audienceRequired || this.audienceChanged || preserveWording ? [...this.correctionAudienceIds] : null, completeWhisper: this.correctionText,
      ...(preserveWording ? { preservedText: this.reviewText } : {}) };
    if (preserveWording && !this.reviewText.trim()) return;
    await this.execute(async () => {
      await runLeasedMutation(this.commands, "revise", input,
        commandId => this.request<{ draft: StageDraft }>(`/drafts/${encodeURIComponent(original.id)}/revise`, {
          commandId, draftingPolicy: ACTOR_KNOWLEDGE_POLICY, audience: input.audience, completeWhisper: input.completeWhisper,
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
      if (action === "accept") this.continuationBasis = this.projection?.branch.headCommitId ?? this.continuationBasis;
      this.drafts = this.drafts.filter(item => item.id !== draft.id);
      if (this.editorIdentity() === this.mutationEditor) this.selectDraft(null);
      this.notice = action === "accept" ? "Accepted." : "Discarded.";
    });
  }
}
