<template>
  <div class="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] gap-0">
    <aside class="flex min-h-0 flex-col gap-3 overflow-hidden border-r border-slate-200 bg-white/85 p-3">
      <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-3 p-3 sm:p-3' }">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-xs font-semibold uppercase text-slate-500">Source Workspace</h2>
          <UBadge color="neutral" variant="soft" size="sm">{{ sourceFiles.length }}</UBadge>
        </div>
        <UFormField label="Workspace" size="xs">
          <UInput v-model="workspacePath" icon="i-lucide-folder" size="sm" class="w-full" @change="updateRoute" />
        </UFormField>
        <div class="grid grid-cols-2 gap-2">
          <UButton icon="i-lucide-refresh-cw" color="neutral" variant="subtle" size="sm" block :loading="loadingSource" @click="refreshSourceFiles">
            Reload
          </UButton>
          <UButton icon="i-lucide-file-check-2" color="neutral" variant="subtle" size="sm" block :loading="loading" @click="validateWorkspace">
            Validate
          </UButton>
        </div>
      </UCard>

      <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-3 p-3 sm:p-3' }">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-xs font-semibold uppercase text-slate-500">Create</h2>
          <UBadge color="neutral" variant="soft" size="sm">{{ newAssetKindLabel }}</UBadge>
        </div>
        <USelect v-model="newAssetKind" :items="newAssetKindItems" icon="i-lucide-layers" size="sm" class="w-full" />
        <UInput v-model="newAssetId" icon="i-lucide-at-sign" size="sm" placeholder="stable-id" class="w-full" />
        <UInput v-model="newAssetName" icon="i-lucide-type" size="sm" placeholder="Display name" class="w-full" />
        <UButton icon="i-lucide-plus" color="neutral" variant="solid" size="sm" block :disabled="!canCreateSourceAsset" @click="createSourceAsset">
          Create source file
        </UButton>
      </UCard>

      <UCard :ui="{ root: 'flex min-h-0 flex-1 flex-col rounded-lg border border-slate-200 shadow-none', body: 'flex min-h-0 flex-1 flex-col space-y-2 p-3 sm:p-3' }">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-xs font-semibold uppercase text-slate-500">Files</h2>
          <UInput v-model="sourceFilter" icon="i-lucide-search" size="xs" placeholder="Filter" class="w-full max-w-36" />
        </div>
        <div class="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
          <section v-for="group in groupedSourceFiles" :key="group.label" class="space-y-1">
            <div class="flex items-center justify-between px-1">
              <h3 class="text-[11px] font-semibold uppercase text-slate-500">{{ group.label }}</h3>
              <UBadge color="neutral" variant="soft" size="sm">{{ group.files.length }}</UBadge>
            </div>
            <button
              v-for="file in group.files"
              :key="file.path"
              class="grid w-full grid-cols-[1fr_auto] gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-slate-100"
              :class="file.path === selectedSourcePath ? 'bg-slate-100 text-slate-950 ring-1 ring-slate-200 hover:bg-slate-100' : 'text-slate-700'"
              @click="openSourceFile(file.path)"
            >
              <span class="min-w-0 truncate">{{ sourceFileLabel(file) }}</span>
              <span class="text-xs text-slate-500">{{ sourceKindLabel(file) }}</span>
              <span class="col-span-2 min-w-0 truncate text-xs text-slate-500">{{ file.path }}</span>
            </button>
          </section>
          <div v-if="filteredSourceFiles.length === 0" class="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-500">
            No source files found. Go home to create a blank workspace or initialize the demo.
          </div>
        </div>
      </UCard>
    </aside>

    <section class="flex min-h-0 flex-col bg-white">
      <div class="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 sm:px-4">
        <div class="min-w-0">
          <h2 class="truncate text-base font-semibold">{{ selectedSourcePath || "Studio" }}</h2>
          <p class="text-sm text-slate-500">{{ sourceEditorState }}</p>
        </div>
        <UButton icon="i-lucide-save" color="neutral" variant="solid" size="sm" :disabled="!canSaveSourceFile" :loading="savingSource" @click="saveSourceFile">
          Save
        </UButton>
      </div>
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-0">
        <div class="min-h-0 bg-slate-50 p-3">
          <UTextarea
            v-model="sourceText"
            :rows="28"
            autoresize
            class="h-full w-full"
            placeholder="Select or create a source file to author natural-language Doxvelt material."
            :ui="{ root: 'h-full w-full', base: 'h-full min-h-[calc(100dvh-9.5rem)] w-full font-mono text-[13px] leading-5' }"
          />
        </div>
        <aside class="min-h-0 overflow-y-auto border-l border-slate-200 bg-white p-3">
          <div class="space-y-3">
            <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-2 p-3 sm:p-3' }">
              <h3 class="text-xs font-semibold uppercase text-slate-500">{{ selectedSourceHelp.title }}</h3>
              <div class="space-y-2 text-sm text-slate-700">
                <p v-for="line in selectedSourceHelp.lines" :key="line">{{ line }}</p>
              </div>
            </UCard>
            <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-2 p-3 sm:p-3' }">
              <h3 class="text-xs font-semibold uppercase text-slate-500">Line Tags</h3>
              <div class="flex flex-wrap gap-1.5">
                <UBadge v-for="tag in studioTags" :key="tag" color="neutral" variant="soft" size="sm">{{ tag }}</UBadge>
              </div>
            </UCard>
            <UCard :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'space-y-2 p-3 sm:p-3' }">
              <h3 class="text-xs font-semibold uppercase text-slate-500">Source Health</h3>
              <div class="grid grid-cols-2 gap-2 text-sm">
                <div class="rounded-md bg-slate-50 p-2 ring-1 ring-slate-200">
                  <p class="text-xs uppercase text-slate-500">Status</p>
                  <p class="font-medium">{{ validationStatus }}</p>
                </div>
                <div class="rounded-md bg-slate-50 p-2 ring-1 ring-slate-200">
                  <p class="text-xs uppercase text-slate-500">Models</p>
                  <p class="font-medium">{{ models.length }}</p>
                </div>
              </div>
              <div class="max-h-64 space-y-2 overflow-auto pr-1">
                <div
                  v-for="diagnostic in compileDiagnostics"
                  :key="diagnosticKey(diagnostic)"
                  class="rounded-md border p-2 text-xs"
                  :class="diagnostic.severity === 'error' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900'"
                >
                  <div class="mb-1 flex items-center justify-between gap-2">
                    <span class="font-semibold">{{ diagnostic.code }}</span>
                    <UBadge :color="diagnostic.severity === 'error' ? 'error' : 'warning'" variant="subtle" size="sm">
                      {{ diagnostic.severity }}
                    </UBadge>
                  </div>
                  <p class="leading-5">{{ diagnostic.message }}</p>
                  <p v-if="diagnostic.sourceSpans?.length" class="mt-1 truncate text-[11px] opacity-75">
                    {{ diagnostic.sourceSpans[0]?.file }}:{{ diagnostic.sourceSpans[0]?.line }}
                  </p>
                </div>
                <p v-if="compileDiagnostics.length === 0" class="text-sm text-slate-500">{{ validationEmptyText }}</p>
              </div>
            </UCard>
          </div>
        </aside>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
