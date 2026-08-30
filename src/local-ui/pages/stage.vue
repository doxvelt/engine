<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <main class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <header class="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p class="dx-label">Doxvelt Stage</p>
          <h1 class="mt-2 text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl">One turn at a time.</h1>
          <p class="mt-2 text-sm leading-6 text-muted">Generate a draft, review it, then decide what becomes canonical.</p>
        </div>
        <UBadge :color="runLoaded ? 'success' : 'neutral'" variant="subtle" size="sm">{{ runLoaded ? `Run loaded · ${branch?.id || 'main'}` : 'Setup' }}</UBadge>
      </header>

      <p v-if="requestStatus" class="mb-5 rounded-sm p-3 text-sm leading-6" :class="statusTone" aria-live="polite">{{ requestStatus }}</p>

      <section v-if="!runLoaded" class="dx-light-card p-5 sm:p-6" aria-labelledby="stage-setup-title">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div><p class="dx-label">Configure a local run</p><h2 id="stage-setup-title" class="mt-2 text-lg font-semibold text-highlighted">Open or start a simulation</h2></div>
          <UBadge :color="runtime?.configured ? 'success' : 'warning'" variant="subtle" size="sm">{{ runtimeLabel }}</UBadge>
        </div>
        <p v-if="runtime && !runtime.configured" class="dx-warning-note mt-4 rounded-sm p-3 text-sm leading-6">No local generation runtime is configured. You can still load a run, but generation is unavailable until the local API has one.</p>
        <div class="mt-5 grid gap-4 sm:grid-cols-2">
          <UFormField label="API base"><UInput v-model="apiBase" icon="i-lucide-server" autocomplete="url" placeholder="http://127.0.0.1:8787" @change="reloadSetup" /></UFormField>
          <UFormField label="Simulation ID"><UInput v-model="simulationId" icon="i-lucide-theater" autocomplete="off" @change="loadRunFromSetup" /></UFormField>
          <UFormField label="Workspace" class="sm:col-span-2"><UInput v-model="workspacePath" icon="i-lucide-folder-open" autocomplete="off" @change="discoverSource" /></UFormField>
          <UFormField label="Scenario" class="sm:col-span-2"><USelect v-model="scenarioId" :items="scenarioItems" icon="i-lucide-map" placeholder="Choose a scenario" :loading="discoveringSource" :disabled="scenarioItems.length === 0" /></UFormField>
        </div>
        <div class="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-muted pt-4">
          <p class="text-sm text-muted">{{ runtimeDescription }}</p>
          <UButton icon="i-lucide-play" color="primary" :disabled="!canStart" :loading="busyAction === 'start'" @click="startSimulation">Start</UButton>
        </div>
      </section>

      <template v-else>
        <section aria-labelledby="transcript-title">
          <div class="mb-4 flex items-end justify-between gap-3">
            <div><p class="dx-label">Canonical transcript</p><h2 id="transcript-title" class="mt-2 text-lg font-semibold text-highlighted">The scene so far</h2></div>
            <span class="font-mono text-xs text-muted">head {{ shortHead }}</span>
          </div>
          <div v-if="transcript.length" class="space-y-3">
            <article v-for="turn in transcript" :key="turn.id" class="dx-card-soft rounded-md border p-4 sm:p-5">
              <div class="mb-2 flex items-center justify-between gap-3"><p class="text-sm font-semibold text-highlighted">{{ actorName(turn.actorId) }}</p><span class="font-mono text-xs text-muted">@{{ turn.actorId }}</span></div>
              <p class="whitespace-pre-wrap text-sm leading-7 text-default">{{ turn.text }}</p>
            </article>
          </div>
          <div v-else class="rounded-md border border-dashed border-muted bg-default px-5 py-10 text-center"><p class="text-sm font-medium text-default">No accepted turns yet.</p><p class="mt-1 text-sm leading-6 text-muted">Choose who acts next and generate the first draft.</p></div>
        </section>

        <section v-if="!reviewDraft" class="dx-light-card mt-7 p-5 sm:p-6" aria-labelledby="next-turn-title">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div><p class="dx-label">Next turn</p><h2 id="next-turn-title" class="mt-2 text-lg font-semibold text-highlighted">Who acts next?</h2></div>
            <UBadge :color="runtime?.configured ? 'success' : 'warning'" variant="subtle" size="sm">{{ runtimeLabel }}</UBadge>
          </div>
          <p v-if="runtime && !runtime.configured" class="dx-warning-note mt-4 rounded-sm p-3 text-sm leading-6">Generation is disabled because the local API has no configured runtime.</p>
          <div class="mt-5 grid gap-4">
            <UFormField label="Actor"><USelect v-model="selectedActorId" :items="actorItems" icon="i-lucide-user-round" placeholder="Choose the next actor" :disabled="actors.length === 0" /></UFormField>
            <UFormField label="Direction (optional)" hint="Private direction for this draft only."><UTextarea v-model="direction" :rows="3" autoresize placeholder="Give the next actor a private direction…" /></UFormField>
          </div>
          <div class="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-muted pt-4">
            <p class="text-sm text-muted">{{ selectedActorId ? `Generate a durable draft for ${actorName(selectedActorId)}.` : 'Select an actor to continue.' }}</p>
            <UButton icon="i-lucide-wand-sparkles" color="primary" :disabled="!canGenerate" :loading="busyAction === 'generate' || busyAction === 'whisper'" @click="generateDraft">Generate</UButton>
          </div>
        </section>

        <section v-else class="dx-light-card mt-7 p-5 sm:p-6" aria-labelledby="review-title">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div><p class="dx-label">Draft review</p><h2 id="review-title" class="mt-2 text-lg font-semibold text-highlighted">{{ actorName(reviewDraft.actorId) }}’s proposed turn</h2></div>
            <UBadge :color="review.kind === 'ready' ? 'warning' : 'error'" variant="subtle" size="sm">{{ review.kind === 'ready' ? 'Awaiting acceptance' : 'Generation failed' }}</UBadge>
          </div>
          <p v-if="draftIsStale" class="dx-warning-note mt-4 rounded-sm p-3 text-sm leading-6" aria-live="polite">This draft was based on another branch head and can no longer be accepted. Its text remains visible so you can inspect it before discarding and generating again.</p>
          <template v-if="review.kind === 'ready'"><UFormField label="Generated text" class="mt-5"><UTextarea v-model="reviewText" :rows="9" autoresize aria-label="Editable generated text" /></UFormField></template>
          <p v-else class="dx-error-note mt-5 rounded-sm p-3 text-sm leading-6">{{ reviewMessage }}</p>
          <dl v-if="review.kind !== 'unavailable'" class="mt-5 grid gap-x-5 gap-y-3 border-y border-muted py-4 text-xs sm:grid-cols-2">
            <div><dt class="dx-label">Provider / model</dt><dd class="mt-1 text-default">{{ review.provenance.providerModel }}</dd></div>
            <div><dt class="dx-label">Adapter</dt><dd class="mt-1 text-default">{{ review.provenance.adapter }}</dd></div>
            <div><dt class="dx-label">Usage</dt><dd class="mt-1 text-default">{{ review.provenance.usage }}</dd></div>
            <div><dt class="dx-label">Stop reason</dt><dd class="mt-1 text-default">{{ review.provenance.stopReason }}</dd></div>
          </dl>
          <div class="mt-5 flex flex-wrap justify-end gap-2">
            <UButton v-if="review.kind === 'ready'" color="neutral" variant="subtle" :loading="busyAction === 'discard'" :disabled="busyAction === 'accept'" @click="discardDraft">Discard</UButton>
            <UButton v-else color="neutral" variant="subtle" @click="continueAfterFailedDraft">Continue</UButton>
            <UButton v-if="review.kind === 'ready'" icon="i-lucide-check" color="primary" :loading="busyAction === 'accept'" :disabled="busyAction === 'discard' || draftIsStale || !reviewText.trim()" @click="acceptDraft">Accept</UButton>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { acceptDraftBody, classifyDraftReview, CommandConvergenceError, createCommandLease, isStaleDraftBasis, playableActors, runLeasedMutation, type CommandAction } from "../lib/stage-play";

