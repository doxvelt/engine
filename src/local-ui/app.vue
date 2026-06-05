<template>
  <UApp>
    <main class="dx-app-shell h-dvh overflow-hidden">
      <div class="flex h-full min-h-0 flex-col">
        <header class="dx-topbar flex h-16 shrink-0 items-center justify-between border-b px-4 sm:px-8">
          <div class="flex min-w-0 items-center gap-3">
            <NuxtLink to="/" class="flex min-w-0 items-center" aria-label="Doxvelt home">
              <img :src="wordmark" alt="Doxvelt" class="dx-wordmark" />
            </NuxtLink>
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
          <UColorModeSelect color="neutral" variant="ghost" size="sm" aria-label="Theme" />
        </header>

        <NuxtPage />
      </div>
    </main>
  </UApp>
</template>

<script setup lang="ts">
import wordmarkInk from "../../design-system/assets/2026-05-doxvelt-wordmark-fg-ink-raw.svg";
import wordmarkParchment from "../../design-system/assets/2026-05-doxvelt-wordmark-fg-parchment-raw.svg";

const route = useRoute();
const router = useRouter();
const currentPath = ref(route.path);
const colorMode = useColorMode();

const wordmark = computed(() => colorMode.value === "dark" ? wordmarkParchment : wordmarkInk);

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
