<template>
  <main v-if="session.projection" class="stage-surface" aria-label="Stage">
    <header class="stage-header">
      <div class="min-w-0">
        <h1 class="truncate text-lg font-semibold text-highlighted">{{ session.projection.scenarioName }}</h1>
        <p class="truncate text-xs text-muted">{{ simulationId }} · {{ branchId }}</p>
      </div>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" aria-label="Refresh Stage and saved drafts" :disabled="session.busy" @click="refreshPendingDraft" />
    </header>

    <div class="stage-history-wrap">
      <section ref="history" class="stage-history" aria-label="Conversation history" tabindex="0" @scroll="measureHistory">
        <p v-if="!session.projection.transcript.length && !session.selectedDraft" class="py-6 text-sm text-muted">Choose an actor to begin the scene.</p>
        <article v-for="(turn, index) in session.projection.transcript" :key="turn.id" class="stage-turn">
          <div class="mb-2 flex items-center justify-between gap-3">
            <StageIdentity :actor-id="turn.actorId" :actors="session.actors" />
            <StageAudience :audience="turn.audience" :actors="session.actors" :number="index + 1">
              <p class="mt-2 text-xs text-muted">{{ new Date(turn.createdAt).toLocaleString() }}</p>
            </StageAudience>
          </div>
          <p class="stage-prose">{{ turn.text }}</p>
        </article>
        <article v-if="session.selectedDraft" class="stage-turn stage-draft" aria-label="Draft performance">
          <p class="dx-label mb-2">Draft · {{ draftStatus }}</p>
          <div class="mb-2 flex items-center justify-between gap-3">
            <StageIdentity :actor-id="session.selectedDraft.actorId" :actors="session.actors" />
            <StageAudience :audience="session.selectedDraft.audience" :actors="session.actors" draft />
          </div>
          <p v-if="session.stale" class="dx-warning-note mb-3 rounded-sm p-2 text-sm" role="status">The branch has moved. This draft cannot be accepted or retried here.</p>
          <template v-if="session.selectedDraft.artifact">
            <UFormField v-if="session.editing" label="Edit draft" :hint="session.unsavedReview ? 'Unsaved edits' : 'Saved generated text'">
              <UTextarea v-model="session.reviewText" :rows="6" class="w-full" aria-label="Edit draft" :disabled="locked" />
            </UFormField>
            <p v-else class="stage-prose">{{ session.reviewText }}</p>
            <p v-if="session.unsavedReview" class="mt-2 text-xs text-muted" role="status">Unsaved edits · saved only when accepted</p>
          </template>
          <p v-else class="stage-prose" role="status">{{ review.message }}</p>
          <UPopover v-if="review.kind === 'ready' || review.kind === 'failed'">
            <UButton class="mt-3" color="neutral" variant="link" size="xs">Generation details</UButton>
            <template #content>
              <dl class="max-w-72 space-y-2 p-4 text-xs">
                <div><dt class="dx-label">Provider / model</dt><dd>{{ review.provenance.providerModel }}</dd></div>
                <div><dt class="dx-label">Adapter</dt><dd>{{ review.provenance.adapter }}</dd></div>
                <div><dt class="dx-label">Usage</dt><dd>{{ review.provenance.usage }}</dd></div>
                <div><dt class="dx-label">Stop reason</dt><dd>{{ review.provenance.stopReason }}</dd></div>
              </dl>
            </template>
          </UPopover>
        </article>
      </section>
      <UButton v-if="awayFromLatest" class="stage-jump" color="neutral" variant="soft" size="xs" icon="i-lucide-arrow-down" @click="jumpToLatest">Jump to latest</UButton>
    </div>

    <footer class="stage-dock">
      <div v-if="session.error" class="dx-error-note mb-2 rounded-sm p-2 text-sm" role="alert">
        {{ session.error }}
        <UButton v-if="session.needsReconcile" class="ml-1" color="neutral" variant="link" :loading="session.busy" @click="session.resume()">Retry request</UButton>
      </div>
      <p v-else-if="session.notice" class="mb-2 text-xs text-muted" role="status">{{ session.notice }}</p>
      <div v-if="session.drafts.length" class="mb-2 flex items-center gap-2">
        <USelect :model-value="session.selectedDraftId || 'compose'" :items="draftItems" class="min-w-0 flex-1" aria-label="Saved drafts" :disabled="locked" @update:model-value="chooseDraft" />
        <span class="shrink-0 text-xs text-muted">{{ session.drafts.length }} saved</span>
      </div>
      <div v-if="session.selectedDraft" class="flex flex-wrap items-center justify-end gap-2">
        <UButton v-if="recoverable" color="neutral" variant="ghost" :disabled="locked" @click="discard">Discard</UButton>
        <UButton v-if="recoverable" color="neutral" variant="subtle" :disabled="locked || session.stale || !runtime?.configured" @click="retry">Retry</UButton>
        <UButton v-if="session.selectedDraft.artifact" color="neutral" variant="subtle" :disabled="locked" @click="toggleEditing">{{ session.editing ? 'Read' : 'Edit' }}</UButton>
        <UButton v-if="review.kind === 'ready'" color="primary" :disabled="locked || session.stale || !session.reviewText.trim()" @click="session.accept()">Accept</UButton>
        <UButton v-else-if="review.kind === 'pending'" color="primary" :disabled="session.busy" @click="refreshPendingDraft">Check again</UButton>
      </div>
      <form v-else class="stage-composer" @submit.prevent="submit">
        <div class="mb-2 grid grid-cols-2 gap-3">
          <UFormField label="Actor">
            <USelect v-model="session.actorId" :items="actorItems" class="w-full" aria-label="Actor" :disabled="locked" />
          </UFormField>
          <UFormField label="Audience" class="text-right">
            <UPopover>
              <UButton color="neutral" variant="subtle" class="w-full justify-end" :disabled="locked" aria-label="Choose audience">
                <span class="truncate">{{ session.audienceMode === 'all' ? 'all' : audienceLabel }}</span>
                <UIcon name="i-lucide-chevron-down" />
              </UButton>
              <template #content>
                <div class="max-h-72 w-64 overflow-y-auto p-4 text-left">
                  <URadioGroup v-model="session.audienceMode" :items="[{ label: 'all listed actors', value: 'all' }, { label: 'Selected actors', value: 'selected' }]" />
                  <UCheckboxGroup v-if="session.audienceMode === 'selected'" v-model="session.audienceIds" :items="audienceItems" class="mt-3" />
                  <p class="mt-3 text-xs text-muted">The actor also perceives their own turn.</p>
                  <p class="mt-2 text-xs">Audience: {{ audienceLabel }}</p>
                </div>
              </template>
            </UPopover>
          </UFormField>
        </div>
        <UTextarea v-if="session.mode === 'direct'" v-model="session.direction" :rows="3" class="w-full" aria-label="Private direction" placeholder="Private direction (optional)…" :disabled="locked" />
        <UTextarea v-else v-model="session.performance" :rows="3" class="w-full" aria-label="Performance" placeholder="Write the actor’s words or actions…" :disabled="locked" />
        <div class="mt-2 flex items-center justify-between gap-2">
          <UTabs v-model="session.mode" :items="[{ label: 'Direct', value: 'direct' }, { label: 'Perform', value: 'perform' }]" :content="false" size="xs" :ui="{ list: 'w-36' }" />
          <UButton type="submit" color="primary" :loading="session.busy" :disabled="!canSubmit">{{ session.mode === 'direct' ? 'Generate draft' : 'Perform' }}</UButton>
        </div>
        <p v-if="session.mode === 'direct' && runtime && !runtime.configured" class="mt-2 text-xs text-muted">Generation unavailable. Perform is ready to use.</p>
      </form>
    </footer>
  </main>

  <main v-else class="min-h-0 flex-1 overflow-y-auto px-4 py-6">
    <section class="mx-auto max-w-xl space-y-4" aria-label="Open Stage">
      <h1 class="text-xl font-semibold">Open Stage</h1>
      <p v-if="setupError" class="dx-error-note p-3 text-sm" role="alert">{{ setupError }}</p>
      <UFormField label="API base"><UInput v-model="apiBase" class="w-full" :disabled="setupBusy" /></UFormField>
      <UFormField label="Simulation ID"><UInput v-model="simulationId" class="w-full" :disabled="setupBusy" /></UFormField>
      <UButton color="neutral" :loading="setupBusy" @click="openRun">Open run</UButton>
      <UFormField label="Workspace"><UInput v-model="workspacePath" class="w-full" :disabled="setupBusy" @change="discoverSource" /></UFormField>
      <UFormField label="Scenario"><USelect v-model="scenarioId" :items="scenarioItems" class="w-full" :disabled="setupBusy" /></UFormField>
      <UButton color="primary" :loading="setupBusy" :disabled="!scenarioId || setupBusy" @click="startSimulation">Start</UButton>
    </section>
  </main>
