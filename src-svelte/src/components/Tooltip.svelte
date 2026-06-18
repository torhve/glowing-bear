<script lang="ts">
  import type { BufferData } from '$lib/types';

  let { buffer }: { buffer: BufferData } = $props();
</script>

<div role="tooltip" class="bg-surface-raised border border-border rounded-lg shadow-xl px-3 py-2 text-xs text-text whitespace-nowrap pointer-events-none z-[9999]">
  <div><span class="text-text-secondary">Server:</span> {buffer.server || '-'}</div>
  <div><span class="text-text-secondary">Short name:</span> {buffer.shortName || '-'}</div>
  <div><span class="text-text-secondary">Full name:</span> {buffer.fullName || '-'}</div>
  <div><span class="text-text-secondary">Number:</span> {buffer.number}</div>
  <div><span class="text-text-secondary">Type:</span> {buffer.type}</div>
</div>
