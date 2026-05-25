<template>
  <UApp>
    <main class="h-dvh overflow-hidden bg-slate-100 text-slate-950">
      <div class="flex h-full min-h-0 flex-col">
        <header class="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3 sm:px-4">
          <div class="flex min-w-0 items-center gap-3">
            <h1 class="text-lg font-semibold">Doxvelt</h1>
            <UBadge color="neutral" variant="soft" size="sm">{{ apiStatus }}</UBadge>
          </div>
          <div class="flex items-center gap-2">
            <UTooltip text="Sync current simulation state from the local API">
              <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" :loading="loading" @click="refreshAll">
                Sync
              </UButton>
            </UTooltip>
          </div>
        </header>

        <div class="grid min-h-0 flex-1 grid-cols-[252px_minmax(0,1fr)] gap-0 sm:grid-cols-[280px_minmax(0,1fr)]">
          <aside class="min-h-0 overflow-y-auto border-r border-slate-200 bg-white/85 p-3">
            <div class="space-y-3">
              <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-2 p-3 sm:p-3' }">
                <div class="flex items-center justify-between gap-2">
                  <h2 class="text-xs font-semibold uppercase text-slate-500">Workspace</h2>
                  <UBadge :color="simulationStarted ? 'success' : compiledOnce ? 'warning' : 'neutral'" variant="subtle" size="sm">
                    {{ workspaceStatus }}
                  </UBadge>
                </div>
                <div class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-md bg-slate-50 p-2 text-xs text-slate-600 ring-1 ring-slate-200">
                  <UIcon :name="compiledOnce ? 'i-lucide-check-circle-2' : 'i-lucide-circle'" class="mt-0.5" />
                  <span>Compile source</span>
                  <UIcon :name="simulationStarted ? 'i-lucide-check-circle-2' : 'i-lucide-circle'" class="mt-0.5" />
                  <span>{{ simulationStarted ? "Simulation running" : "Start simulation" }}</span>
                  <UIcon :name="selectedActorId ? 'i-lucide-check-circle-2' : 'i-lucide-circle'" class="mt-0.5" />
                  <span>{{ selectedActorId ? `Actor selected: ${selectedActorId}` : "Choose next actor" }}</span>
                </div>
                <UButton icon="i-lucide-play" color="neutral" variant="solid" size="sm" block :loading="loading" @click="startSimulation">
                  {{ simulationStarted ? "Restart" : "Start" }}
                </UButton>
                <div class="grid grid-cols-2 gap-2">
                  <UButton icon="i-lucide-sparkles" color="neutral" variant="subtle" size="sm" :loading="loading" @click="initExample">
                    Init
                  </UButton>
                  <UButton icon="i-lucide-file-check-2" color="neutral" variant="subtle" size="sm" :loading="loading" @click="compileWorld">
                    Compile
                  </UButton>
                </div>
                <UFormField label="API" size="xs">
                  <UInput v-model="apiBase" icon="i-lucide-server" size="sm" />
                </UFormField>
                <UFormField label="World" size="xs">
                  <UInput v-model="worldPath" icon="i-lucide-folder" size="sm" />
                </UFormField>
              </UCard>

              <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-2 p-3 sm:p-3' }">
                <div class="flex items-center justify-between gap-2">
                  <h2 class="text-xs font-semibold uppercase text-slate-500">Actors</h2>
                  <UBadge color="neutral" variant="soft" size="sm">{{ actors.length }}</UBadge>
                </div>
                <div v-if="actors.length > 0" class="space-y-1">
                  <button
                    v-for="actor in actors"
                    :key="actor.id"
                    class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-slate-100"
                    :class="actor.id === selectedActorId ? 'bg-slate-100 text-slate-950 ring-1 ring-slate-200 hover:bg-slate-100' : 'text-slate-700'"
                    @click="selectActor(actor.id)"
                  >
                    <span class="truncate">{{ actor.name || actor.id }}</span>
                    <span class="shrink-0 text-xs opacity-70">{{ actor.kind }}</span>
                  </button>
                </div>
                <p v-else class="text-sm text-slate-500">Start a simulation to load actors.</p>
              </UCard>

              <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-2 p-3 sm:p-3' }">
                <div class="flex items-center justify-between gap-2">
                  <h2 class="text-xs font-semibold uppercase text-slate-500">Audience</h2>
                  <UTooltip text="Add selected actor to the active audience">
                    <UButton icon="i-lucide-user-plus" color="neutral" variant="ghost" size="xs" square :disabled="!selectedActorId" @click="addAudience" />
                  </UTooltip>
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
                    {{ member.actorId }}
                    <UTooltip :text="member.status === 'active' ? 'Deactivate audience access' : 'Reactivate audience access'">
                      <UButton
                        :icon="member.status === 'active' ? 'i-lucide-pause' : 'i-lucide-play'"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        square
                        @click="setAudienceStatus(member)"
                      />
                    </UTooltip>
                    <UTooltip text="Remove from audience">
                      <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" square @click="removeAudience(member.actorId)" />
                    </UTooltip>
                  </UBadge>
                  <span v-if="audienceMembers.length === 0" class="text-sm text-slate-500">None</span>
                </div>
              </UCard>

              <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-2 p-3 sm:p-3' }">
                <div class="flex items-center justify-between gap-2">
                  <h2 class="text-xs font-semibold uppercase text-slate-500">Context</h2>
                  <UTooltip text="Refresh context for the selected actor only">
                    <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="xs" square :disabled="!selectedActorId" @click="refreshContext" />
                  </UTooltip>
                </div>
                <pre class="max-h-52 overflow-auto rounded-md bg-slate-50 p-2 text-[11px] leading-4 text-slate-700 ring-1 ring-slate-200">{{ contextPreview || "No context loaded." }}</pre>
              </UCard>

              <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-2 p-3 sm:p-3' }">
                <UTabs v-model="inspectorTab" :items="inspectorTabs" size="sm" />
                <div v-if="inspectorTab === 'beliefs'" class="max-h-52 space-y-2 overflow-auto pr-1">
                  <div v-for="belief in beliefs" :key="beliefKey(belief)" class="rounded-md border border-slate-200 bg-white p-2">
                    <p class="text-xs leading-5 text-slate-800">{{ belief.belief.propositionText }}</p>
                    <div class="mt-2 flex flex-wrap items-center gap-1.5">
                      <UBadge :color="beliefStrengthColor(belief.belief.strength)" variant="subtle" size="sm">
                        {{ beliefStrengthLabel(belief.belief.strength) }}
                      </UBadge>
                      <UBadge color="neutral" variant="soft" size="sm">
                        {{ provenanceLabel(belief) }}
                      </UBadge>
                    </div>
                  </div>
                  <p v-if="beliefs.length === 0" class="text-sm text-slate-500">No beliefs loaded.</p>
                </div>
                <div v-else class="max-h-52 space-y-2 overflow-auto pr-1">
                  <div v-for="memory in memories" :key="memory.id" class="rounded-md border border-slate-200 bg-white p-2">
                    <p class="mb-1 text-xs font-medium uppercase text-slate-500">{{ memory.actorId }}</p>
                    <p class="text-xs leading-5 text-slate-700">{{ memory.text }}</p>
                  </div>
                  <p v-if="memories.length === 0" class="text-sm text-slate-500">No memories yet.</p>
                </div>
              </UCard>
            </div>
          </aside>

          <section class="flex min-h-0 flex-col bg-white">
            <div class="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 sm:px-4">
              <div>
                <h2 class="text-base font-semibold">Transcript</h2>
                <p class="text-sm text-slate-500">{{ selectedActorId ? `Next actor: ${selectedActorId}` : "No actor selected" }}</p>
              </div>
              <UTooltip :text="canCloseEpisode ? 'Close the current episode and write memories' : 'Add at least one turn before closing an episode'">
                <UButton icon="i-lucide-door-closed" color="neutral" variant="soft" size="sm" :disabled="!canCloseEpisode" :loading="closingEpisode" @click="closeEpisode">
                  Close
                </UButton>
              </UTooltip>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto bg-slate-50 px-3 py-3 sm:px-4">
              <div v-if="transcript.length > 0" class="mx-auto max-w-3xl space-y-3">
                <article
                  v-for="turn in transcript"
                  :key="turn.id"
                  class="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
                >
                  <div class="mb-2 flex items-center justify-between gap-2">
                    <span class="text-sm font-semibold text-slate-800">{{ turn.actorId }}</span>
                    <div class="flex flex-wrap justify-end gap-1">
                      <UBadge color="neutral" variant="soft" size="sm">
                        {{ audienceLabel(turn) }}
                      </UBadge>
                    </div>
                  </div>
                  <p class="mt-0 whitespace-pre-wrap text-sm leading-6 text-slate-800">{{ turn.text }}</p>
                </article>
              </div>
              <div v-else class="flex h-full items-center justify-center">
                <div class="max-w-sm text-center">
                  <p class="text-sm font-medium text-slate-700">No turns yet.</p>
                  <p class="mt-1 text-sm text-slate-500">Start a simulation, choose an actor, and write the next turn.</p>
                </div>
              </div>
            </div>

            <div class="shrink-0 border-t border-slate-200 bg-white p-3">
              <div class="grid gap-2" data-testid="composer">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex min-w-0 items-center gap-2">
                    <UIcon :name="composerMode === 'send' ? 'i-lucide-send' : 'i-lucide-wand-sparkles'" class="shrink-0 text-slate-500" />
                    <span class="truncate text-sm font-medium text-slate-700">{{ composerModeLabel }}</span>
                  </div>
                  <UTooltip :text="composerMode === 'send' ? 'Switch to draft generation' : 'Switch to manual send'">
                    <USwitch
                      v-model="sendModeEnabled"
                      color="neutral"
                      size="sm"
                      unchecked-icon="i-lucide-wand-sparkles"
                      checked-icon="i-lucide-send"
                      aria-label="Toggle composer mode"
                    />
                  </UTooltip>
                  <UBadge v-if="manualText.trim()" color="neutral" variant="soft" size="sm">Draft ready</UBadge>
                </div>

                <div class="min-h-[104px]">
                  <div v-if="composerMode === 'generate'" class="grid gap-2">
                    <UTextarea
                      v-model="whisperText"
                      :rows="3"
                      autoresize
                      icon="i-lucide-ear"
                      placeholder="Stage whisper for the generated draft..."
                    />
                    <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <USelect v-model="modelId" :items="modelItems" icon="i-lucide-cpu" size="sm" placeholder="Select model" />
                      <UButton icon="i-lucide-wand-sparkles" size="sm" :disabled="!canGenerateTurn" :loading="generatingTurn" @click="generateTurn">
                        Generate draft
                      </UButton>
                    </div>
                  </div>

                  <div v-else class="grid gap-2">
                    <UTextarea
                      v-model="manualText"
                      :rows="3"
                      autoresize
                      placeholder="Edit or write the selected actor's next turn..."
                    />
                    <div class="flex justify-end">
                      <UButton icon="i-lucide-send" size="sm" :disabled="!canSendManualTurn" :loading="sendingTurn" @click="sendTurn">
                        Send turn
                      </UButton>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  </UApp>
