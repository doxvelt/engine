<template>
  <UApp>
    <main class="h-dvh overflow-hidden bg-slate-100 text-slate-950">
      <div class="flex h-full min-h-0 flex-col">
        <header class="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3 sm:px-4">
          <div class="flex min-w-0 items-center gap-3">
            <NuxtLink to="/" class="text-lg font-semibold">Doxvelt</NuxtLink>
            <UTabs
              v-if="currentPath !== '/'"
              :model-value="activeSection"
              :items="sectionTabs"
              size="sm"
              :content="false"
              @update:model-value="goToSection"
              :ui="{ list: 'w-44', trigger: 'flex-1 justify-center' }"
            />
          </div>
        </header>

        <NuxtPage />
      </div>
    </main>
  </UApp>
</template>

<script setup lang="ts">
const route = useRoute();
const router = useRouter();
const currentPath = ref(route.path);

const sectionTabs = [
  { label: "Studio", value: "studio", icon: "i-lucide-pencil-ruler" },
  { label: "Stage", value: "stage", icon: "i-lucide-theater" }
];

const activeSection = computed(() => currentPath.value === "/stage" ? "stage" : "studio");

onMounted(() => {
  currentPath.value = router.currentRoute.value.path;
});

router.afterEach((to) => {
  currentPath.value = to.path;
});

function goToSection(value: string | number): void {
  if (value !== "studio" && value !== "stage") return;
  navigateTo({
    path: `/${value}`,
    query: router.currentRoute.value.query
  });
}
</script>
