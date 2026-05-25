<template>
  <UApp>
    <main class="min-h-screen">
      <div class="mx-auto grid min-h-screen max-w-[1600px] grid-cols-1 gap-4 px-4 py-4 lg:grid-cols-[320px_minmax(0,1fr)_380px]">
        <aside class="flex flex-col gap-4">
          <UCard variant="subtle" :ui="{ root: 'rounded-lg', body: 'space-y-3' }">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h1 class="text-xl font-semibold text-slate-950">Doxvelt</h1>
                <p class="text-sm text-slate-500">{{ apiStatus }}</p>
              </div>
              <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :loading="loading" @click="refreshAll" />
            </div>

            <UFormField label="API">
              <UInput v-model="apiBase" icon="i-lucide-server" />
            </UFormField>
            <UFormField label="World">
              <UInput v-model="worldPath" icon="i-lucide-folder" />
            </UFormField>
            <div class="grid grid-cols-2 gap-2">
              <UButton icon="i-lucide-sparkles" color="neutral" variant="soft" :loading="loading" @click="initExample">
                Init
              </UButton>
              <UButton icon="i-lucide-file-check-2" color="neutral" variant="soft" :loading="loading" @click="compileWorld">
                Compile
              </UButton>
            </div>
            <UButton icon="i-lucide-play" block :loading="loading" @click="startSimulation">
              Start
            </UButton>
          </UCard>

          <UCard variant="subtle" :ui="{ root: 'rounded-lg', body: 'space-y-3' }">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500">Actors</h2>
              <UBadge color="neutral" variant="soft">{{ actors.length }}</UBadge>
            </div>
            <URadioGroup
              v-model="selectedActorId"
              :items="actorItems"
              variant="card"
              :ui="{ fieldset: 'space-y-2' }"
              @update:model-value="refreshContext"
            />
          </UCard>

          <UCard variant="subtle" :ui="{ root: 'rounded-lg', body: 'space-y-3' }">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500">Audience</h2>
              <UButton icon="i-lucide-user-plus" color="neutral" variant="ghost" square :disabled="!selectedActorId" @click="addAudience" />
            </div>
            <div class="flex flex-wrap gap-2">
              <UBadge
                v-for="member in audienceMembers"
                :key="member.actorId"
                :color="member.status === 'active' ? 'primary' : 'neutral'"
                variant="soft"
              >
                {{ member.actorId }}
              </UBadge>
              <span v-if="audienceMembers.length === 0" class="text-sm text-slate-500">None</span>
            </div>
          </UCard>
        </aside>

        <section class="flex min-h-[720px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div>
              <h2 class="text-base font-semibold text-slate-950">Transcript</h2>
              <p class="text-sm text-slate-500">{{ selectedActorId || "No actor selected" }}</p>
            </div>
            <UButton icon="i-lucide-door-closed" color="neutral" variant="soft" :loading="closingEpisode" @click="closeEpisode">
              Close Episode
            </UButton>
          </div>

          <UChatMessages
            class="min-h-0 flex-1 overflow-y-auto px-4 py-5"
            :messages="chatMessages"
          >
            <template #content="{ message }">
              <div class="max-w-3xl">
                <p class="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{{ message.actorId }}</p>
                <p class="whitespace-pre-wrap leading-7 text-slate-900">{{ message.content }}</p>
                <div class="mt-2 flex flex-wrap gap-1">
                  <UBadge v-for="target in message.audience" :key="target" color="neutral" variant="outline">
                    {{ target }}
                  </UBadge>
                </div>
              </div>
            </template>
          </UChatMessages>

          <div class="border-t border-slate-200 p-4">
            <div class="grid gap-3">
              <UTextarea
                v-model="manualText"
                :rows="4"
                autoresize
                placeholder="Write the selected actor's next turn..."
              />
              <div class="grid gap-3 md:grid-cols-[1fr_auto]">
                <UInput v-model="whisperText" icon="i-lucide-ear" placeholder="Stage whisper for this turn" />
                <UButton icon="i-lucide-send" :disabled="!selectedActorId || !manualText.trim()" :loading="sendingTurn" @click="sendTurn">
                  Send Turn
                </UButton>
              </div>
            </div>
          </div>
        </section>

        <aside class="grid gap-4 lg:grid-rows-[minmax(0,1fr)_minmax(220px,auto)]">
          <UCard variant="subtle" :ui="{ root: 'min-h-0 rounded-lg', body: 'flex min-h-0 flex-col gap-3' }">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500">Context</h2>
              <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :disabled="!selectedActorId" @click="refreshContext" />
            </div>
            <pre class="min-h-[360px] flex-1 overflow-auto rounded-md bg-slate-950 p-3 text-xs leading-5 text-slate-100">{{ contextPreview }}</pre>
          </UCard>

          <UCard variant="subtle" :ui="{ root: 'rounded-lg', body: 'space-y-3' }">
            <UTabs v-model="inspectorTab" :items="inspectorTabs" />
            <div v-if="inspectorTab === 'beliefs'" class="max-h-72 space-y-2 overflow-auto">
              <div v-for="belief in beliefs" :key="beliefKey(belief)" class="rounded-md border border-slate-200 bg-white p-3">
                <div class="mb-1 flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-slate-700">{{ belief.holder || selectedActorId }}</span>
                  <UBadge color="neutral" variant="soft">{{ belief.strength }}</UBadge>
                </div>
                <p class="text-sm text-slate-700">{{ belief.propositionText }}</p>
              </div>
              <p v-if="beliefs.length === 0" class="text-sm text-slate-500">No beliefs loaded.</p>
            </div>
            <div v-else class="max-h-72 space-y-2 overflow-auto">
              <div v-for="memory in memories" :key="memory.id" class="rounded-md border border-slate-200 bg-white p-3">
                <p class="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{{ memory.actorId }}</p>
                <p class="text-sm leading-6 text-slate-700">{{ memory.text }}</p>
              </div>
              <p v-if="memories.length === 0" class="text-sm text-slate-500">No memories yet.</p>
            </div>
          </UCard>
        </aside>
      </div>

      <UToast />
    </main>
  </UApp>