</template>

<script setup lang="ts">
import { StageSession, StageApiError } from "../lib/stage-session";
import { classifyDraftReview, createCommandLease, runLeasedMutation } from "../lib/stage-play";
import { stageSetupRequest, type RuntimeStatus, type SourceFile } from "../lib/stage-api";

const route = useRoute();
const config = useRuntimeConfig();
const apiBase = ref(String(config.public.apiBase));
const simulationId = ref(String(route.query.simulation || "default"));
const branchId = ref(String(route.query.branch || "main"));
const workspacePath = ref(String(route.query.workspace || "examples/executive-interviews"));
const scenarioId = ref("");
const runtime = ref<RuntimeStatus | null>(null);
const sourceFiles = ref<SourceFile[]>([]);
const setupBusy = ref(false);
const setupError = ref("");
const setupCommands = createCommandLease(() => crypto.randomUUID());
const session = ref(new StageSession({ apiBase: apiBase.value, simulationId: simulationId.value, branchId: branchId.value }));
const history = ref<HTMLElement | null>(null);
const awayFromLatest = ref(false);
const locked = computed(() => session.value.busy || session.value.needsReconcile);
const actorItems = computed(() => session.value.actors.map(actor => ({ label: actor.name, value: actor.id })));
const audienceItems = computed(() => session.value.availableAudience.filter(actor => actor.id !== session.value.actorId).map(actor => ({ label: actor.name, value: actor.id })));
const actorName = (id: string) => session.value.actors.find(actor => actor.id === id)?.name || id;
const audienceLabel = computed(() => session.value.resolvedAudience.map(actorName).join(', '));
const scenarioItems = computed(() => sourceFiles.value.filter(file => file.kind === 'scenario').map(file => ({ label: file.name, value: file.id })));
const review = computed(() => session.value.selectedDraft ? classifyDraftReview(session.value.selectedDraft) : { kind: 'unavailable' as const, message: '' });
const recoverable = computed(() => ['ready', 'failed', 'generating'].includes(session.value.selectedDraft?.status || ''));
const draftStatus = computed(() => ({ ready: 'Not accepted', generating: 'Generating', failed: 'Generation failed', accepted: 'Accepted', discarded: 'Discarded' })[session.value.selectedDraft?.status || 'ready']);
const draftItems = computed(() => [{ label: 'Compose a new turn', value: 'compose' }, ...session.value.drafts.map((draft, index) => ({ value: draft.id, label: `${index + 1}. ${actorName(draft.actorId)} · ${draft.status}${draft.basisHeadCommitId !== session.value.projection?.branch.headCommitId ? ' · stale' : ''}` }))]);
const canSubmit = computed(() => !locked.value && !!session.value.actorId && (session.value.mode === 'perform' ? !!session.value.performance.trim() : !!runtime.value?.configured));