type Actor = { id: string; name: string; kind: string };
type SourceFile = { id: string; name: string; kind: string };
type Branch = { id: string; headCommitId: string };
type TranscriptTurn = { id: string | number; actorId: string; text: string };
type RuntimeStatus = { configured: boolean; adapter: { id: string | null; version: string | null } | null; provider: string | null; model: string | null };
type DraftProvenance = { adapter: { id: string; version: string }; providerId: string | null; modelId: string | null; usage: { totalTokens: number }; stopReason: string | null };
type Draft = { id: string; branchId: string; basisHeadCommitId: string; actorId: string; status: string; artifact: { text: string; provenance: DraftProvenance } | null; failure: { message: string; provenance: DraftProvenance } | null };
type StagedWhisper = { id: string; text: string; actorId: string; branchId: string; expectedHead: string };
type BusyAction = CommandAction | null;

class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const MAIN_BRANCH_ID = "main";
const route = useRoute();
const config = useRuntimeConfig();
const apiBase = ref(String(config.public.apiBase));
const workspacePath = ref(String(route.query.workspace || "examples/executive-interviews"));
const simulationId = ref(String(route.query.simulation || "default"));
const scenarioId = ref("");
const runtime = ref<RuntimeStatus | null>(null);
const actors = ref<Actor[]>([]);
const transcript = ref<TranscriptTurn[]>([]);
const branch = ref<Branch | null>(null);
const selectedActorId = ref("");
const direction = ref("");
const stagedWhisper = ref<StagedWhisper | null>(null);
const reviewDraft = ref<Draft | null>(null);
const reviewText = ref("");
const sourceFiles = ref<SourceFile[]>([]);
const requestStatus = ref("");
const requestStatusKind = ref<"error" | "warning" | "info">("info");
const busyAction = ref<BusyAction>(null);
const discoveringSource = ref(false);
const runLoaded = ref(false);
const draftIsStale = ref(false);
const commands = createCommandLease(() => crypto.randomUUID());