</template>

<script setup lang="ts">
type Actor = {
  id: string;
  name: string;
  kind: string;
};

type ModelRecord = {
  id: string;
  name: string;
};

type TranscriptTurn = {
  id: number;
  actorId: string;
  text: string;
  audience: string[];
};

type AudienceMember = {
  actorId: string;
  status: "active" | "inactive";
};

type Belief = {
  holder?: string;
  strength: number;
  propositionText: string;
};

type BeliefAccess = {
  belief: Belief;
  provenance: {
    mode: string;
    holder: string;
    sourceHolder: string;
    accessPath: string[];
  };
};

type Memory = {
  id: number;
  actorId: string;
  text: string;
};

type ComposerMode = "generate" | "send";

const config = useRuntimeConfig();
const toast = useToast();

const apiBase = ref(config.public.apiBase);
const worldPath = ref("workspaces/demo");
const simulationId = ref("default");
const selectedActorId = ref("");
const actors = ref<Actor[]>([]);
const models = ref<ModelRecord[]>([]);
const transcript = ref<TranscriptTurn[]>([]);
const audienceMembers = ref<AudienceMember[]>([]);
const contextPreview = ref("");
const beliefs = ref<BeliefAccess[]>([]);
const memories = ref<Memory[]>([]);
const manualText = ref("");
const whisperText = ref("");
const modelId = ref("local-openai-compatible");
const composerMode = ref<ComposerMode>("generate");
const apiStatus = ref("API idle");
const inspectorTab = ref("beliefs");
const loading = ref(false);
const sendingTurn = ref(false);
const generatingTurn = ref(false);
const closingEpisode = ref(false);
const compiledOnce = ref(false);
const simulationStarted = computed(() => actors.value.length > 0);
const canCloseEpisode = computed(() => simulationStarted.value && transcript.value.length > 0);
const canSendManualTurn = computed(() => Boolean(simulationStarted.value && selectedActorId.value && manualText.value.trim()));
const canGenerateTurn = computed(() => Boolean(simulationStarted.value && selectedActorId.value && modelId.value.trim()));