function measureHistory(): void {
  const el = history.value;
  awayFromLatest.value = !!el && el.scrollHeight - el.clientHeight - el.scrollTop > 32;
}
function jumpToLatest(): void { if (history.value) history.value.scrollTop = history.value.scrollHeight; measureHistory(); }
watch(() => [session.value.projection?.transcript.length, session.value.selectedDraftId, session.value.reviewText], async () => { await nextTick(); measureHistory(); });
function permitEditorLoss(): boolean { return !session.value.unsavedReview || window.confirm('Discard unsaved review edits? The saved generated text remains available.'); }
function chooseDraft(value: string | number): void { if (!locked.value && permitEditorLoss()) session.value.selectDraft(value === 'compose' ? null : String(value)); }
async function toggleEditing(): Promise<void> { session.value.editing = !session.value.editing; await nextTick(); if (session.value.editing) history.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); }
async function retry(): Promise<void> { if (permitEditorLoss()) { await session.value.retry(); await nextTick(); measureHistory(); } }
async function discard(): Promise<void> { if (permitEditorLoss()) await session.value.discard(); }
async function submit(): Promise<void> { if (!canSubmit.value) return; try { if (session.value.mode === 'direct') await session.value.generate(); else await session.value.perform(); } catch (error) { session.value.error = String(error); } }
async function refreshPendingDraft(): Promise<void> { try { await session.value.refresh(); } catch { /* session displays the error */ } await nextTick(); measureHistory(); }
function warnBeforeUnload(event: BeforeUnloadEvent): void { if (session.value.unsaved) { event.preventDefault(); event.returnValue = ''; } }
onBeforeRouteLeave(() => !session.value.unsaved || window.confirm('Leave Stage with unsaved text? Saved drafts will be recoverable.'));
onBeforeRouteUpdate(() => !session.value.unsaved || window.confirm('Change run with unsaved text? Saved drafts will be recoverable.'));
let mounted = true;
let setupVersion = 0;
onMounted(async () => { window.addEventListener('beforeunload', warnBeforeUnload); window.addEventListener('resize', measureHistory); await openRun(false); if (!session.value.projection) await discoverSource(); });
onBeforeUnmount(() => { mounted = false; setupVersion++; session.value.dispose(); window.removeEventListener('beforeunload', warnBeforeUnload); window.removeEventListener('resize', measureHistory); });
watch(() => [route.query.simulation, route.query.branch], async () => {
  const nextSimulation = String(route.query.simulation || 'default');
  const nextBranch = String(route.query.branch || 'main');
  if (session.value.scope.simulationId === nextSimulation && session.value.scope.branchId === nextBranch) return;
  simulationId.value = nextSimulation; branchId.value = nextBranch; await openRun(false);
});
function captureSetupScope() {
  return Object.freeze({ apiBase: apiBase.value, simulationId: simulationId.value, branchId: branchId.value, workspacePath: workspacePath.value });
}
function matchesSetupScope(scope: ReturnType<typeof captureSetupScope>): boolean {
  return scope.apiBase === apiBase.value && scope.simulationId === simulationId.value && scope.branchId === branchId.value && scope.workspacePath === workspacePath.value;
}
async function openRun(updateRoute = true, scope = captureSetupScope()): Promise<void> {
  if (!mounted || !matchesSetupScope(scope)) return;
  const version = ++setupVersion;
  session.value.dispose();
  session.value = new StageSession(scope);
  const current = session.value;
  const ownsSetup = () => mounted && version === setupVersion && session.value === current && matchesSetupScope(scope);
  setupBusy.value = true; setupError.value = '';
  try {
    const status = await stageSetupRequest<RuntimeStatus>(scope.apiBase, '/runtime');
    if (!ownsSetup()) return;
    runtime.value = status;
    await current.refresh();
    if (!ownsSetup()) return;
    if (updateRoute) await navigateTo({ path: '/stage', query: { workspace: scope.workspacePath, simulation: scope.simulationId, branch: scope.branchId } }, { replace: true });
  } catch (error) {
    if (ownsSetup() && !(error instanceof StageApiError && error.status === 404)) setupError.value = error instanceof Error ? error.message : String(error);
  } finally { if (ownsSetup()) setupBusy.value = false; }
}
async function discoverSource(): Promise<void> {
  const base = apiBase.value; const workspace = workspacePath.value;
  try {
    const result = await stageSetupRequest<{ files: SourceFile[] }>(base, `/source?workspacePath=${encodeURIComponent(workspace)}`);
    if (!mounted || base !== apiBase.value || workspace !== workspacePath.value) return;
    sourceFiles.value = result.files;
    if (!scenarioItems.value.some(item => item.value === scenarioId.value)) scenarioId.value = scenarioItems.value[0]?.value || '';
  } catch (error) { if (mounted) setupError.value = String(error); }
}
async function startSimulation(): Promise<void> {
  if (!mounted || setupBusy.value) return;
  const scope = captureSetupScope();
  const input = Object.freeze({ workspacePath: scope.workspacePath, simulationId: scope.simulationId, branchId: scope.branchId, scenarioId: scenarioId.value });
  let version = setupVersion;
  let owner = session.value;
  const ownsSetup = () => mounted && version === setupVersion && session.value === owner && matchesSetupScope(scope) && scenarioId.value === input.scenarioId;
  setupBusy.value = true; setupError.value = '';
  try {
    await runLeasedMutation(setupCommands, 'start', { ...input, apiBase: scope.apiBase },
      commandId => stageSetupRequest(scope.apiBase, '/simulations/start', { ...input, commandId }),
      async () => {
        if (!ownsSetup()) throw new Error('Start no longer owns this setup.');
        const loading = openRun(true, scope);
        // openRun synchronously transfers ownership to its new version/session.
        version = setupVersion; owner = session.value;
        await loading;
        if (!ownsSetup()) throw new Error('Start no longer owns this setup.');
        if (!owner.projection) throw new Error('Run created; retry Start to load it.');
      });
  } catch (error) { if (ownsSetup()) setupError.value = error instanceof Error ? error.message : String(error); }
  finally { if (ownsSetup()) setupBusy.value = false; }
}
</script>