</template>

<script setup lang="ts">
type Actor = {
  id: string;
  name: string;
  kind: string;
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

type Memory = {
  id: number;
  actorId: string;
  text: string;
};

const config = useRuntimeConfig();
const toast = useToast();

const apiBase = ref(config.public.apiBase);
const worldPath = ref("workspaces/demo");
const simulationId = ref("default");
const selectedActorId = ref("");
const actors = ref<Actor[]>([]);
const transcript = ref<TranscriptTurn[]>([]);
const audienceMembers = ref<AudienceMember[]>([]);
const contextPreview = ref("");
const beliefs = ref<Belief[]>([]);
const memories = ref<Memory[]>([]);
const manualText = ref("");
const whisperText = ref("");
const apiStatus = ref("API idle");
const inspectorTab = ref("beliefs");
const loading = ref(false);
const sendingTurn = ref(false);
const closingEpisode = ref(false);

const inspectorTabs = [
  { label: "Beliefs", value: "beliefs", icon: "i-lucide-brain" },
  { label: "Memories", value: "memories", icon: "i-lucide-book-open" }
];

const actorItems = computed(() => actors.value.map((actor) => ({
  label: actor.name || actor.id,
  value: actor.id,
  description: actor.kind
})));

const chatMessages = computed(() => transcript.value.map((turn) => ({
  id: String(turn.id),
  role: turn.actorId === selectedActorId.value ? "assistant" : "user",
  content: turn.text,
  actorId: turn.actorId,
  audience: turn.audience
})));

async function api<TValue>(path: string, options: { method?: string; body?: Record<string, unknown> } = {}): Promise<TValue> {
  return await $fetch<TValue>(`${apiBase.value}${path}`, {
    method: options.method || "GET",
    body: options.body
  });
}

async function initExample(): Promise<void> {
  await runBusy(async () => {
    await api("/source/init", {
      method: "POST",
      body: {
        worldPath: worldPath.value,
        template: "executive-interviews"
      }
    });
    await compileWorld();
    toast.add({ title: "World initialized", color: "success" });
  });
}

async function compileWorld(): Promise<void> {
  await runBusy(async () => {
    const compiled = await api<{ diagnostics: Array<{ severity: string }> }>("/source/compile", {
      method: "POST",
      body: { worldPath: worldPath.value }
    });
    const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    toast.add({ title: errors ? "Compile finished with errors" : "Compile finished", color: errors ? "warning" : "success" });
  });
}

async function startSimulation(): Promise<void> {
  await runBusy(async () => {
    const result = await api<{ actors: Actor[] }>("/simulations/start", {
      method: "POST",
      body: {
        worldPath: worldPath.value,
        scenarioId: "executive-interviews",
        simulationId: simulationId.value
      }
    });
    actors.value = result.actors;
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

async function sendTurn(): Promise<void> {
  if (!selectedActorId.value || !manualText.value.trim()) return;
  sendingTurn.value = true;
  try {
    await api(`/simulations/${simulationId.value}/turns`, {
      method: "POST",
      body: {
        actorId: selectedActorId.value,
        manualText: manualText.value.trim(),
        ...(whisperText.value.trim() ? { whisperText: whisperText.value.trim() } : {})
      }
    });
    manualText.value = "";
    whisperText.value = "";
    await refreshAll();
  } catch (error) {
    showError(error);
  } finally {
    sendingTurn.value = false;
  }
}

async function closeEpisode(): Promise<void> {
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
  const result = await api<{ currentBeliefs: Belief[] }>(`/simulations/${simulationId.value}/beliefs?actorId=${selectedActorId.value}`);
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

function beliefKey(belief: Belief): string {
  return `${belief.holder || selectedActorId.value}:${belief.strength}:${belief.propositionText}`;
}
</script>