const inspectorTabs = [
  { label: "Beliefs", value: "beliefs", icon: "i-lucide-brain" },
  { label: "Memories", value: "memories", icon: "i-lucide-book-open" }
];

const workspaceStatus = computed(() => {
  if (simulationStarted.value) return "Running";
  if (compiledOnce.value) return "Ready";
  return "Setup";
});

const composerModeLabel = computed(() => {
  return composerMode.value === "send" ? "Send turn" : "Generate draft";
});

const sendModeEnabled = computed({
  get: () => composerMode.value === "send",
  set: (enabled: boolean) => {
    composerMode.value = enabled ? "send" : "generate";
  }
});

const modelItems = computed(() => {
  const items = models.value.map((model) => ({
    label: model.name || model.id,
    value: model.id
  }));
  return items.length > 0 ? items : [{ label: modelId.value, value: modelId.value }];
});

async function api<TValue>(path: string, options: { method?: string; body?: Record<string, unknown> } = {}): Promise<TValue> {
  return await $fetch<TValue>(`${apiBase.value}${path}`, {
    method: options.method || "GET",
    body: options.body
  });
}

async function initExample(): Promise<void> {
  await runBusy(async () => {
    const result = await api<{ created?: boolean; message?: string }>("/source/init", {
      method: "POST",
      body: {
        worldPath: worldPath.value,
        template: "executive-interviews"
      }
    });
    toast.add({
      title: result.created === false ? "World already exists" : "World initialized",
      description: result.message,
      color: result.created === false ? "neutral" : "success"
    });
  });
}