const scenarioItems = computed(() => sourceFiles.value.filter((file) => file.kind === "scenario").map((file) => ({ label: file.name || file.id, value: file.id })));
const actorItems = computed(() => actors.value.map((actor) => ({ label: actor.name || actor.id, value: actor.id })));
const canStart = computed(() => Boolean(workspacePath.value.trim() && simulationId.value.trim() && scenarioId.value && !busyAction.value));
const canGenerate = computed(() => Boolean(runtime.value?.configured && branch.value && selectedActorId.value && !busyAction.value));
const runtimeLabel = computed(() => !runtime.value ? "Checking runtime" : !runtime.value.configured ? "Runtime unavailable" : [runtime.value.provider, runtime.value.model].filter(Boolean).join(" / ") || "Runtime ready");
const runtimeDescription = computed(() => runtime.value?.configured ? `Generation uses ${runtimeLabel.value}.` : "A local runtime is required only to generate a draft.");
const statusTone = computed(() => requestStatusKind.value === "error" ? "dx-error-note" : requestStatusKind.value === "warning" ? "dx-warning-note" : "dx-source-note");
const shortHead = computed(() => branch.value?.headCommitId ? branch.value.headCommitId.slice(0, 14) : "unavailable");
const review = computed(() => reviewDraft.value ? classifyDraftReview(reviewDraft.value) : { kind: "unavailable" as const, message: "No draft is being reviewed." });
const reviewMessage = computed(() => review.value.kind === "failed" || review.value.kind === "unavailable" ? review.value.message : "");

onMounted(async () => { await refreshRuntime(); await discoverSource(); await loadExistingRun(); });

