<template>
  <div class="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] gap-0">
    <aside class="dx-left-panel min-h-0 overflow-y-auto border-r p-4">
      <div class="space-y-5">
        <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-2 p-0 sm:p-0' }">
          <div class="flex items-center justify-between gap-2">
            <h2 class="dx-label">Workspace</h2>
            <UBadge :color="simulationStarted ? 'success' : compiledOnce ? 'warning' : 'neutral'" variant="subtle" size="sm">
              {{ workspaceStatus }}
            </UBadge>
          </div>
          <div class="dx-tile grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-sm p-2 text-xs">
            <UIcon :name="compiledOnce ? 'i-lucide-check-circle-2' : 'i-lucide-circle'" class="mt-0.5" />
            <span>Validate source</span>
            <UIcon :name="simulationStarted ? 'i-lucide-check-circle-2' : 'i-lucide-circle'" class="mt-0.5" />
            <span>{{ simulationStarted ? "Simulation running" : "Start simulation" }}</span>
            <UIcon :name="selectedActorId ? 'i-lucide-check-circle-2' : 'i-lucide-circle'" class="mt-0.5" />
            <span>{{ selectedActorId ? `Actor selected: ${actorName(selectedActorId)}` : "Choose next actor" }}</span>
          </div>
          <UButton icon="i-lucide-play" color="primary" variant="solid" size="sm" block :loading="loading" @click="startSimulation">
            {{ simulationStarted ? "Restart" : "Start" }}
          </UButton>
          <UButton icon="i-lucide-file-check-2" color="neutral" variant="subtle" size="sm" block :loading="loading" @click="validateWorkspace">
            Validate
          </UButton>
          <UFormField label="API" size="xs">
            <UInput v-model="apiBase" icon="i-lucide-server" size="sm" class="w-full" />
          </UFormField>
          <UFormField label="Workspace" size="xs">
            <UInput v-model="workspacePath" icon="i-lucide-folder" size="sm" class="w-full" @change="updateRoute" />
          </UFormField>
          <UFormField label="Scenario" size="xs">
            <USelect v-model="scenarioId" :items="scenarioItems" icon="i-lucide-map" size="sm" class="w-full" placeholder="Select scenario" :disabled="scenarioItems.length === 0" />
          </UFormField>
        </UCard>

        <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-2 p-0 sm:p-0' }">
          <div class="flex items-center justify-between gap-2">
            <h2 class="dx-label">Actors</h2>
            <UBadge color="neutral" variant="soft" size="sm">{{ actors.length }}</UBadge>
          </div>
          <div v-if="actors.length > 0" class="space-y-1">
            <button
              v-for="actor in actors"
              :key="actor.id"
              class="dx-tile flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition"
              :class="actor.id === selectedActorId ? 'is-selected' : ''"
              @click="selectActor(actor.id)"
            >
              <span class="truncate">{{ actor.name || actor.id }}</span>
              <span class="shrink-0 text-xs opacity-70">@{{ actor.id }}</span>
            </button>
          </div>
          <p v-else class="text-sm text-muted">Start a simulation to load actors.</p>
        </UCard>

        <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-2 p-0 sm:p-0' }">
          <div class="flex items-center justify-between gap-2">
            <h2 class="dx-label">Audience</h2>
            <div class="flex items-center gap-1">
              <UButton icon="i-lucide-user-plus" color="neutral" variant="ghost" size="xs" :disabled="!selectedActorId" @click="addAudience">
                Add selected
              </UButton>
              <UButton icon="i-lucide-users" color="neutral" variant="ghost" size="xs" :disabled="actors.length === 0" @click="addAllAudience">
                Add all
              </UButton>
            </div>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <UBadge
              v-for="member in audienceMembers"
              :key="member.actorId"
              :color="member.status === 'active' ? 'success' : 'neutral'"
              variant="soft"
              size="sm"
              class="gap-1"
            >
              {{ actorName(member.actorId) }}
              <UButton
                :icon="member.status === 'active' ? 'i-lucide-pause' : 'i-lucide-play'"
                color="neutral"
                variant="ghost"
                size="xs"
                square
                @click="setAudienceStatus(member)"
              />
              <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" square @click="removeAudience(member.actorId)" />
            </UBadge>
            <span v-if="audienceMembers.length === 0" class="text-sm text-muted">None. Add observers before turns that should be heard by others.</span>
          </div>
        </UCard>

        <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-2 p-0 sm:p-0' }">
          <UTabs v-model="inspectorTab" :items="inspectorTabs" size="sm" />
          <div v-if="inspectorTab === 'beliefs'" class="max-h-52 space-y-2 overflow-auto pr-1">
            <div v-for="belief in beliefs" :key="beliefKey(belief)" class="dx-card-soft rounded-sm border p-2">
              <p class="text-xs leading-5 text-default">{{ belief.belief.propositionText }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <UBadge :color="beliefStrengthColor(belief.belief.strength)" variant="subtle" size="sm">
                  {{ beliefStrengthLabel(belief.belief.strength) }}
                </UBadge>
                <UBadge color="neutral" variant="soft" size="sm">{{ provenanceLabel(belief) }}</UBadge>
              </div>
            </div>
            <p v-if="beliefs.length === 0" class="text-sm text-muted">No beliefs loaded.</p>
          </div>
          <div v-else class="max-h-52 space-y-2 overflow-auto pr-1">
            <div v-for="memory in memories" :key="memory.id" class="dx-card-soft rounded-sm border p-2">
              <p class="dx-label mb-1">{{ actorName(memory.actorId) }}</p>
              <p class="text-xs leading-5 text-default">{{ memory.text }}</p>
            </div>
            <p v-if="memories.length === 0" class="text-sm text-muted">No memories yet.</p>
          </div>
        </UCard>
      </div>
    </aside>

    <section class="dx-workspace flex min-h-0 flex-col">
      <div class="dx-plain-panel flex h-14 shrink-0 items-center justify-between border-b border-default px-3 sm:px-4">
        <div>
          <h2 class="text-base font-semibold">Transcript</h2>
          <p class="text-sm text-muted">{{ selectedActorId ? `Next actor: ${actorName(selectedActorId)}` : "No actor selected" }}</p>
        </div>
        <UButton icon="i-lucide-door-closed" color="neutral" variant="soft" size="sm" :disabled="!canCloseEpisode" :loading="closingEpisode" @click="closeEpisode">
          Close
        </UButton>
      </div>

      <div class="dx-canvas min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
        <div v-if="transcript.length > 0" class="mx-auto max-w-3xl space-y-3">
          <article v-for="turn in transcript" :key="turn.id" class="dx-card-soft rounded-md border p-3">
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="text-sm font-semibold text-highlighted">{{ actorName(turn.actorId) }}</span>
              <UBadge color="neutral" variant="soft" size="sm">{{ audienceLabel(turn) }}</UBadge>
            </div>
            <p class="mt-0 whitespace-pre-wrap text-sm leading-6 text-default">{{ turn.text }}</p>
          </article>
        </div>
        <div v-else class="flex h-full items-center justify-center">
          <div class="max-w-sm text-center">
            <p class="text-sm font-medium text-default">No turns yet.</p>
            <p class="mt-1 text-sm text-muted">Start a simulation, add observers if needed, choose an actor, and write the next turn.</p>
          </div>
        </div>
      </div>

      <div class="dx-plain-panel shrink-0 border-t border-default p-3">
        <div class="grid gap-2" data-testid="composer">
          <div class="flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-2">
              <UIcon :name="composerMode === 'send' ? 'i-lucide-send' : 'i-lucide-wand-sparkles'" class="shrink-0 text-muted" />
              <span class="truncate text-sm font-medium text-default">{{ composerModeLabel }}</span>
            </div>
            <USwitch
              v-model="sendModeEnabled"
              color="neutral"
              size="sm"
              unchecked-icon="i-lucide-wand-sparkles"
              checked-icon="i-lucide-send"
              aria-label="Toggle composer mode"
            />
            <UBadge v-if="manualText.trim()" color="neutral" variant="soft" size="sm">Draft ready</UBadge>
          </div>
          <div v-if="composerMode === 'generate'" class="grid gap-2">
            <UTextarea v-model="whisperText" :rows="3" autoresize icon="i-lucide-ear" placeholder="Stage whisper for the generated draft..." />
            <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <USelect v-model="modelId" :items="modelItems" icon="i-lucide-cpu" size="sm" placeholder="Select model" class="w-full" />
              <UButton icon="i-lucide-wand-sparkles" size="sm" :disabled="!canGenerateTurn" :loading="generatingTurn" @click="generateTurn">
                Generate draft
              </UButton>
            </div>
          </div>
          <div v-else class="grid gap-2">
            <UTextarea v-model="manualText" :rows="3" autoresize placeholder="Edit or write the selected actor's next turn..." />
            <div class="flex justify-end">
              <UButton icon="i-lucide-send" size="sm" :disabled="!canSendManualTurn" :loading="sendingTurn" @click="sendTurn">
                Send turn
              </UButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
type Actor = { id: string; name: string; kind: string };
type ModelRecord = { id: string; name: string };
type SourceFileSummary = { id: string; name: string; path: string; kind: string };
type TranscriptTurn = { id: number; actorId: string; text: string; audience: string[]; episodeId: number | null };
type AudienceMember = { actorId: string; status: "active" | "inactive" };
type Belief = { holder?: string; strength: number; propositionText: string };
type BeliefAccess = { belief: Belief; provenance: { mode: string; holder: string; sourceHolder: string; accessPath: string[] } };
type Memory = { id: number; actorId: string; text: string };
type ComposerMode = "generate" | "send";

const route = useRoute();
const config = useRuntimeConfig();
const toast = useToast();

const apiBase = ref(config.public.apiBase);
const workspacePath = ref(String(route.query.workspace || "workspaces/demo"));
const simulationId = ref(String(route.query.simulation || "default"));
const scenarioId = ref("");
const selectedActorId = ref("");
const actors = ref<Actor[]>([]);
const models = ref<ModelRecord[]>([]);
const sourceFiles = ref<SourceFileSummary[]>([]);
const transcript = ref<TranscriptTurn[]>([]);
const audienceMembers = ref<AudienceMember[]>([]);
const beliefs = ref<BeliefAccess[]>([]);
const memories = ref<Memory[]>([]);
const manualText = ref("");
const whisperText = ref("");
const modelId = ref("local-openai-compatible");
const composerMode = ref<ComposerMode>("send");
const inspectorTab = ref("beliefs");
const loading = ref(false);
const sendingTurn = ref(false);
const generatingTurn = ref(false);
const closingEpisode = ref(false);
const compiledOnce = ref(false);

const simulationStarted = computed(() => actors.value.length > 0);
const workspaceStatus = computed(() => simulationStarted.value ? "Running" : compiledOnce.value ? "Ready" : "Setup");
const hasUnclosedTurns = computed(() => transcript.value.some((turn) => turn.episodeId === null));
const canCloseEpisode = computed(() => simulationStarted.value && hasUnclosedTurns.value);
const canSendManualTurn = computed(() => Boolean(simulationStarted.value && selectedActorId.value && manualText.value.trim()));
const canGenerateTurn = computed(() => Boolean(simulationStarted.value && selectedActorId.value && modelId.value.trim()));
const composerModeLabel = computed(() => composerMode.value === "send" ? "Send turn" : "Generate draft");
const inspectorTabs = [
  { label: "Beliefs", value: "beliefs", icon: "i-lucide-brain" },
  { label: "Memories", value: "memories", icon: "i-lucide-book-open" }
];
const sendModeEnabled = computed({
  get: () => composerMode.value === "send",
  set: (enabled: boolean) => {
    composerMode.value = enabled ? "send" : "generate";
  }
});
const modelItems = computed(() => {
  const items = models.value.map((model) => ({ label: model.name || model.id, value: model.id }));
  return items.length > 0 ? items : [{ label: modelId.value, value: modelId.value }];
});
const scenarioItems = computed(() => {
  const items = sourceFiles.value.filter((file) => file.kind === "scenario").map((file) => ({ label: file.id, value: file.id }));
  return items;
});

onMounted(async () => {
  rememberWorkspace(workspacePath.value);
  await refreshSourceFiles();
});

async function api<TValue>(path: string, options: { method?: string; body?: Record<string, unknown> } = {}): Promise<TValue> {
  return await $fetch<TValue>(`${apiBase.value}${path}`, { method: options.method || "GET", body: options.body });
}

function updateRoute(): void {
  navigateTo({ path: "/stage", query: { workspace: workspacePath.value, simulation: simulationId.value } }, { replace: true });
  rememberWorkspace(workspacePath.value);
}

async function refreshSourceFiles(): Promise<void> {
  try {
    const result = await api<{ files: SourceFileSummary[] }>(`/source?workspacePath=${encodeURIComponent(workspacePath.value)}`);
    sourceFiles.value = result.files;
    rememberWorkspace(workspacePath.value);
    if (!scenarioItems.value.some((item) => item.value === scenarioId.value)) {
      scenarioId.value = sourceFiles.value.find((file) => file.kind === "scenario")?.id || "";
    }
  } catch (error) {
    showError(error);
  }
}

async function validateWorkspace(): Promise<void> {
  await runBusy(async () => {
    const compiled = await api<{ diagnostics: Array<{ severity: string }>; models: ModelRecord[] }>("/source/compile", {
      method: "POST",
      body: { workspacePath: workspacePath.value }
    });
    compiledOnce.value = !compiled.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    models.value = compiled.models || [];
    if (!models.value.some((model) => model.id === modelId.value)) modelId.value = models.value.at(0)?.id || modelId.value;
    await refreshSourceFiles();
    toast.add({ title: compiledOnce.value ? "Source validated" : "Validation found errors", color: compiledOnce.value ? "success" : "warning" });
  });
}

async function startSimulation(): Promise<void> {
  await runBusy(async () => {
    const result = await api<{ actors: Actor[]; models: ModelRecord[] }>("/simulations/start", {
      method: "POST",
      body: {
        workspacePath: workspacePath.value,
        scenarioId: scenarioId.value || sourceFiles.value.find((file) => file.kind === "scenario")?.id || "default",
        simulationId: simulationId.value
      }
    });
    actors.value = result.actors;
    models.value = result.models || [];
    compiledOnce.value = true;
    selectedActorId.value = actors.value.at(0)?.id || "";
    await refreshAll();
    toast.add({ title: "Simulation started", color: "success" });
  });
}

async function addAudience(): Promise<void> {
  if (!selectedActorId.value) return;
  await api(`/simulations/${simulationId.value}/audience`, { method: "POST", body: { actorId: selectedActorId.value, action: "add" } });
  await refreshAudience();
}

async function addAllAudience(): Promise<void> {
  await Promise.all(actors.value.map((actor) => api(`/simulations/${simulationId.value}/audience`, { method: "POST", body: { actorId: actor.id, action: "add" } })));
  await refreshAudience();
}

async function removeAudience(actorId: string): Promise<void> {
  await api(`/simulations/${simulationId.value}/audience`, { method: "POST", body: { actorId, action: "remove" } });
  await refreshAudience();
}

async function setAudienceStatus(member: AudienceMember): Promise<void> {
  await api(`/simulations/${simulationId.value}/audience`, {
    method: "POST",
    body: { actorId: member.actorId, action: member.status === "active" ? "deactivate" : "reactivate" }
  });
  await refreshAudience();
}

async function selectActor(actorId: string): Promise<void> {
  selectedActorId.value = actorId;
  await refreshBeliefs();
}

async function sendTurn(): Promise<void> {
  if (!canSendManualTurn.value) return;
  sendingTurn.value = true;
  try {
    await api(`/simulations/${simulationId.value}/turns`, { method: "POST", body: { actorId: selectedActorId.value, manualText: manualText.value.trim() } });
    manualText.value = "";
    await refreshAll();
  } catch (error) {
    showError(error);
  } finally {
    sendingTurn.value = false;
  }
}

async function generateTurn(): Promise<void> {
  if (!canGenerateTurn.value) return;
  generatingTurn.value = true;
  try {
    const draft = await api<{ text: string }>(`/simulations/${simulationId.value}/turn-draft`, {
      method: "POST",
      body: { actorId: selectedActorId.value, modelId: modelId.value.trim(), ...(whisperText.value.trim() ? { whisperText: whisperText.value.trim() } : {}) }
    });
    manualText.value = draft.text;
    whisperText.value = "";
    composerMode.value = "send";
    toast.add({ title: "Draft generated", color: "success" });
  } catch (error) {
    showError(error);
  } finally {
    generatingTurn.value = false;
  }
}

async function closeEpisode(): Promise<void> {
  if (!canCloseEpisode.value) return;
  closingEpisode.value = true;
  try {
    await api(`/simulations/${simulationId.value}/episodes/close`, { method: "POST", body: { label: "GUI episode" } });
    await refreshAll();
    toast.add({ title: "Episode closed", color: "success" });
  } catch (error) {
    showError(error);
  } finally {
    closingEpisode.value = false;
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([refreshActors(), refreshAudience(), refreshTranscript(), refreshMemories()]);
  await refreshBeliefs();
}

async function refreshActors(): Promise<void> {
  const result = await api<{ actors: Actor[] }>(`/simulations/${simulationId.value}/actors`);
  actors.value = result.actors;
  if (!selectedActorId.value) selectedActorId.value = actors.value.at(0)?.id || "";
}
async function refreshAudience(): Promise<void> {
  const result = await api<{ audienceMembers: AudienceMember[] }>(`/simulations/${simulationId.value}/audience`);
  audienceMembers.value = result.audienceMembers;
}
async function refreshTranscript(): Promise<void> {
  const result = await api<{ transcript: TranscriptTurn[] }>(`/simulations/${simulationId.value}/transcript`);
  transcript.value = result.transcript;
}
async function refreshBeliefs(): Promise<void> {
  if (!selectedActorId.value) return;
  const result = await api<{ currentBeliefs: BeliefAccess[] }>(`/simulations/${simulationId.value}/beliefs?actorId=${selectedActorId.value}`);
  beliefs.value = result.currentBeliefs;
}
async function refreshMemories(): Promise<void> {
  const result = await api<{ memories: Memory[] }>(`/simulations/${simulationId.value}/memories`);
  memories.value = result.memories;
}
async function runBusy(callback: () => Promise<void>): Promise<void> {
  loading.value = true;
  try {
    await callback();
  } catch (error) {
    showError(error);
  } finally {
    loading.value = false;
  }
}

function actorName(actorId: string): string {
  return actors.value.find((actor) => actor.id === actorId)?.name || actorId;
}
function audienceLabel(turn: TranscriptTurn): string {
  const listeners = turn.audience.filter((actorId) => actorId !== turn.actorId).map(actorName);
  if (listeners.length === 0) return `Private to ${actorName(turn.actorId)}`;
  return `Audience: ${listeners.join(", ")}`;
}
function beliefKey(belief: BeliefAccess): string {
  return `${belief.provenance.mode}:${belief.provenance.sourceHolder}:${belief.belief.strength}:${belief.belief.propositionText}`;
}
function beliefStrengthLabel(strength: number): string {
  if (strength >= 3) return "Treats as true";
  if (strength > 0) return "Suspects";
  if (strength <= -3) return "Treats as false";
  if (strength < 0) return "Doubts";
  return "Neutral";
}
function beliefStrengthColor(strength: number): "success" | "warning" | "error" | "neutral" {
  if (strength >= 3) return "success";
  if (strength > 0) return "warning";
  if (strength < 0) return "error";
  return "neutral";
}
function provenanceLabel(access: BeliefAccess): string {
  if (access.provenance.mode === "held") return "Held";
  if (access.provenance.mode === "accessed_through_membership") return `Via ${actorName(access.provenance.sourceHolder)}`;
  if (access.provenance.mode === "observed") return `Observed ${actorName(access.provenance.sourceHolder)}`;
  if (access.provenance.mode === "retained_after_access_loss") return `Retained from ${actorName(access.provenance.sourceHolder)}`;
  return access.provenance.mode.replaceAll("_", " ");
}
function rememberWorkspace(path: string): void {
  if (!path || !import.meta.client) return;
  try {
    const parsed = JSON.parse(localStorage.getItem("doxvelt.recentWorkspaces") || "[]") as unknown;
    const current = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    localStorage.setItem("doxvelt.recentWorkspaces", JSON.stringify([path, ...current.filter((workspace) => workspace !== path)].slice(0, 8)));
  } catch {
    localStorage.setItem("doxvelt.recentWorkspaces", JSON.stringify([path]));
  }
}
function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  toast.add({ title: "Doxvelt", description: message, color: "error" });
}
</script>