async function compileWorld(): Promise<void> {
  await runBusy(async () => {
    const compiled = await api<{ diagnostics: Array<{ severity: string }>; models: ModelRecord[] }>("/source/compile", {
      method: "POST",
      body: { worldPath: worldPath.value }
    });
    const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    compiledOnce.value = errors === 0;
    models.value = compiled.models || [];
    if (!models.value.some((model) => model.id === modelId.value)) {
      modelId.value = models.value.at(0)?.id || modelId.value;
    }
    toast.add({ title: errors ? "Compile finished with errors" : "Compile finished", color: errors ? "warning" : "success" });
  });
}

async function startSimulation(): Promise<void> {
  await runBusy(async () => {
    const result = await api<{ actors: Actor[]; models: ModelRecord[] }>("/simulations/start", {
      method: "POST",
      body: {
        worldPath: worldPath.value,
        scenarioId: "executive-interviews",
        simulationId: simulationId.value
      }
    });
    actors.value = result.actors;
    models.value = result.models || [];
    compiledOnce.value = true;
    if (!models.value.some((model) => model.id === modelId.value)) {
      modelId.value = models.value.at(0)?.id || modelId.value;
    }
    selectedActorId.value = actors.value.at(0)?.id || "";
    await refreshAll();
    toast.add({ title: "Simulation started", color: "success" });
  });
}