async function api<T>(path: string, options: { method?: "POST"; body?: Record<string, unknown> } = {}): Promise<T> {
  const response = await fetch(`${apiBase.value.replace(/\/$/, "")}${path}`, { method: options.method || "GET", headers: options.body ? { "content-type": "application/json" } : undefined, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed (${response.status}).`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

function updateRoute(): void { void navigateTo({ path: "/stage", query: { workspace: workspacePath.value, simulation: simulationId.value } }, { replace: true }); }
async function reloadSetup(): Promise<void> {
  clearRun(); requestStatus.value = "";
  await refreshRuntime(); await discoverSource(); await loadExistingRun();
}
async function loadRunFromSetup(): Promise<void> {
  updateRoute(); requestStatus.value = ""; await loadExistingRun();
}
async function refreshRuntime(): Promise<void> { try { runtime.value = await api<RuntimeStatus>("/runtime"); } catch (error) { runtime.value = null; showRequestError(error, "Could not check the local runtime."); } }
async function discoverSource(): Promise<void> {
  if (!workspacePath.value.trim()) return;
  discoveringSource.value = true;
  try {
    const result = await api<{ files: SourceFile[] }>(`/source?workspacePath=${encodeURIComponent(workspacePath.value.trim())}`);
    sourceFiles.value = result.files;
    if (!scenarioItems.value.some((item) => item.value === scenarioId.value)) scenarioId.value = scenarioItems.value[0]?.value || "";
    updateRoute();
  } catch (error) { sourceFiles.value = []; showRequestError(error, "Could not discover scenarios in this workspace."); }
  finally { discoveringSource.value = false; }
}
async function loadExistingRun(): Promise<void> {
  try {
    await refreshActors(); await refreshProjection(MAIN_BRANCH_ID); runLoaded.value = true;
    if (!selectedActorId.value) selectedActorId.value = actors.value[0]?.id || "";
  } catch (error) {
    runLoaded.value = false; clearRun();
    if (error instanceof ApiError && error.status === 404) return;
    showRequestError(error, "Could not load the requested simulation.");
  }
}
async function startSimulation(): Promise<void> {
  if (!canStart.value) return;
  const input = { workspacePath: workspacePath.value.trim(), scenarioId: scenarioId.value, simulationId: simulationId.value.trim(), branchId: MAIN_BRANCH_ID };
  busyAction.value = "start";
  try {
    await runLeasedMutation(
      commands,
      "start",
      input,
      (commandId) => api("/simulations/start", { method: "POST", body: { ...input, commandId } }),
      async () => {
        updateRoute(); await refreshActors(); await refreshProjection(MAIN_BRANCH_ID);
        runLoaded.value = true; selectedActorId.value = actors.value[0]?.id || "";
      },
    );
    setStatus("Run started. Choose the next actor.", "info");
  } catch (error) {
    showRequestError(error, error instanceof CommandConvergenceError
      ? "The run was created, but Stage could not load it. Retry Start to reconcile."
      : "Could not start this simulation.");
  }
  finally { busyAction.value = null; }
}
async function generateDraft(): Promise<void> {
  if (!canGenerate.value || !branch.value) return;
  try {
    const whisperId = await stageDirectionIfNeeded(); if (!branch.value) return;
    const input = { branchId: branch.value.id, expectedHead: branch.value.headCommitId, actorId: selectedActorId.value, stageWhisperIds: whisperId ? [whisperId] : [] };
    busyAction.value = "generate";
    const result = await api<{ draft: Draft }>(`/simulations/${encodeURIComponent(simulationId.value)}/drafts`, { method: "POST", body: { ...input, commandId: commands.for("generate", input) } });
    commands.succeed("generate"); reviewDraft.value = result.draft; draftIsStale.value = false;
    const summary = classifyDraftReview(result.draft); reviewText.value = summary.kind === "ready" ? summary.text : "";
    setStatus(summary.kind === "ready" ? "Draft ready for review." : "The generated draft failed. It was not added to the transcript.", summary.kind === "ready" ? "info" : "warning");
  } catch (error) {
    if (!(await refreshAfterConflict(error))) showRequestError(error, "Could not generate a draft.");
  }
  finally { busyAction.value = null; }
}
async function stageDirectionIfNeeded(): Promise<string | null> {
  if (!branch.value || !direction.value.trim()) return null;
  const text = direction.value.trim(); const current = stagedWhisper.value;
  if (current && current.text === text && current.actorId === selectedActorId.value && current.branchId === branch.value.id && current.expectedHead === branch.value.headCommitId) return current.id;
  const input = { branchId: branch.value.id, expectedHead: branch.value.headCommitId, targetActorId: selectedActorId.value, text };
  busyAction.value = "whisper";
  const whisper = await api<{ id: string }>(`/simulations/${encodeURIComponent(simulationId.value)}/whispers`, { method: "POST", body: { ...input, commandId: commands.for("whisper", input) } });
  commands.succeed("whisper"); stagedWhisper.value = { id: whisper.id, text, actorId: selectedActorId.value, branchId: branch.value.id, expectedHead: branch.value.headCommitId };
  return whisper.id;
}
async function acceptDraft(): Promise<void> {
  const draft = reviewDraft.value; if (!draft || review.value.kind !== "ready") return;
  const request = acceptDraftBody("", review.value.text, reviewText.value);
  const commandBody = { draftId: draft.id, ...(request.finalText === undefined ? {} : { finalText: request.finalText }) };
  busyAction.value = "accept";
  try {
    await runLeasedMutation(
      commands,
      "accept",
      commandBody,
      (commandId) => api(`/simulations/${encodeURIComponent(simulationId.value)}/drafts/${encodeURIComponent(draft.id)}/accept`, {
        method: "POST",
        body: acceptDraftBody(commandId, review.value.kind === "ready" ? review.value.text : "", reviewText.value),
      }),
      async () => { await refreshProjection(branch.value?.id || MAIN_BRANCH_ID); },
    );
    clearDraft(); setStatus("Draft accepted into the canonical transcript.", "info");
  } catch (error) {
    if (!(await refreshAfterConflict(error)))
      showRequestError(error, error instanceof CommandConvergenceError
        ? "The turn was accepted, but Stage could not refresh the transcript. Retry Accept to reconcile."
        : "Could not accept this draft.");
  }
  finally { busyAction.value = null; }
}
async function discardDraft(): Promise<void> {
  const draft = reviewDraft.value; if (!draft) return;
  const input = { draftId: draft.id }; busyAction.value = "discard";
  try {
    await api(`/simulations/${encodeURIComponent(simulationId.value)}/drafts/${encodeURIComponent(draft.id)}/discard`, { method: "POST", body: { commandId: commands.for("discard", input) } });
    commands.succeed("discard"); clearDraft(); setStatus("Draft discarded. The canonical transcript is unchanged.", "info");
  } catch (error) {
    if (!(await refreshAfterConflict(error))) showRequestError(error, "Could not discard this draft.");
  }
  finally { busyAction.value = null; }
}
async function refreshActors(): Promise<void> { const result = await api<{ actors: Actor[] }>(`/simulations/${encodeURIComponent(simulationId.value)}/actors`); actors.value = playableActors(result.actors); }
async function refreshProjection(branchId: string): Promise<void> {
  const result = await api<{ branch: Branch; transcript: TranscriptTurn[] }>(`/simulations/${encodeURIComponent(simulationId.value)}/transcript?branchId=${encodeURIComponent(branchId)}`);
  branch.value = result.branch; transcript.value = result.transcript;
}
async function refreshAfterConflict(error: unknown): Promise<boolean> {
  if (!(error instanceof ApiError) || error.status !== 409 || !branch.value) return false;
  try {
    await refreshProjection(branch.value.id);
    draftIsStale.value = reviewDraft.value ? isStaleDraftBasis(reviewDraft.value, branch.value) : false;
    setStatus("The branch moved while this request was in progress. The current projection was refreshed.", "warning");
  } catch (refreshError) {
    draftIsStale.value = Boolean(reviewDraft.value);
    const detail = refreshError instanceof Error ? ` ${refreshError.message}` : "";
    setStatus(`The request conflicted and the current projection could not be refreshed.${detail}`, "error");
  }
  return true;
}
function continueAfterFailedDraft(): void {
  if (review.value.kind === "ready") return;
  clearDraft(); setStatus("Failed draft closed. The canonical transcript is unchanged.", "info");
}
function clearDraft(): void { reviewDraft.value = null; reviewText.value = ""; direction.value = ""; stagedWhisper.value = null; draftIsStale.value = false; commands.reset(); }
function clearRun(): void { actors.value = []; transcript.value = []; branch.value = null; selectedActorId.value = ""; clearDraft(); }
function actorName(actorId: string): string { return actors.value.find((actor) => actor.id === actorId)?.name || actorId; }
function setStatus(message: string, kind: "error" | "warning" | "info"): void { requestStatus.value = message; requestStatusKind.value = kind; }
function showRequestError(error: unknown, fallback: string): void {
  setStatus(error instanceof CommandConvergenceError ? fallback : error instanceof Error ? error.message : fallback, "error");
}
</script>
