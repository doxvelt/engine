<template>
  <div class="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] gap-0">
    <aside class="dx-left-panel flex min-h-0 flex-col gap-5 overflow-visible border-r p-4">
      <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-3 p-0 sm:p-0' }">
        <div class="flex items-center justify-between gap-2">
          <h2 class="dx-label">Source Workspace</h2>
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

      <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-3 p-0 sm:p-0' }">
        <div class="flex items-center justify-between gap-2">
          <h2 class="dx-label">Create</h2>
          <UBadge color="neutral" variant="soft" size="sm">{{ newAssetKindLabel }}</UBadge>
        </div>
        <USelect v-model="newAssetKind" :items="newAssetKindItems" icon="i-lucide-layers" size="sm" class="w-full" />
        <UInput v-model="newAssetId" icon="i-lucide-at-sign" size="sm" placeholder="stable-id" class="w-full" />
        <UInput v-model="newAssetName" icon="i-lucide-type" size="sm" placeholder="Display name" class="w-full" />
        <UButton icon="i-lucide-plus" color="primary" variant="solid" size="sm" block :disabled="!canCreateSourceAsset" @click="createSourceAsset">
          Create source file
        </UButton>
      </UCard>

      <UCard :ui="{ root: 'dx-tool-panel flex min-h-0 flex-1 flex-col rounded-none', body: 'flex min-h-0 flex-1 flex-col space-y-2 p-0 sm:p-0' }">
        <div class="flex items-center justify-between gap-2">
          <h2 class="dx-label">Files</h2>
          <UInput v-model="sourceFilter" icon="i-lucide-search" size="xs" placeholder="Filter" class="w-full max-w-36" />
        </div>
        <div class="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
          <section v-for="group in groupedSourceFiles" :key="group.label" class="space-y-1">
            <div class="flex items-center justify-between px-1">
              <h3 class="dx-label text-[11px]">{{ group.label }}</h3>
              <UBadge color="neutral" variant="soft" size="sm">{{ group.files.length }}</UBadge>
            </div>
            <button
              v-for="file in group.files"
              :key="file.path"
              class="dx-tile grid w-full grid-cols-[1fr_auto] gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition"
              :class="file.path === selectedSourcePath ? 'is-selected' : ''"
              @click="openSourceFile(file.path, { clearCue: true })"
            >
              <span class="min-w-0 truncate">{{ sourceFileLabel(file) }}</span>
              <span class="dx-subtle text-xs">{{ sourceKindLabel(file) }}</span>
              <span class="dx-subtle col-span-2 min-w-0 truncate text-xs">{{ file.path }}</span>
            </button>
          </section>
          <div v-if="filteredSourceFiles.length === 0" class="rounded-sm bg-muted p-3 text-sm text-muted">
            No source files found. Go home to create a blank workspace or initialize the demo.
          </div>
        </div>
      </UCard>
    </aside>

    <section class="dx-workspace flex min-h-0 flex-col">
      <div class="flex h-14 shrink-0 items-center justify-between px-3 sm:px-4">
        <div class="min-w-0">
          <h2 class="truncate text-base font-semibold">{{ selectedSourcePath || "Studio" }}</h2>
          <p class="text-sm text-muted">{{ sourceEditorState }}</p>
        </div>
        <UButton icon="i-lucide-save" color="primary" variant="solid" size="sm" :disabled="!canSaveSourceFile" :loading="savingSource" @click="saveSourceFile">
          Save
        </UButton>
      </div>
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-0">
        <div ref="sourceEditorContainer" class="dx-canvas min-h-0 p-3">
          <div v-if="targetSourceSpan" class="dx-source-note mb-2 rounded-sm border p-2 text-xs">
            <div class="mb-1 flex items-center justify-between gap-2">
              <span class="font-semibold">Line {{ targetSourceSpan.line }}</span>
              <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" square @click="clearSourceLineCue" />
            </div>
            <p class="line-clamp-2 leading-5">{{ targetSourceSpan.quote }}</p>
          </div>
          <UTextarea
            v-model="sourceText"
            :rows="28"
            autoresize
            class="h-full w-full"
            placeholder="Select or create a source file to author natural-language Doxvelt material."
            :ui="{ root: 'h-full w-full', base: 'dx-source-editor-input h-full min-h-[calc(100dvh-9.5rem)] w-full font-mono text-[13px] leading-5' }"
          />
        </div>
        <aside class="dx-plain-panel min-h-0 overflow-y-auto border-l p-4">
          <UTabs v-model="inspectorTab" :items="inspectorTabs" size="sm" class="mb-3" />
          <div v-if="inspectorTab === 'guide'" class="space-y-3">
            <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-2 p-0 sm:p-0' }">
              <h3 class="dx-label">{{ selectedSourceHelp.title }}</h3>
              <div class="space-y-2 text-sm text-default">
                <p v-for="line in selectedSourceHelp.lines" :key="line">{{ line }}</p>
              </div>
            </UCard>
            <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-2 p-0 sm:p-0' }">
              <h3 class="dx-label">Line Tags</h3>
              <div class="flex flex-wrap gap-1.5">
                <UBadge v-for="tag in studioTags" :key="tag" color="neutral" variant="soft" size="sm">{{ tag }}</UBadge>
              </div>
            </UCard>
          </div>
          <div v-else class="space-y-3">
            <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-3 p-0 sm:p-0' }">
              <div class="flex items-center justify-between gap-2">
                <h3 class="dx-label">Source Health</h3>
                <UBadge :color="validationBadgeColor" variant="subtle" size="sm">{{ validationStatus }}</UBadge>
              </div>
              <USelect v-model="fabricScope" :items="fabricScopeItems" icon="i-lucide-filter" size="sm" class="w-full" />
              <USelect
                v-if="fabricScope === 'entity'"
                v-model="selectedFabricEntityId"
                :items="fabricEntityItems"
                icon="i-lucide-user-round"
                size="sm"
                class="w-full"
                placeholder="Select entity"
              />
              <div class="grid grid-cols-3 gap-2 text-sm">
                <div v-for="metric in fabricMetrics" :key="metric.label" class="dx-tile rounded-sm p-2">
                  <p class="dx-label text-[10px]">{{ metric.label }}</p>
                  <p class="font-medium">{{ metric.value }}</p>
                </div>
              </div>
              <p v-if="validationStale" class="dx-warning-note rounded-sm p-2 text-xs leading-5">
                Source changed since the last validation. Validate again to refresh the compiled fabric.
              </p>
              <div class="max-h-56 space-y-2 overflow-auto pr-1">
                <button
                  v-for="diagnostic in scopedDiagnostics"
                  :key="diagnosticKey(diagnostic)"
                  class="w-full rounded-sm border p-2 text-left text-xs transition"
                  :class="diagnostic.severity === 'error' ? 'dx-error-note' : 'dx-warning-note'"
                  @click="openFirstSourceSpan(diagnostic.sourceSpans)"
                >
                  <div class="mb-1 flex items-center justify-between gap-2">
                    <span class="font-semibold">{{ diagnostic.code }}</span>
                    <UBadge :color="diagnostic.severity === 'error' ? 'error' : 'warning'" variant="subtle" size="sm">
                      {{ diagnostic.severity }}
                    </UBadge>
                  </div>
                  <p class="leading-5">{{ diagnostic.message }}</p>
                  <p class="mt-1 leading-5 opacity-80">{{ diagnosticHint(diagnostic) }}</p>
                  <p v-if="diagnostic.sourceSpans?.length" class="mt-1 truncate text-[11px] opacity-75">
                    {{ diagnostic.sourceSpans[0]?.file }}:{{ diagnostic.sourceSpans[0]?.line }}
                  </p>
                </button>
                <p v-if="scopedDiagnostics.length === 0" class="text-sm text-muted">{{ validationEmptyText }}</p>
              </div>
            </UCard>

            <UCard :ui="{ root: 'dx-tool-panel rounded-none', body: 'space-y-3 p-0 sm:p-0' }">
              <div class="flex items-center justify-between gap-2">
                <h3 class="dx-label">Compiled Fabric</h3>
                <UButton icon="i-lucide-file-check-2" color="neutral" variant="ghost" size="xs" :loading="loading" @click="validateWorkspace">
                  Validate
                </UButton>
              </div>
              <p v-if="compiledWorkspace && fabricScopeSummary" class="dx-tile rounded-sm p-2 text-xs leading-5">
                {{ fabricScopeSummary }}
              </p>
              <p v-if="!compiledWorkspace" class="text-sm leading-6 text-muted">
                Validate the workspace to inspect what Doxvelt compiled from the source prose.
              </p>
              <div v-else class="space-y-3">
                <section class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <h4 class="dx-label">Entities</h4>
                    <UBadge color="neutral" variant="soft" size="sm">{{ scopedEntities.length }}</UBadge>
                  </div>
                  <div class="max-h-48 space-y-1 overflow-auto pr-1">
                    <button
                      v-for="entity in scopedEntities"
                      :key="entity.id"
                      class="dx-tile grid w-full grid-cols-[1fr_auto] gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition"
                      @click="openSourceFile(entity.files[0] || '', { clearCue: true })"
                    >
                      <span class="truncate font-medium">{{ entity.name || entity.id }}</span>
                      <UBadge color="neutral" variant="soft" size="sm">{{ entity.kind }}</UBadge>
                      <span class="dx-subtle col-span-2 truncate text-xs">@{{ entity.id }}</span>
                    </button>
                    <p v-if="scopedEntities.length === 0" class="text-sm text-muted">No entities in this scope.</p>
                  </div>
                </section>

                <section class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <h4 class="dx-label">Beliefs</h4>
                    <UBadge color="neutral" variant="soft" size="sm">{{ scopedBeliefs.length }}</UBadge>
                  </div>
                  <div class="max-h-56 space-y-1 overflow-auto pr-1">
                    <button
                      v-for="belief in scopedBeliefs"
                      :key="beliefKey(belief)"
                      class="dx-tile w-full rounded-sm p-2 text-left text-xs transition"
                      @click="openSourceSpan(belief.sourceSpan)"
                    >
                      <div class="mb-1 flex items-center justify-between gap-2">
                        <span class="font-semibold">@{{ belief.holder }}</span>
                        <UBadge :color="strengthColor(belief.strength)" variant="subtle" size="sm">{{ strengthLabel(belief.strength) }}</UBadge>
                      </div>
                      <p class="leading-5 text-default">{{ belief.propositionText }}</p>
                      <p class="dx-subtle mt-1 truncate text-[11px]">{{ belief.sourceSpan.file }}:{{ belief.sourceSpan.line }}</p>
                    </button>
                    <p v-if="scopedBeliefs.length === 0" class="text-sm text-muted">No tagged beliefs in this scope.</p>
                  </div>
                </section>

                <section class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <h4 class="dx-label">Access Links</h4>
                    <UBadge color="neutral" variant="soft" size="sm">{{ scopedAccessLinks.length }}</UBadge>
                  </div>
                  <div class="max-h-40 space-y-1 overflow-auto pr-1">
                    <button
                      v-for="link in scopedAccessLinks"
                      :key="accessLinkKey(link)"
                      class="dx-tile w-full rounded-sm p-2 text-left text-xs transition"
                      @click="openSourceSpan(link.sourceSpan)"
                    >
                      <span class="font-medium">@{{ link.member }}</span>
                      <span class="text-muted"> has member access to </span>
                      <span class="font-medium">@{{ link.container }}</span>
                      <p class="dx-subtle mt-1 truncate text-[11px]">{{ link.sourceSpan.file }}:{{ link.sourceSpan.line }}</p>
                    </button>
                    <p v-if="scopedAccessLinks.length === 0" class="text-sm text-muted">No membership access links in this scope.</p>
                  </div>
                </section>

                <section class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <h4 class="dx-label">Surfaces</h4>
                    <UBadge color="neutral" variant="soft" size="sm">{{ scopedSurfaces.length }}</UBadge>
                  </div>
                  <div class="max-h-40 space-y-1 overflow-auto pr-1">
                    <button
                      v-for="surface in scopedSurfaces"
                      :key="surfaceKey(surface)"
                      class="dx-tile w-full rounded-sm p-2 text-left text-xs transition"
                      @click="openSourceSpan(surface.sourceSpan)"
                    >
                      <div class="mb-1 flex flex-wrap items-center gap-1.5">
                        <span class="font-semibold">@{{ surface.entity }}</span>
                        <UBadge v-for="channel in surface.channels" :key="channel" color="neutral" variant="soft" size="sm">{{ channel }}</UBadge>
                      </div>
                      <p class="leading-5 text-default">{{ surface.text }}</p>
                    </button>
                    <p v-if="scopedSurfaces.length === 0" class="text-sm text-muted">No projected surfaces in this scope.</p>
                  </div>
                </section>
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