type SourceFileSummary = {
  id: string;
  name: string;
  path: string;
  kind: "model" | "world" | "scenario" | "format" | "entity-file" | "connection";
  entityId?: string;
  entityName?: string;
  entityKind?: string;
  section?: string;
};

type SourceFileGroup = {
  label: string;
  files: SourceFileSummary[];
};

type NewAssetKind = "world" | "scenario" | "agent" | "affiliation" | "artifact" | "stateless" | "connection" | "format" | "model";

type SourceSpan = {
  file: string;
  line: number;
  quote: string;
};

type DiagnosticRecord = {
  severity: "warning" | "error";
  code: string;
  message: string;
  sourceSpans?: SourceSpan[];
};

type ModelRecord = {
  id: string;
  name: string;
};

const route = useRoute();
const config = useRuntimeConfig();
const toast = useToast();

const apiBase = ref(config.public.apiBase);
const workspacePath = ref(String(route.query.workspace || "workspaces/demo"));
const sourceFiles = ref<SourceFileSummary[]>([]);
const selectedSourcePath = ref("");
const sourceText = ref("");
const savedSourceText = ref("");
const sourceFilter = ref("");
const compileDiagnostics = ref<DiagnosticRecord[]>([]);
const validatedOnce = ref(false);
const models = ref<ModelRecord[]>([]);
const loading = ref(false);
const loadingSource = ref(false);
const savingSource = ref(false);
const newAssetKind = ref<NewAssetKind>("agent");
const newAssetId = ref("");
const newAssetName = ref("");

