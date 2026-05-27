<template>
  <div class="min-h-0 flex-1 overflow-y-auto bg-slate-50">
    <UPageHero
      title="Workspaces"
      description="Open a Doxvelt workspace in Studio to author source files, or on Stage to run turns."
      orientation="vertical"
      class="mx-auto max-w-6xl px-4 !py-10 sm:!py-12"
      :ui="{ root: '!min-h-0', container: '!py-0 gap-6 sm:gap-8', title: 'text-3xl sm:text-4xl', description: 'mx-auto max-w-2xl text-center text-base text-slate-600' }"
    >
      <template #body>
        <div class="mx-auto grid w-full max-w-3xl gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <UInput v-model="workspacePath" icon="i-lucide-folder" size="md" class="w-full" placeholder="workspaces/my-simulation" />
          <UButton icon="i-lucide-pencil-ruler" color="neutral" variant="solid" size="md" :disabled="!workspacePath.trim()" @click="openWorkspace('/studio')">
            Open Studio
          </UButton>
          <UButton icon="i-lucide-theater" color="neutral" variant="subtle" size="md" :disabled="!workspacePath.trim()" @click="openWorkspace('/stage')">
            Open Stage
          </UButton>
        </div>
      </template>
    </UPageHero>

    <UPageSection
      v-if="recentWorkspaces.length > 0"
      class="mx-auto max-w-6xl px-4 !py-8"
      :ui="{ root: '!min-h-0', container: '!py-0 gap-5' }"
    >
      <template #header>
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold tracking-normal text-slate-950">Recent Workspaces</h2>
            <p class="mt-1 text-sm text-slate-500">Pick up where you left off.</p>
          </div>
          <UButton icon="i-lucide-list-x" color="neutral" variant="ghost" size="sm" @click="clearRecent">
            Clear
          </UButton>
        </div>
      </template>

      <div class="grid gap-3">
        <UCard
          v-for="workspace in recentWorkspaces"
          :key="workspace"
          :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-4' }"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold">{{ workspaceName(workspace) }}</p>
            <p class="mt-1 truncate text-xs text-slate-500">{{ workspace }}</p>
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
    </UPageSection>

    <UPageSection
      class="mx-auto max-w-6xl px-4 !py-8"
      :ui="{ root: '!min-h-0', container: '!py-0 gap-5' }"
    >
      <template #header>
        <div>
          <h2 class="text-2xl font-semibold tracking-normal text-slate-950">Start Something</h2>
          <p class="mt-1 text-sm text-slate-500">Create a clean source workspace or load the example when you want a known-good reference.</p>
        </div>
      </template>

      <div class="grid gap-4 md:grid-cols-2">
        <UPageCard
          icon="i-lucide-file-plus-2"
          title="Create Blank Workspace"
          description="Scaffold folders, a starter model, one world, one scenario, one format, and one actor dossier."
          :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'gap-4' }"
        >
          <UButton icon="i-lucide-file-plus-2" color="neutral" variant="solid" size="sm" block :disabled="!workspacePath.trim()" :loading="busy" @click="createWorkspace(null)">
            New Blank
          </UButton>
        </UPageCard>

        <UPageCard
          icon="i-lucide-sparkles"
          title="Load Demo Workspace"
          description="Seed the executive-interviews example so you can inspect a complete authored workspace."
          :ui="{ root: 'rounded-lg border border-slate-200 shadow-none', body: 'gap-4' }"
        >
          <UButton icon="i-lucide-sparkles" color="neutral" variant="subtle" size="sm" block :disabled="!workspacePath.trim()" :loading="busy" @click="createWorkspace('executive-interviews')">
            Init Demo
          </UButton>
        </UPageCard>
      </div>
    </UPageSection>

    <UPageSection
      v-if="recentWorkspaces.length === 0"
      class="mx-auto max-w-6xl px-4 !pb-12 !pt-8"
      :ui="{ root: '!min-h-0', container: '!py-0 gap-5' }"
    >
      <template #header>
        <div>
          <h2 class="text-2xl font-semibold tracking-normal text-slate-950">Recent Workspaces</h2>
          <p class="mt-1 text-sm text-slate-500">Your workspace history will appear here after you open or create one.</p>
        </div>
      </template>

      <div class="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
        <p class="text-sm font-medium text-slate-700">No recent workspaces yet.</p>
        <p class="mt-1 text-sm text-slate-500">Create a blank workspace or initialize the demo to begin.</p>
      </div>
    </UPageSection>
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
