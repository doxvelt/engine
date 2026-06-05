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
          <h2 class="dx-label">Source Workspace</h2>
          <div class="mt-4 grid gap-3">
            <UInput v-model="workspacePath" icon="i-lucide-folder" size="md" class="w-full" placeholder="workspaces/my-simulation" />
            <div class="grid gap-2 sm:grid-cols-2">
              <UButton icon="i-lucide-pencil-ruler" color="primary" variant="solid" size="md" block :disabled="!workspacePath.trim()" @click="openWorkspace('/studio')">
                Open Studio
              </UButton>
              <UButton icon="i-lucide-theater" color="neutral" variant="subtle" size="md" block :disabled="!workspacePath.trim()" @click="openWorkspace('/stage')">
                Open Stage
              </UButton>
            </div>
          </div>

        </aside>
      </section>

      <section v-if="recentWorkspaces.length > 0" class="py-8">
        <div class="dx-section-heading">
          <div>
            <h2 class="dx-section-title">Recent Workspaces</h2>
            <p class="mt-1 text-sm text-muted">Pick up where you left off.</p>
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
          <UButton icon="i-lucide-file-plus-2" color="primary" variant="solid" size="sm" block :disabled="!workspacePath.trim()" :loading="busy" @click="createWorkspace(null)">
            New Blank
          </UButton>
        </UPageCard>

        <UPageCard
          icon="i-lucide-sparkles"
          title="Load Demo Workspace"
          description="Seed the executive-interviews example so you can inspect a complete authored workspace."
          :ui="{ root: 'dx-action-card', body: 'gap-4' }"
        >
          <UButton icon="i-lucide-sparkles" color="neutral" variant="subtle" size="sm" block :disabled="!workspacePath.trim()" :loading="busy" @click="createWorkspace('executive-interviews')">
            Init Demo
          </UButton>
        </UPageCard>
      </div>
      </section>

      <section v-if="recentWorkspaces.length === 0" class="pb-12 pt-8">
        <div class="dx-section-heading">
          <div>
            <h2 class="dx-section-title">Recent Workspaces</h2>
          <p class="mt-1 text-sm text-muted">Your workspace history will appear here after you open or create one.</p>
        </div>
        </div>

        <div class="rounded-md border border-dashed border-muted bg-default p-8 text-center">
        <p class="text-sm font-medium text-default">No recent workspaces yet.</p>
        <p class="mt-1 text-sm text-muted">Create a blank workspace or initialize the demo to begin.</p>
      </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
const config = useRuntimeConfig();
const toast = useToast();

const apiBase = ref(config.public.apiBase);
const workspacePath = ref("workspaces/demo");
const recentWorkspaces = ref<string[]>([]);
const busy = ref(false);

onMounted(() => {
  recentWorkspaces.value = readRecentWorkspaces();
});

async function createWorkspace(template: string | null): Promise<void> {
  const path = workspacePath.value.trim();
  if (!path) return;
  busy.value = true;
  try {
    const result = await $fetch<{ created?: boolean; message?: string }>(`${apiBase.value}/source/init`, {
      method: "POST",
      body: {
        workspacePath: path,
        ...(template ? { template } : {})
      }
    });
    rememberWorkspace(path);
    toast.add({
      title: result.created === false ? "Workspace already exists" : "Workspace ready",
      description: result.message,
      color: result.created === false ? "neutral" : "success"
    });
    await navigateTo({ path: "/studio", query: { workspace: path } });
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}

function openWorkspace(pathname: "/studio" | "/stage"): void {
  openExisting(workspacePath.value.trim(), pathname);
}

function openExisting(path: string, pathname: "/studio" | "/stage"): void {
  if (!path) return;
  rememberWorkspace(path);
  navigateTo({ path: pathname, query: { workspace: path } });
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
