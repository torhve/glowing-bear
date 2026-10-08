<script lang="ts">
  import { hotlistEntries } from '#lib/stores/bufferProjections.ts';
  import { switchBuffer } from '#lib/stores/connectionManager.ts';
  import type { BufferPresentation } from '#lib/types.ts';

  let { onBufferSelect = () => {} } = $props();

  // Buffers with unread activity, sorted by highlight → unread → number. The
  // projection publishes only when an entry actually changed, so a hotlist poll
  // that re-references every background buffer without changing a count no
  // longer re-renders this strip.
  let entries = $derived($hotlistEntries);

  // Truncate long buffer names to max 18 chars with ellipsis.
  function truncateName(name: string): string {
    return name.length > 18 ? name.slice(0, 15) + '\u2026' : name;
  }

  // Switch to the clicked buffer and notify parent.
  function handleItemClick(buffer: BufferPresentation) {
    switchBuffer(buffer.id);
    onBufferSelect();
  }
</script>

<div data-testid="buffer-hotlist" class="flex items-center gap-1 min-w-0 flex-shrink overflow-x-auto">
  {#each entries as entry (entry.id)}
    <button
      onclick={() => handleItemClick(entry)}
      data-testid="hotlist-buffer-item"
      class="flex items-center gap-0.5 text-xs whitespace-nowrap cursor-pointer hover:text-white px-0.5 rounded {entry.notification > 0 ? 'text-danger font-semibold' : 'text-text-secondary'}"
    >
      <span class="truncate max-w-[3rem]">{truncateName(entry.shortName)}</span>
      <span
        data-testid="hotlist-count"
        class="font-medium {entry.notification > 0 ? 'text-danger' : 'text-accent'}"
      >
        ({entry.notification + entry.unread})
      </span>
    </button>
  {/each}
</div>