<style scoped>
.stage-surface { width: 100%; max-width: 880px; margin: 0 auto; padding: 0 24px; flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; }
.stage-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 0 12px; }
.stage-history-wrap { position: relative; min-height: 0; min-width: 0; }
.stage-history { height: 100%; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; overflow-anchor: none; padding: 12px 12px 20px 0; }
.stage-turn { margin-bottom: 28px; }
.stage-prose { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.9; }
.stage-draft { border-left: 2px solid var(--dx-accent); background: var(--dx-accent-subtle); padding: 12px; border-radius: var(--dx-radius-sm); }
.stage-dock { min-width: 0; padding: 10px 0 16px; max-height: 58dvh; overflow-y: auto; }
.stage-composer { border: 1px solid var(--dx-border); border-radius: var(--dx-radius-md); padding: 10px; }
.stage-jump { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); }
@media (max-width: 600px) { .stage-surface { padding: 0 12px; } .stage-header { padding: 10px 0 6px; } .stage-history { padding-right: 4px; } .stage-dock { padding-bottom: max(10px, env(safe-area-inset-bottom)); } }
@media (max-height: 650px) { .stage-header { padding-top: 6px; padding-bottom: 6px; } .stage-dock { padding-top: 6px; padding-bottom: 8px; } .stage-composer :deep(textarea) { max-height: 76px; } }
</style>