const newAssetKindItems = [
  { label: "Agent", value: "agent" },
  { label: "Affiliation", value: "affiliation" },
  { label: "Artifact", value: "artifact" },
  { label: "Stateless", value: "stateless" },
  { label: "World", value: "world" },
  { label: "Scenario", value: "scenario" },
  { label: "Connection", value: "connection" },
  { label: "Format", value: "format" },
  { label: "Model", value: "model" }
];

const studioTags = [":canonical", ":hidden", ":+3", ":+1", ":0", ":-1", ":-3", ":surface:in_person", ":access:member"];

const newAssetKindLabel = computed(() => {
  return newAssetKindItems.find((item) => item.value === newAssetKind.value)?.label || "Asset";
});
const normalizedNewAssetId = computed(() => slugifyId(newAssetId.value));
const canCreateSourceAsset = computed(() => Boolean(normalizedNewAssetId.value));
const canSaveSourceFile = computed(() => Boolean(selectedSourcePath.value && sourceText.value !== savedSourceText.value));
const validationStatus = computed(() => {
  if (!validatedOnce.value) return "Not run";
  return compileDiagnostics.value.some((diagnostic) => diagnostic.severity === "error") ? "Errors" : "Ready";
});
const validationEmptyText = computed(() => validatedOnce.value ? "No validation issues found." : "Validation has not run yet.");
const sourceEditorState = computed(() => {
  if (!selectedSourcePath.value) return "Select a file or create a new source asset.";
  return canSaveSourceFile.value ? "Unsaved changes" : "Saved";
});

const filteredSourceFiles = computed(() => {
  const query = sourceFilter.value.trim().toLowerCase();
  if (!query) return sourceFiles.value;
  return sourceFiles.value.filter((file) => {
    return [file.path, file.id, file.name, file.kind, file.entityId || "", file.entityName || "", file.entityKind || "", file.section || ""]
      .some((value) => value.toLowerCase().includes(query));
  });
});

const groupedSourceFiles = computed<SourceFileGroup[]>(() => {
  const groups: SourceFileGroup[] = [
    { label: "Entities", files: [] },
    { label: "Connections", files: [] },
    { label: "Worlds", files: [] },
    { label: "Scenarios", files: [] },
    { label: "Formats", files: [] },
    { label: "Models", files: [] }
  ];
  const byKind = new Map([
    ["entity-file", groups[0]],
    ["connection", groups[1]],
    ["world", groups[2]],
    ["scenario", groups[3]],
    ["format", groups[4]],
    ["model", groups[5]]
  ]);
  for (const file of filteredSourceFiles.value) byKind.get(file.kind)?.files.push(file);
  return groups.filter((group) => group.files.length > 0);
});

const selectedSourceFile = computed(() => sourceFiles.value.find((file) => file.path === selectedSourcePath.value) || null);
const selectedSourceHelp = computed(() => sourceHelp(selectedSourceFile.value));

onMounted(() => {
  rememberWorkspace(workspacePath.value);
  refreshSourceFiles();
});

async function api<TValue>(path: string, options: { method?: string; body?: Record<string, unknown> } = {}): Promise<TValue> {
  return await $fetch<TValue>(`${apiBase.value}${path}`, {
    method: options.method || "GET",
    body: options.body
  });
}