type FabricScope = "workspace" | "file" | "entity";

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

type AssetRecord = {
  id: string;
  kind: "model" | "world" | "scenario" | "format" | "connection";
  name: string;
  path: string;
};

type EntityRecord = {
  id: string;
  kind: "agent" | "affiliation" | "artifact" | "stateless";
  name: string;
  visibility: string;
  folder: string;
  files: string[];
};

type BeliefRecord = {
  holder: string;
  strength: number;
  propositionText: string;
  mentions: string[];
  sourceSpan: SourceSpan;
};

type SurfaceRecord = {
  entity: string;
  channels: string[];
  text: string;
  sourceSpan: SourceSpan;
};

type AccessLinkRecord = {
  member: string;
  container: string;
  mode: "member";
  sourceSpan: SourceSpan;
};

type TaggedLineRecord = {
  tags: string[];
  mentions: string[];
  context?: { holder?: string; section?: string; connectionId?: string };
  sourceSpan: SourceSpan;
};

type CompiledWorkspace = {
  sourceRoot: string;
  models: AssetRecord[];
  worlds: AssetRecord[];
  scenarios: AssetRecord[];
  formats: AssetRecord[];
  entities: EntityRecord[];
  connections: AssetRecord[];
  taggedLines: TaggedLineRecord[];
  beliefs: BeliefRecord[];
  surfaces: SurfaceRecord[];
  accessLinks: AccessLinkRecord[];
  diagnostics: DiagnosticRecord[];
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
const compiledWorkspace = ref<CompiledWorkspace | null>(null);
const validatedOnce = ref(false);
const validationStale = ref(false);
const models = ref<ModelRecord[]>([]);
const loading = ref(false);
const loadingSource = ref(false);
const savingSource = ref(false);
const newAssetKind = ref<NewAssetKind>("agent");
const newAssetId = ref("");
const newAssetName = ref("");
const inspectorTab = ref("fabric");
const fabricScope = ref<FabricScope>("workspace");
const selectedFabricEntityId = ref("");
const targetSourceSpan = ref<SourceSpan | null>(null);
const sourceEditorContainer = ref<HTMLElement | null>(null);

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
const inspectorTabs = [
  { label: "Fabric", value: "fabric", icon: "i-lucide-git-fork" },
  { label: "Guide", value: "guide", icon: "i-lucide-book-open" }
];
const fabricScopeItems = [
  { label: "Whole workspace", value: "workspace" },
  { label: "Selected file", value: "file" },
  { label: "Selected entity", value: "entity" }
];

const newAssetKindLabel = computed(() => {
  return newAssetKindItems.find((item) => item.value === newAssetKind.value)?.label || "Asset";
});
const normalizedNewAssetId = computed(() => slugifyId(newAssetId.value));
const canCreateSourceAsset = computed(() => Boolean(normalizedNewAssetId.value));
const canSaveSourceFile = computed(() => Boolean(selectedSourcePath.value && sourceText.value !== savedSourceText.value));
const validationStatus = computed(() => {
  if (!validatedOnce.value) return "Not run";
  if (validationStale.value) return "Stale";
  return compileDiagnostics.value.some((diagnostic) => diagnostic.severity === "error") ? "Errors" : "Ready";
});
const validationBadgeColor = computed<"neutral" | "warning" | "error" | "success">(() => {
  if (!validatedOnce.value) return "neutral";
  if (validationStale.value) return "warning";
  return compileDiagnostics.value.some((diagnostic) => diagnostic.severity === "error") ? "error" : "success";
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
const fabricEntityItems = computed(() => {
  return (compiledWorkspace.value?.entities || []).map((entity) => ({
    label: entity.name || entity.id,
    value: entity.id
  }));
});
const effectiveFabricEntityId = computed(() => {
  if (fabricScope.value !== "entity") return "";
  return selectedFabricEntityId.value || selectedSourceFile.value?.entityId || compiledWorkspace.value?.entities.at(0)?.id || "";
});
const selectedFabricEntity = computed(() => {
  return compiledWorkspace.value?.entities.find((entity) => entity.id === effectiveFabricEntityId.value) || null;
});
const scopeFilePath = computed(() => fabricScope.value === "file" ? selectedSourcePath.value : "");
const scopedEntities = computed(() => {
  const entities = compiledWorkspace.value?.entities || [];
  if (effectiveFabricEntityId.value) return entities.filter((entity) => entity.id === effectiveFabricEntityId.value);
  if (!scopeFilePath.value) return entities;
  return entities.filter((entity) => entity.files.includes(scopeFilePath.value));
});
const scopedBeliefs = computed(() => {
  const beliefs = compiledWorkspace.value?.beliefs || [];
  if (effectiveFabricEntityId.value) return beliefs.filter((belief) => belief.holder === effectiveFabricEntityId.value || belief.mentions.includes(effectiveFabricEntityId.value));
  if (!scopeFilePath.value) return beliefs;
  return beliefs.filter((belief) => belief.sourceSpan.file === scopeFilePath.value);
});
const scopedAccessLinks = computed(() => {
  const links = compiledWorkspace.value?.accessLinks || [];
  if (effectiveFabricEntityId.value) return links.filter((link) => link.member === effectiveFabricEntityId.value || link.container === effectiveFabricEntityId.value);
  if (!scopeFilePath.value) return links;
  return links.filter((link) => link.sourceSpan.file === scopeFilePath.value);
});
const scopedSurfaces = computed(() => {
  const surfaces = compiledWorkspace.value?.surfaces || [];
  if (effectiveFabricEntityId.value) return surfaces.filter((surface) => surface.entity === effectiveFabricEntityId.value);
  if (!scopeFilePath.value) return surfaces;
  return surfaces.filter((surface) => surface.sourceSpan.file === scopeFilePath.value);
});
const scopedTaggedLines = computed(() => {
  const taggedLines = compiledWorkspace.value?.taggedLines || [];
  if (effectiveFabricEntityId.value) {
    return taggedLines.filter((line) => {
      return line.mentions.includes(effectiveFabricEntityId.value) || line.context?.holder === effectiveFabricEntityId.value;
    });
  }
  if (!scopeFilePath.value) return taggedLines;
  return taggedLines.filter((line) => line.sourceSpan.file === scopeFilePath.value);
});
const scopedDiagnostics = computed(() => {
  if (effectiveFabricEntityId.value && selectedFabricEntity.value) {
    const entityFiles = new Set(selectedFabricEntity.value.files);
    return compileDiagnostics.value.filter((diagnostic) => {
      return diagnostic.sourceSpans?.some((span) => entityFiles.has(span.file)) || diagnostic.message.includes(effectiveFabricEntityId.value);
    });
  }
  if (!scopeFilePath.value) return compileDiagnostics.value;
  return compileDiagnostics.value.filter((diagnostic) => diagnostic.sourceSpans?.some((span) => span.file === scopeFilePath.value));
});
const scopedAssetCount = computed(() => {
  const compiled = compiledWorkspace.value;
  if (!compiled) return 0;
  const assets = [...compiled.models, ...compiled.worlds, ...compiled.scenarios, ...compiled.formats, ...compiled.connections];
  if (effectiveFabricEntityId.value) return 0;
  if (!scopeFilePath.value) return assets.length;
  return assets.filter((asset) => asset.path === scopeFilePath.value).length;
});
const fabricScopeSummary = computed(() => {
  if (!compiledWorkspace.value) return "";
  if (fabricScope.value === "file") {
    return `This file compiled into ${countPhrase(scopedBeliefs.value.length, "belief")}, ${countPhrase(scopedSurfaces.value.length, "surface")}, ${countPhrase(scopedAccessLinks.value.length, "access link")}, and ${countPhrase(scopedTaggedLines.value.length, "tagged line")}.`;
  }
  if (fabricScope.value === "entity") {
    const entity = selectedFabricEntity.value;
    const name = entity?.name || effectiveFabricEntityId.value || "Selected entity";
    return `${name} is linked to ${countPhrase(scopedBeliefs.value.length, "belief")}, ${countPhrase(scopedSurfaces.value.length, "surface")}, ${countPhrase(scopedAccessLinks.value.length, "access link")}, and ${countPhrase(scopedTaggedLines.value.length, "tagged line")}.`;
  }
  return "";
});
const fabricMetrics = computed(() => {
  return [
    { label: "Entities", value: scopedEntities.value.length },
    { label: "Beliefs", value: scopedBeliefs.value.length },
    { label: "Access", value: scopedAccessLinks.value.length },
    { label: "Surfaces", value: scopedSurfaces.value.length },
    { label: "Tags", value: scopedTaggedLines.value.length },
    { label: "Assets", value: scopedAssetCount.value }
  ];
});

onMounted(() => {
  rememberWorkspace(workspacePath.value);
  refreshSourceFiles();
});

watch(sourceText, () => {
  if (validatedOnce.value && sourceText.value !== savedSourceText.value) validationStale.value = true;
});

watch(selectedSourceFile, (file) => {
  if (fabricScope.value === "entity" && file?.entityId) selectedFabricEntityId.value = file.entityId;
});

watch(compiledWorkspace, (compiled) => {
  if (!selectedFabricEntityId.value) selectedFabricEntityId.value = compiled?.entities.at(0)?.id || "";
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

async function openSourceFile(path: string, options: { clearCue?: boolean } = {}): Promise<void> {
  if (!path || (path !== selectedSourcePath.value && !confirmDiscardSourceChanges())) return;
  try {
    const result = await api<{ path: string; text: string }>(
      `/source/file?workspacePath=${encodeURIComponent(workspacePath.value)}&path=${encodeURIComponent(path)}`
    );
    selectedSourcePath.value = result.path;
    sourceText.value = result.text;
    savedSourceText.value = result.text;
    if (options.clearCue) targetSourceSpan.value = null;
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
    validationStale.value = true;
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
    const compiled = await api<CompiledWorkspace>("/source/compile", {
      method: "POST",
      body: { workspacePath: workspacePath.value }
    });
    compiledWorkspace.value = compiled;
    compileDiagnostics.value = compiled.diagnostics;
    models.value = compiled.models || [];
    validatedOnce.value = true;
    validationStale.value = false;
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

function diagnosticHint(diagnostic: DiagnosticRecord): string {
  if (diagnostic.code === "unresolved_mention") {
    return "Create a matching entity or asset id, or correct the @mention in the source line.";
  }
  if (diagnostic.code === "entity_invalid_kind") {
    return "Use one of the supported entity kinds: agent, affiliation, artifact, or stateless.";
  }
  if (diagnostic.code === "membership_cycle" || diagnostic.code === "membership_self_loop") {
    return "Break the membership access path so no entity can reach itself through :access:member links.";
  }
  if (diagnostic.code === "model_missing_provider") {
    return "Add provider metadata such as provider: openai-compatible to the model file.";
  }
  if (diagnostic.code === "model_missing_model") {
    return "Add the concrete model name to the model file.";
  }
  if (diagnostic.code === "model_missing_base_url") {
    return "OpenAI-compatible models need base_url metadata, for example http://localhost:11434/v1.";
  }
  if (diagnostic.code === "model_invalid_base_url") {
    return "Use an http or https URL with a single scheme, host, and optional path.";
  }
  return "Open the source span and adjust the authored prose or metadata, then validate again.";
}

function beliefKey(belief: BeliefRecord): string {
  return `${belief.holder}:${belief.strength}:${belief.sourceSpan.file}:${belief.sourceSpan.line}:${belief.propositionText}`;
}

function accessLinkKey(link: AccessLinkRecord): string {
  return `${link.member}:${link.container}:${link.sourceSpan.file}:${link.sourceSpan.line}`;
}

function surfaceKey(surface: SurfaceRecord): string {
  return `${surface.entity}:${surface.sourceSpan.file}:${surface.sourceSpan.line}:${surface.text}`;
}

function strengthLabel(strength: number): string {
  if (strength >= 3) return "+3 true";
  if (strength > 0) return "+1 suspects";
  if (strength <= -3) return "-3 false";
  if (strength < 0) return "-1 doubts";
  return "0 neutral";
}

function strengthColor(strength: number): "success" | "warning" | "error" | "neutral" {
  if (strength >= 3) return "success";
  if (strength > 0) return "warning";
  if (strength < 0) return "error";
  return "neutral";
}

async function openFirstSourceSpan(spans: SourceSpan[] | undefined): Promise<void> {
  const span = spans?.at(0);
  if (span) await openSourceSpan(span);
}

async function openSourceSpan(span: SourceSpan): Promise<void> {
  await openSourceFile(span.file);
  targetSourceSpan.value = span;
  await nextTick();
  scrollSourceEditorToSpan(span);
  toast.add({
    title: "Source span opened",
    description: `${span.file}:${span.line}`,
    color: "neutral"
  });
}

function clearSourceLineCue(): void {
  targetSourceSpan.value = null;
}

function scrollSourceEditorToSpan(span: SourceSpan): void {
  const textArea = sourceEditorContainer.value?.querySelector("textarea");
  if (!textArea) return;

  const lineHeight = Number.parseFloat(getComputedStyle(textArea).lineHeight || "20") || 20;
  const normalizedText = sourceText.value.replace(/\r\n/g, "\n");
  const quoteIndex = normalizedText.indexOf(span.quote);
  const selectionStart = quoteIndex === -1 ? offsetForLine(normalizedText, span.line) : quoteIndex;
  const selectionEnd = quoteIndex === -1 ? endOfLineOffset(normalizedText, selectionStart) : quoteIndex + span.quote.length;
  const lineIndex = normalizedText.slice(0, selectionStart).split("\n").length - 1;

  textArea.scrollTop = Math.max(0, lineIndex * lineHeight - lineHeight * 4);
  textArea.focus();
  textArea.setSelectionRange(selectionStart, selectionEnd);
}

function offsetForLine(text: string, line: number): number {
  return text.split("\n").slice(0, Math.max(0, line - 1)).reduce((offset, value) => offset + value.length + 1, 0);
}

function endOfLineOffset(text: string, start: number): number {
  const nextNewline = text.indexOf("\n", start);
  return nextNewline === -1 ? text.length : nextNewline;
}

function countPhrase(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
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
