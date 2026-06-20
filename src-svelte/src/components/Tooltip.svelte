<script lang="ts">
  import type { BufferData } from '$lib/types';

  let { buffer, x = 0, y = 0 }: { buffer: BufferData; x: number; y: number } = $props();
</script>

<div role="tooltip" style="position: fixed; left: {x}px; top: {y}px" class="buffer-tooltip bg-surface-raised border border-border rounded-lg shadow-xl px-3 py-2 text-xs text-text whitespace-nowrap pointer-events-none z-[9999]">
  <div class="tooltip-row" data-tooltip-field="server"><span class="tooltip-label text-text-secondary">Server:</span> {buffer.server || '-'}</div>
  <div class="tooltip-row" data-tooltip-field="shortname"><span class="tooltip-label text-text-secondary">Short name:</span> {buffer.shortName || '-'}</div>
  <div class="tooltip-row" data-tooltip-field="fullname"><span class="tooltip-label text-text-secondary">Full name:</span> {buffer.fullName || '-'}</div>
  <div class="tooltip-row" data-tooltip-field="number"><span class="tooltip-label text-text-secondary">Number:</span> {buffer.number}</div>
  <div class="tooltip-row" data-tooltip-field="type"><span class="tooltip-label text-text-secondary">Type:</span> {buffer.type}</div>
</div>
