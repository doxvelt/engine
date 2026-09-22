<template>
  <section v-if="history.editor" class="stage-revision space-y-3" aria-label="Historical revision" @keydown.esc.stop.prevent="$emit('cancel')">
    <p class="dx-label">Historical revision · {{ history.editor.action === 'manual' ? 'Edit performance' : 'Complete stage whisper' }}</p>
    <p class="text-sm text-muted">Creates an alternative at this turn. Each path keeps its own continuation.</p>
    <p v-if="history.stale" class="dx-warning-note p-2 text-sm" role="alert">The source branch has advanced. This editor retains its original basis. Cancel and select the turn again to use the current source head.</p>
    <URadioGroup v-model="history.editor.action" :items="[{ label: 'Edit performance', value: 'manual' }, { label: 'Regenerate / replace whisper', value: 'generate' }]" orientation="horizontal" @update:model-value="history.touch()" />
    <UFormField v-if="history.editor.action === 'manual'" label="Historical performance" hint="Director-authored alternative; no model call.">
      <UTextarea v-model="history.editor.performance" aria-label="Historical performance" :rows="5" class="w-full" @update:model-value="history.touch()" />
    </UFormField>
    <template v-else>
      <p v-if="!history.origin" role="status">Loading originating input…</p>
      <p v-else-if="history.origin.completeWhisper === null" role="status">{{ history.origin.state }} originating input. Enter and confirm a complete replacement, including a deliberate empty whisper.</p>
      <UFormField label="Complete historical whisper" hint="Only this complete input is used with the pre-turn actor context.">
        <UTextarea v-model="history.editor.whisper" aria-label="Complete historical whisper" :rows="5" class="w-full" @update:model-value="history.touch()" />
      </UFormField>
      <UCheckbox v-model="history.editor.confirmed" label="Use this complete whisper, including if empty" @update:model-value="history.touch()" />
      <details v-if="history.origin">
        <summary class="text-sm">Recorded originating input · {{ history.origin.kind }}</summary>
        <p v-if="history.origin.completeWhisper !== null" class="whitespace-pre-wrap text-sm">{{ history.origin.completeWhisper || 'Recorded empty whisper.' }}</p>
        <p v-for="w in history.origin.recordedWhispers" :key="w.id" class="whitespace-pre-wrap text-sm">{{ w.text }}</p>
        <p v-if="history.origin.legacyCorrection" class="whitespace-pre-wrap text-sm">Legacy correction: {{ history.origin.legacyCorrection }}</p>
      </details>
    </template>
    <UPopover>
      <UButton color="neutral" variant="subtle">Alternative recipients</UButton>
      <template #content>
        <div class="max-h-72 w-64 space-y-3 overflow-y-auto p-4">
          <UCheckbox v-if="history.editor.action === 'generate'" v-model="history.editor.propose" label="Request a fresh audience proposal" @update:model-value="history.touch()" />
          <UCheckboxGroup v-model="history.editor.audience" :items="audienceItems" :disabled="history.editor.action === 'generate' && history.editor.propose" @update:model-value="history.touch()" />
          <p class="text-xs">The actor also perceives their own turn.</p>
        </div>
      </template>
    </UPopover>
    <p v-if="history.error" class="dx-error-note p-2 text-sm" role="alert">{{ history.error }}</p>
    <p v-if="history.notice" class="text-sm" role="status">{{ history.notice }}</p>
    <div class="flex flex-wrap gap-2">
      <UButton :disabled="history.locked || history.stale || !history.origin || (history.editor.action === 'generate' ? !runtimeConfigured || !history.editor.confirmed : !history.editor.performance.trim())" :loading="history.busy" @click="history.submit()">{{ history.editor.action === 'manual' ? 'Save edited alternative' : 'Generate saved alternative' }}</UButton>
      <UButton v-if="history.command" color="neutral" variant="subtle" :disabled="history.busy" @click="history.resume()">Reconcile saved request</UButton>
      <UButton color="neutral" variant="ghost" @click="$emit('cancel')">Cancel · return to continuation</UButton>
    </div>
    <div v-if="history.discovery?.paths.length" class="space-y-2" aria-label="Alternative paths">
      <p class="dx-label">Paths at this turn</p>
      <div class="flex flex-wrap gap-2">
        <UButton v-for="(path, index) in history.discovery.paths" :key="path.branchId" color="neutral" variant="subtle" :disabled="history.locked" :aria-label="`Select path ${index + 1}: ${path.branchId}`" @click="history.cycle(path)">{{ index + 1 }} · {{ path.branchId === history.editor.selection.sourceBranchId ? 'Current path' : 'Alternative' }}</UButton>
      </div>
    </div>
    <details v-if="history.discovery?.operations.length">
      <summary>Saved historical operations ({{ history.discovery.operations.length }})</summary>
      <div v-for="op in history.discovery.operations" :key="op.id" class="mt-2 space-y-1 text-sm">
        <p>{{ op.action }} · {{ op.status }} · {{ op.id }}</p>
        <div class="flex flex-wrap gap-2">
          <UButton size="xs" color="neutral" variant="ghost" :disabled="history.busy" @click="history.inspectOperation(op.id)">Check status</UButton>
          <UButton v-if="op.status === 'failed' || op.status === 'discarded'" size="xs" color="neutral" variant="subtle" :disabled="history.locked || !runtimeConfigured" @click="history.retry(op.id)">Retry captured input</UButton>
          <UButton v-if="op.status === 'pending' || op.status === 'failed'" size="xs" color="neutral" variant="ghost" :disabled="history.busy" @click="history.discard(op.id)">Discard operation</UButton>
        </div>
      </div>
    </details>
  </section>
</template>
<script setup lang="ts">
import type { StageHistory } from '../lib/stage-history';
import type { StageActor } from '../../local-api/stage-contracts';
const props = defineProps<{ history: StageHistory; actors: StageActor[]; runtimeConfigured: boolean }>();
defineEmits<{ cancel: [] }>();
const audienceItems = computed(() => props.actors.filter(a => a.id !== props.history.editor?.selection.actorId).map(a => ({ label: a.name, value: a.id })));
</script>
<style scoped>
.stage-revision { border-left: 2px solid var(--dx-accent); background: var(--dx-accent-subtle); padding: var(--dx-space-3); border-radius: var(--dx-radius-sm); }
</style>
