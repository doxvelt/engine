<template>
  <div class="dx-home min-h-0 flex-1 overflow-y-auto">
    <div class="dx-home-container">
      <section class="dx-home-intro">
        <div>
          <h1 class="dx-display">Open subjective worlds.</h1>
          <p class="dx-lede">
            Author dossiers in Studio, then run hard-turn scenes on Stage with subjective context, beliefs, memories, and access paths intact.
          </p>
        </div>

        <aside class="dx-light-card p-6">
          <h2 class="dx-label">Open Existing</h2>
          <div class="mt-4 grid gap-3">
            <UInput v-model="openWorkspacePath" icon="i-lucide-folder-open" size="md" class="w-full" placeholder="workspaces/my-simulation" />
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
      </section>

      <section v-if="recentWorkspaces.length > 0" class="py-8">
        <div class="dx-section-heading">
          <div>
            <h2 class="dx-section-title">Recent In This Browser</h2>
            <p class="mt-1 text-sm text-muted">Pick up where this browser last left off.</p>
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
            <h2 class="dx-section-title">Start Something</h2>
            <p class="mt-1 text-sm text-muted">Create a clean source workspace or load the example when you want a known-good reference.</p>
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <UPageCard
            icon="i-lucide-file-plus-2"
            title="Create Blank Workspace"
            description="Scaffold folders, a starter model, one world, one scenario, one format, and one actor dossier."
            :ui="{ root: 'dx-action-card', body: 'gap-4' }"
          >
            <UInput v-model="blankWorkspacePath" icon="i-lucide-folder-plus" size="sm" class="w-full" />
            <UButton icon="i-lucide-file-plus-2" color="primary" variant="solid" size="sm" block :disabled="!blankWorkspacePath.trim()" :loading="busyAction === 'blank'" @click="createBlankWorkspace">
              New Blank
            </UButton>
          </UPageCard>

          <UPageCard
            icon="i-lucide-sparkles"
            title="Load Demo Workspace"
            description="Seed the executive-interviews example so you can inspect a complete authored workspace."
            :ui="{ root: 'dx-action-card', body: 'gap-4' }"
          >
            <UInput v-model="demoWorkspacePath" icon="i-lucide-folder-symlink" size="sm" class="w-full" />
            <UButton icon="i-lucide-sparkles" color="neutral" variant="subtle" size="sm" block :disabled="!demoWorkspacePath.trim()" :loading="busyAction === 'demo'" @click="initDemoWorkspace">
              {{ demoButtonLabel }}
            </UButton>
          </UPageCard>
        </div>
      </section>

      <section v-if="recentWorkspaces.length === 0" class="pb-12 pt-8">
        <div class="dx-section-heading">
          <div>
            <h2 class="dx-section-title">Recent In This Browser</h2>
            <p class="mt-1 text-sm text-muted">This browser's workspace history will appear here after you open or create one.</p>
          </div>
        </div>

        <div class="rounded-md border border-dashed border-muted bg-default p-8 text-center">
          <p class="text-sm font-medium text-default">No recent workspaces yet.</p>
          <p class="mt-1 text-sm text-muted">Create a blank workspace or initialize the demo to begin.</p>
        </div>
      </section>

      <UModal
        v-model:open="deleteModalOpen"
        title="Delete Workspace"
        description="This removes the source folder from disk. Recent history removal alone is still available with the x button."
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
  if (!options.path) return;
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