function updateRoute(): void {
  navigateTo({ path: "/studio", query: { workspace: workspacePath.value } }, { replace: true });
  rememberWorkspace(workspacePath.value);
}

async function refreshSourceFiles(): Promise<void> {
  if (!confirmDiscardSourceChanges()) return;
  loadingSource.value = true;
  try {
    const result = await api<{ files: SourceFileSummary[] }>(`/source?workspacePath=${encodeURIComponent(workspacePath.value)}`);
    sourceFiles.value = result.files;
    rememberWorkspace(workspacePath.value);
    if (selectedSourcePath.value && !sourceFiles.value.some((file) => file.path === selectedSourcePath.value)) {
      selectedSourcePath.value = "";
      sourceText.value = "";
      savedSourceText.value = "";
    }
    if (!selectedSourcePath.value && sourceFiles.value.length > 0) {
      await openSourceFile(sourceFiles.value.at(0)?.path || "");
    }
  } catch (error) {
    showError(error);
  } finally {
    loadingSource.value = false;
  }
}

async function openSourceFile(path: string): Promise<void> {
  if (!path || (path !== selectedSourcePath.value && !confirmDiscardSourceChanges())) return;
  try {
    const result = await api<{ path: string; text: string }>(
      `/source/file?workspacePath=${encodeURIComponent(workspacePath.value)}&path=${encodeURIComponent(path)}`
    );
    selectedSourcePath.value = result.path;
    sourceText.value = result.text;
    savedSourceText.value = result.text;
  } catch (error) {
    showError(error);
  }
}

async function saveSourceFile(): Promise<void> {
  if (!canSaveSourceFile.value) return;
  savingSource.value = true;
  try {
    const result = await api<{ path: string; text: string }>("/source/file", {
      method: "POST",
      body: {
        workspacePath: workspacePath.value,
        path: selectedSourcePath.value,
        text: sourceText.value
      }
    });
    selectedSourcePath.value = result.path;
    sourceText.value = result.text;
    savedSourceText.value = result.text;
    await refreshSourceFiles();
    toast.add({ title: "Source file saved", color: "success" });
  } catch (error) {
    showError(error);
  } finally {
    savingSource.value = false;
  }
}

async function createSourceAsset(): Promise<void> {
  if (!canCreateSourceAsset.value || !confirmDiscardSourceChanges()) return;
  const id = normalizedNewAssetId.value;
  const name = newAssetName.value.trim() || titleFromId(id);
  const path = sourcePathForNewAsset(newAssetKind.value, id);
  const text = sourceTemplate(newAssetKind.value, id, name);
  savingSource.value = true;
  try {
    await api("/source/file", {
      method: "POST",
      body: { workspacePath: workspacePath.value, path, text }
    });
    newAssetId.value = "";
    newAssetName.value = "";
    await refreshSourceFiles();
    await openSourceFile(path);
    toast.add({ title: "Source file created", color: "success" });
  } catch (error) {
    showError(error);
  } finally {
    savingSource.value = false;
  }
}

async function validateWorkspace(): Promise<void> {
  loading.value = true;
  try {
    const compiled = await api<{ diagnostics: DiagnosticRecord[]; models: ModelRecord[] }>("/source/compile", {
      method: "POST",
      body: { workspacePath: workspacePath.value }
    });
    compileDiagnostics.value = compiled.diagnostics;
    models.value = compiled.models || [];
    validatedOnce.value = true;
    await refreshSourceFiles();
    toast.add({
      title: compileDiagnostics.value.some((diagnostic) => diagnostic.severity === "error") ? "Validation found errors" : "Source validated",
      color: compileDiagnostics.value.some((diagnostic) => diagnostic.severity === "error") ? "warning" : "success"
    });
  } catch (error) {
    showError(error);
  } finally {
    loading.value = false;
  }
}

function sourceFileLabel(file: SourceFileSummary): string {
  if (file.kind === "entity-file") return `${file.entityName || file.entityId} / ${file.section}`;
  return file.id;
}

