<template>
  <UPopover>
    <UButton color="neutral" variant="ghost" class="min-w-0 px-0 text-left" :aria-label="`About ${name}`">
      <UAvatar :alt="name" size="xs" />
      <span class="truncate font-semibold">{{ name }}</span>
    </UButton>
    <template #content>
      <div class="max-w-64 p-4 text-sm">
        <p class="font-semibold text-highlighted">{{ name }}</p>
        <p class="mt-1 text-muted">{{ actor?.kind || 'Actor' }}</p>
        <p class="mt-2 break-all font-mono text-xs text-muted">{{ actorId }}</p>
      </div>
    </template>
  </UPopover>
</template>
<script setup lang="ts">
import type { StageActor } from "../../local-api/stage-contracts";
const props = defineProps<{ actorId: string; actors: StageActor[] }>();
const actor = computed(() => props.actors.find(item => item.id === props.actorId));
const name = computed(() => actor.value?.name || props.actorId);
</script>