async function addAudience(): Promise<void> {
  if (!selectedActorId.value) return;
  await api(`/simulations/${simulationId.value}/audience`, {
    method: "POST",
    body: {
      actorId: selectedActorId.value,
      action: "add"
    }
  });
  await refreshAudience();
}

async function removeAudience(actorId: string): Promise<void> {
  await api(`/simulations/${simulationId.value}/audience`, {
    method: "POST",
    body: {
      actorId,
      action: "remove"
    }
  });
  await refreshAudience();
}

async function setAudienceStatus(member: AudienceMember): Promise<void> {
  await api(`/simulations/${simulationId.value}/audience`, {
    method: "POST",
    body: {
      actorId: member.actorId,
      action: member.status === "active" ? "deactivate" : "reactivate"
    }
  });
  await refreshAudience();
}

async function selectActor(actorId: string): Promise<void> {
  selectedActorId.value = actorId;
  await refreshContext();
}

async function sendTurn(): Promise<void> {
  if (!canSendManualTurn.value) return;
  sendingTurn.value = true;
  try {
    await api(`/simulations/${simulationId.value}/turns`, {
      method: "POST",
      body: {
        actorId: selectedActorId.value,
        manualText: manualText.value.trim()
      }
    });
    manualText.value = "";
    composerMode.value = "generate";
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
      body: {
        actorId: selectedActorId.value,
        modelId: modelId.value.trim(),
        ...(whisperText.value.trim() ? { whisperText: whisperText.value.trim() } : {})
      }
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
    await api(`/simulations/${simulationId.value}/episodes/close`, {
      method: "POST",
      body: { label: "GUI episode" }
    });
    await refreshAll();
    toast.add({ title: "Episode closed", color: "success" });
  } catch (error) {
    showError(error);
  } finally {
    closingEpisode.value = false;
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([
    refreshActors(),
    refreshAudience(),
    refreshTranscript(),
    refreshMemories()
  ]);
  await refreshContext();
  apiStatus.value = "API connected";
}

async function refreshActors(): Promise<void> {
  const result = await api<{ actors: Actor[] }>(`/simulations/${simulationId.value}/actors`);
  actors.value = result.actors;
  if (actors.value.length > 0) compiledOnce.value = true;
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

async function refreshContext(): Promise<void> {
  if (!selectedActorId.value) return;
  const result = await api<{ promptPreview: string }>(`/simulations/${simulationId.value}/context/${selectedActorId.value}`);
  contextPreview.value = result.promptPreview;
  await refreshBeliefs();
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

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  apiStatus.value = "API error";
  toast.add({ title: "Doxvelt", description: message, color: "error" });
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
  if (access.provenance.mode === "accessed_through_membership") {
    return `Via ${access.provenance.sourceHolder}`;
  }
  if (access.provenance.mode === "observed") return `Observed ${access.provenance.sourceHolder}`;
  if (access.provenance.mode === "retained_after_access_loss") return `Retained from ${access.provenance.sourceHolder}`;
  return access.provenance.mode.replaceAll("_", " ");
}

function audienceLabel(turn: TranscriptTurn): string {
  const listeners = turn.audience.filter((actorId) => actorId !== turn.actorId);
  if (listeners.length === 0) return `Private to ${turn.actorId}`;
  return `Audience: ${listeners.join(", ")}`;
}
</script>