function sourceKindLabel(file: SourceFileSummary): string {
  if (file.kind === "entity-file") return file.entityKind || "entity";
  return file.kind;
}

function diagnosticKey(diagnostic: DiagnosticRecord): string {
  const span = diagnostic.sourceSpans?.at(0);
  return `${diagnostic.severity}:${diagnostic.code}:${span?.file || ""}:${span?.line || ""}:${diagnostic.message}`;
}

function confirmDiscardSourceChanges(): boolean {
  if (!canSaveSourceFile.value) return true;
  return window.confirm("Discard unsaved source changes?");
}

function sourceHelp(file: SourceFileSummary | null): { title: string; lines: string[] } {
  if (!file) {
    return {
      title: "Workspace",
      lines: [
        "A workspace is the local source folder for one Doxvelt project.",
        "It contains models, worlds, scenarios, formats, entities, and connections.",
        "Worlds are assets inside a workspace, not the workspace itself."
      ]
    };
  }
  if (file.kind === "world") return { title: "World", lines: ["Worlds define objective laws, norms, genre rules, and constraints.", "Subjective disagreement belongs in entities and connections."] };
  if (file.kind === "scenario") return { title: "Scenario", lines: ["Scenarios define the objective starting situation.", "Use scenarios for what is true at the opening beat."] };
  if (file.kind === "connection") return { title: "Connection", lines: ["Connections describe relationships, memberships, rivalries, ownership, and access.", "Membership-like access uses :access:member."] };
  if (file.kind === "entity-file") return { title: file.entityKind ? `${titleFromId(file.entityKind)} Entity` : "Entity", lines: ["Entities are agents, affiliations, artifacts, or stateless actors.", "Identity anchors the entity. Beliefs, surfaces, memories, and examples shape subjective turns."] };
  if (file.kind === "format") return { title: "Format", lines: ["Formats describe how actor turns should be written.", "They are prompt instructions for generated or manual turns."] };
  return { title: "Model", lines: ["Models point Doxvelt at a local or hosted generation endpoint.", "Keep secret values in environment variables, not workspace source."] };
}

function sourcePathForNewAsset(kind: NewAssetKind, id: string): string {
  if (kind === "agent" || kind === "affiliation" || kind === "artifact" || kind === "stateless") return `entities/${id}/IDENTITY.md`;
  if (kind === "world") return `worlds/${id}.md`;
  if (kind === "scenario") return `scenarios/${id}.md`;
  if (kind === "connection") return `connections/${id}.md`;
  if (kind === "format") return `formats/${id}.md`;
  return `models/${id}.yaml`;
}

function sourceTemplate(kind: NewAssetKind, id: string, name: string): string {
  if (kind === "agent" || kind === "affiliation" || kind === "artifact" || kind === "stateless") {
    return `---\nid: ${id}\nkind: ${kind}\nname: ${name}\nvisibility: public\n---\n\n@${id} is ready for authoring.\n`;
  }
  if (kind === "world") return `---\nid: ${id}\nname: ${name}\n---\n\nDescribe objective laws, norms, genre rules, or training constraints for this world. :canonical\n`;
  if (kind === "scenario") return `---\nid: ${id}\nname: ${name}\n---\n\nDescribe the objective starting situation for this simulation. :canonical\n`;
  if (kind === "connection") return `---\nid: ${id}\nkind: connection\nentities: []\n---\n\nDescribe the relationship, membership, access link, rivalry, ownership, or other authored connection.\n`;
  if (kind === "format") return `---\nid: ${id}\nname: ${name}\n---\n\nDescribe how actors should answer during turns.\n`;
  return `---\nid: ${id}\nprovider: openai-compatible\nbase_url: http://localhost:11434/v1\nmodel: replace-with-model-name\napi_key_env: OLLAMA_API_KEY\n---\n`;
}

function slugifyId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleFromId(id: string): string {
  return id.split(/[-_]/).filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ");
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
