<template>
  <UPopover>
    <UButton color="neutral" variant="ghost" size="xs" class="min-w-0 max-w-[55%] text-muted" :aria-label="`Audience: ${names.join(', ')}. Turn details`">
      <span class="truncate">{{ names.join(', ') }}</span>
    </UButton>
    <template #content>
      <div class="max-h-64 max-w-72 overflow-y-auto p-4 text-sm">
        <p class="dx-label">Audience</p>
        <p class="mt-2">{{ names.join(', ') }}</p>
        <p v-if="draft" class="mt-3 text-xs text-muted">Captured when generated.</p>
        <p v-else class="mt-3 text-xs text-muted">Turn {{ number }} · Accepted</p>
        <slot />
      </div>
    </template>
  </UPopover>
</template>
<script setup lang="ts">
import type { StageActor } from "../../local-api/stage-contracts";
const props = defineProps<{ audience: string[]; actors: StageActor[]; number?: number; draft?: boolean }>();
const names = computed(() => props.audience.map(id => props.actors.find(actor => actor.id === id)?.name || id));
</script>
