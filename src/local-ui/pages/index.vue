<template>
  <div class="dx-home min-h-0 flex-1 overflow-y-auto">
    <div class="dx-home-container">
      <section class="py-8" aria-label="Saved simulations" :aria-busy="collection.status === 'loading'">
        <h1 class="dx-section-title">Your simulations</h1>
        <p v-if="collection.status === 'loading'" role="status" class="mt-4 text-sm text-muted">Loading saved simulations…</p>
        <UAlert v-else-if="collection.status === 'error'" role="alert" class="mt-4" color="error" title="Could not load saved simulations" :description="collection.error">
          <template #actions><UButton color="neutral" variant="subtle" @click="collection.load(apiBase)">Retry</UButton></template>
        </UAlert>
        <template v-else>
          <p v-if="collection.items.length === 0" class="mt-4 text-sm text-muted">No saved simulations yet. Play the example or create your own below.</p>
          <div v-else class="mt-4 grid gap-4 md:grid-cols-2">
            <UCard v-for="(item, index) in collection.items" :key="item.simulationId" :ui="{ root: index === 0 ? 'dx-light-card shadow-none md:col-span-2' : 'dx-action-card shadow-none' }">
              <p v-if="index === 0" class="dx-label mb-2">{{ item.openedAt ? 'Last opened' : 'Recently created' }}</p>
              <h2 class="text-lg font-semibold break-words">{{ item.scenarioName || item.simulationId }}</h2>
              <p class="mt-1 text-xs text-muted break-all">{{ item.simulationId }}</p>
              <p class="mt-2 text-xs text-muted">{{ item.openedAt ? 'Opened' : 'Created' }} <time :datetime="item.openedAt || item.createdAt">{{ displayDate(item.openedAt || item.createdAt) }}</time></p>
              <UButton class="mt-4" :color="index === 0 ? 'primary' : 'neutral'" :variant="index === 0 ? 'solid' : 'subtle'" :to="collection.target(item)" :aria-label="`Continue ${item.scenarioName || item.simulationId} (${item.simulationId})`">Continue</UButton>
            </UCard>
          </div>
        </template>
      </section>
      <section class="dx-home-intro">
        <div>
          <h2 class="dx-section-title">The last crossing</h2>
          <div class="mt-4 grid gap-3">
            <p class="text-sm text-muted">The last ferry before a storm. A captain, a quay keeper, and a late passenger with a sealed letter. Choose who speaks next.</p>
            <div>
              <UButton icon="i-lucide-theater" color="primary" size="lg" :loading="example.busy" :disabled="example.busy" @click="playExample">
                Play the example
              </UButton>
            </div>
            <p class="text-sm text-muted">Starts a scene or continues your saved example.</p>
            <p v-if="example.error" role="alert" class="dx-error-note rounded-sm p-3 text-sm">{{ example.error }} Try Play the example again.</p>
          </div>
        </div>

        <aside class="dx-light-card p-6">
          <h2 class="dx-section-title">Create your own</h2>
          <p class="mt-2 text-sm text-muted">Start a blank workspace, then author your world and actors in Studio.</p>
          <UFormField label="Workspace path" class="mt-4">
            <UInput v-model="blankWorkspacePath" icon="i-lucide-folder-plus" class="w-full" />
          </UFormField>
          <UButton class="mt-4" icon="i-lucide-file-plus-2" color="neutral" variant="subtle" :disabled="!blankWorkspacePath.trim() || busyAction !== null" :loading="busyAction === 'blank'" @click="createBlankWorkspace">Create your own</UButton>
        </aside>
      </section>

      <section v-if="recentWorkspaces.length > 0" class="py-8">
        <div class="dx-section-heading">
          <div>
            <h2 class="dx-section-title">Browser workspaces</h2>
            <p class="mt-1 text-sm text-muted">Source workspace shortcuts stored in this browser.</p>
          </div>
          <UButton icon="i-lucide-list-x" color="neutral" variant="ghost" size="sm" @click="clearRecent">
            Clear
          </UButton>
        </div>

        <div class="grid gap-3">
          <UCard
            v-for="workspace in recentWorkspaces"
            :key="workspace"
            :ui="{ root: 'dx-action-card shadow-none', body: 'grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-4' }"
          >
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">{{ workspaceName(workspace) }}</p>
              <p class="mt-1 truncate text-xs text-muted">{{ workspace }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UButton icon="i-lucide-pencil-ruler" color="neutral" variant="subtle" size="sm" @click="openExisting(workspace, '/studio')">
                Studio
              </UButton>
              <UButton icon="i-lucide-theater" color="neutral" variant="subtle" size="sm" @click="openExisting(workspace, '/stage')">
                Stage
              </UButton>
              <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" square aria-label="Remove recent workspace" @click="removeRecent(workspace)" />
              <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" square aria-label="Delete workspace from disk" :loading="deletingWorkspace === workspace" @click="deleteWorkspace(workspace)" />
            </div>
          </UCard>
        </div>
      </section>

      <section class="py-8">
        <div class="dx-section-heading">
          <div>
            <h2 class="dx-section-title">Workspace tools</h2>
            <p class="mt-1 text-sm text-muted">Open a source workspace or inspect the authoring demo.</p>
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <aside class="dx-light-card p-6">
            <h2 class="dx-label">Open Existing</h2>
            <div class="mt-4 grid gap-3">
              <UInput aria-label="Existing workspace path" v-model="openWorkspacePath" icon="i-lucide-folder-open" size="md" class="w-full" placeholder="workspaces/my-simulation" />
              <div class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <UButton icon="i-lucide-pencil-ruler" color="primary" variant="solid" size="md" block :disabled="!openWorkspacePath.trim()" @click="openWorkspace('/studio')">
                  Open Studio
                </UButton>
                <UButton icon="i-lucide-theater" color="neutral" variant="subtle" size="md" block :disabled="!openWorkspacePath.trim()" @click="openWorkspace('/stage')">
                  Open Stage
                </UButton>
                <UButton
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="ghost"
                  size="md"
                  square
                  aria-label="Delete typed workspace from disk"
                  :disabled="!openWorkspacePath.trim()"
                  :loading="deletingWorkspace === openWorkspacePath.trim()"
                  @click="deleteWorkspace(openWorkspacePath.trim())"
                />
              </div>
            </div>
          </aside>

          <UPageCard
            icon="i-lucide-sparkles"
            title="Inspect Executive Interviews"
            description="Create an executive-interviews workspace for authoring and inspection in Studio."
            :ui="{ root: 'dx-action-card', body: 'gap-4' }"
          >
            <UInput aria-label="Demo workspace path" v-model="demoWorkspacePath" icon="i-lucide-folder-symlink" size="sm" class="w-full" />
            <UButton icon="i-lucide-sparkles" color="neutral" variant="subtle" size="sm" block :disabled="!demoWorkspacePath.trim()" :loading="busyAction === 'demo'" @click="initDemoWorkspace">
              {{ demoButtonLabel }}
            </UButton>
          </UPageCard>
        </div>
      </section>

      <section v-if="recentWorkspaces.length === 0" class="pb-12 pt-8">
        <div class="dx-section-heading">
          <div>
            <h2 class="dx-section-title">Browser workspaces</h2>
            <p class="mt-1 text-sm text-muted">This browser's workspace history will appear here after you open or create one.</p>
          </div>
        </div>

        <div class="rounded-md border border-dashed border-muted bg-default p-8 text-center">
          <p class="text-sm font-medium text-default">No browser workspaces yet.</p>
          <p class="mt-1 text-sm text-muted">Workspaces you open here will appear as shortcuts in this browser.</p>
        </div>
      </section>

      <UModal
        v-model:open="deleteModalOpen"
        title="Delete Workspace"
        description="This removes the source folder from disk. Browser shortcut removal is still available with the x button."
        :dismissible="!deletingWorkspace"
      >
        <template #body>
          <div class="space-y-3">
            <div class="dx-error-note rounded-sm p-3 text-sm leading-6">
              <p class="font-medium">{{ pendingDeletePath }}</p>
              <p class="mt-1">Type <span class="font-semibold">{{ pendingDeleteName }}</span> to confirm deletion.</p>
            </div>
            <UInput
              v-model="deleteConfirmation"
              icon="i-lucide-keyboard"
              size="sm"
              class="w-full"
              :disabled="Boolean(deletingWorkspace)"
              :placeholder="pendingDeleteName"
              @keyup.enter="confirmDeleteWorkspace"
            />
          </div>
        </template>

        <template #footer="{ close }">
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="subtle" size="sm" :disabled="Boolean(deletingWorkspace)" @click="close">
              Cancel
            </UButton>
            <UButton icon="i-lucide-trash-2" color="error" variant="solid" size="sm" :disabled="deleteConfirmation !== pendingDeleteName" :loading="Boolean(deletingWorkspace)" @click="confirmDeleteWorkspace">
              Delete from disk
            </UButton>
          </div>
        </template>
      </UModal>
    </div>
  </div>
</template>

<script setup lang="ts">
import { HomeCollectionController } from "../lib/home-collection";
import { ExampleEntryController } from "../lib/example-entry";

const collection = ref(new HomeCollectionController());
function displayDate(value: string): string { return new Date(value).toLocaleString(); }
const example = ref(new ExampleEntryController());
onBeforeUnmount(() => { example.value.dispose(); collection.value.dispose(); });

async function playExample(): Promise<void> {
  await example.value.play(apiBase.value, entry => navigateTo({
    path: "/stage",
    query: { workspace: entry.workspacePath, simulation: entry.simulationId, branch: entry.branchId },
  }));
}

type BusyAction = "blank" | "demo" | null;

const config = useRuntimeConfig();
const toast = useToast();

const DEFAULT_BLANK_WORKSPACE = "workspaces/new-workspace";
const DEFAULT_DEMO_WORKSPACE = "workspaces/demo";

const apiBase = ref(config.public.apiBase);
const openWorkspacePath = ref(DEFAULT_DEMO_WORKSPACE);
const blankWorkspacePath = ref(DEFAULT_BLANK_WORKSPACE);
const demoWorkspacePath = ref(DEFAULT_DEMO_WORKSPACE);
const recentWorkspaces = ref<string[]>([]);
const busyAction = ref<BusyAction>(null);
const deletingWorkspace = ref("");
const deleteModalOpen = ref(false);
const pendingDeletePath = ref("");
const deleteConfirmation = ref("");

const demoButtonLabel = computed(() => {
  return recentWorkspaces.value.includes(demoWorkspacePath.value.trim()) ? "Open Demo" : "Init Demo";
});
const pendingDeleteName = computed(() => workspaceName(pendingDeletePath.value));

onMounted(() => {
  recentWorkspaces.value = readRecentWorkspaces();
  void collection.value.load(apiBase.value);
});

async function createBlankWorkspace(): Promise<void> {
  await createWorkspace({
    path: blankWorkspacePath.value.trim(),
    template: null,
    action: "blank",
    navigateWhenExisting: false
  });
}

async function initDemoWorkspace(): Promise<void> {
  await createWorkspace({
    path: demoWorkspacePath.value.trim(),
    template: "executive-interviews",
    action: "demo",
    navigateWhenExisting: true
  });
}

async function createWorkspace(options: {
  path: string;
  template: string | null;
  action: Exclude<BusyAction, null>;
  navigateWhenExisting: boolean;
}): Promise<void> {
  if (!options.path || busyAction.value) return;
  busyAction.value = options.action;
  try {
    const result = await $fetch<{ created?: boolean; message?: string }>(`${apiBase.value}/source/init`, {
      method: "POST",
      body: {
        workspacePath: options.path,
        ...(options.template ? { template: options.template } : {})
      }
    });
    const alreadyExists = result.created === false;
    rememberWorkspace(options.path);
    toast.add({
      title: alreadyExists ? "Workspace already exists" : "Workspace ready",
      description: result.message,
      color: alreadyExists ? "neutral" : "success"
    });
    if (alreadyExists && !options.navigateWhenExisting) return;
    await navigateTo({ path: "/studio", query: { workspace: options.path } });
  } catch (error) {
    showError(error);
  } finally {
    busyAction.value = null;
  }
}

function openWorkspace(pathname: "/studio" | "/stage"): void {
  openExisting(openWorkspacePath.value.trim(), pathname);
}

function openExisting(path: string, pathname: "/studio" | "/stage"): void {
  if (!path) return;
  rememberWorkspace(path);
  navigateTo({ path: pathname, query: { workspace: path } });
}

function deleteWorkspace(path: string): void {
  pendingDeletePath.value = path;
  deleteConfirmation.value = "";
  deleteModalOpen.value = true;
}

async function confirmDeleteWorkspace(): Promise<void> {
  const path = pendingDeletePath.value;
  if (!path || deleteConfirmation.value !== pendingDeleteName.value) return;

  deletingWorkspace.value = path;
  try {
    await $fetch(`${apiBase.value}/source/delete`, {
      method: "POST",
      body: { workspacePath: path }
    });
    removeRecent(path);
    deleteModalOpen.value = false;
    pendingDeletePath.value = "";
    deleteConfirmation.value = "";
    toast.add({ title: "Workspace deleted", description: path, color: "success" });
  } catch (error) {
    showError(error);
  } finally {
    deletingWorkspace.value = "";
  }
}

function rememberWorkspace(path: string): void {
  recentWorkspaces.value = [path, ...recentWorkspaces.value.filter((workspace) => workspace !== path)].slice(0, 8);
  localStorage.setItem("doxvelt.recentWorkspaces", JSON.stringify(recentWorkspaces.value));
}

function removeRecent(path: string): void {
  recentWorkspaces.value = recentWorkspaces.value.filter((workspace) => workspace !== path);
  localStorage.setItem("doxvelt.recentWorkspaces", JSON.stringify(recentWorkspaces.value));
}

function clearRecent(): void {
  recentWorkspaces.value = [];
  localStorage.removeItem("doxvelt.recentWorkspaces");
}

function readRecentWorkspaces(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("doxvelt.recentWorkspaces") || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function workspaceName(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || path;
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  toast.add({ title: "Doxvelt", description: message, color: "error" });
}
</script>
