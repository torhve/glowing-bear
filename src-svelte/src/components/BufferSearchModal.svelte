<script lang="ts">
  import type { BufferData } from '$lib/types';
  import { connected, buffers, setActiveBuffer, hotlist } from '$lib/stores/models';
  import { computeJumpKeys } from '$lib/utils';
  import BaseDialog from '$components/BaseDialog.svelte';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';

  let { onBufferSelect = () => {} } = $props();
  let bufferSearchQuery = $state('');
  let selectedIndex = $state(0);
  let searchInputRef = $state<HTMLInputElement>();

  let _jumpKeys = $derived(
    computeJumpKeys(Object.values($buffers) as BufferData[])
  );

  let filteredBuffers = $derived(
    Object.values($buffers)
      .filter((buf: BufferData) => {
        if (!bufferSearchQuery) return true;
        const query = bufferSearchQuery.toLowerCase();
        return buf.shortName.toLowerCase().includes(query) ||
               buf.fullName.toLowerCase().includes(query) ||
               (buf.rtitle || '').toLowerCase().includes(query);
      })
      .sort((a: BufferData, b: BufferData) => {
        const aHotlist = $hotlist.find(h => h.buffer === a.id);
        const bHotlist = $hotlist.find(h => h.buffer === b.id);
        const aHasHighlight = (aHotlist?.count?.[3] ?? 0) > 0 ? 1 : 0;
        const bHasHighlight = (bHotlist?.count?.[3] ?? 0) > 0 ? 1 : 0;
        if (aHasHighlight !== bHasHighlight) return bHasHighlight - aHasHighlight;
        const aActivity = a.unread + a.notification;
        const bActivity = b.unread + b.notification;
        if (aActivity > 0 && bActivity === 0) return -1;
        if (aActivity === 0 && bActivity > 0) return 1;
        return 0;
      })
  );

  function handleBufferClick(buffer: BufferData) {
    setActiveBuffer(buffer.id);
    bufferSearchQuery = '';
    selectedIndex = 0;
    (document.getElementById('buffer-search-modal') as HTMLElement)?.hidePopover();
    onBufferSelect();
  }

  function handleKeyDown(e: KeyboardEvent) {
    const key = e.key;

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      if (filteredBuffers.length === 0) return;
      if (key === 'ArrowDown') {
        selectedIndex = (selectedIndex + 1) % filteredBuffers.length;
      } else {
        selectedIndex = (selectedIndex - 1 + filteredBuffers.length) % filteredBuffers.length;
      }
      return;
    }

    if (key === 'Escape') {
      e.preventDefault();
      bufferSearchQuery = '';
      selectedIndex = 0;
      (document.getElementById('buffer-search-modal') as HTMLElement)?.hidePopover();
      return;
    }

    if (key === 'Enter' && filteredBuffers.length > 0) {
      e.preventDefault();
      const selected = filteredBuffers[selectedIndex]!;
      handleBufferClick(selected);
    }
  }

  $effect(() => {
    const idx = selectedIndex;
    if (idx >= 0) {
      const el = document.querySelector(`[data-search-index="${idx}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  });
</script>

<BaseDialog id="buffer-search-modal" labelledby="buffer-search-title">
  <div class="flex flex-col max-h-[85vh]">
    <div class="px-4 py-3 border-b border-border flex items-center justify-between">
      <h2 id="buffer-search-title" class="text-sm font-bold text-text">Search Buffers</h2>
      <button
        type="button"
        popovertarget="buffer-search-modal"
        popovertargetaction="hide"
        class="text-text-muted hover:text-text p-1 rounded"
        aria-label="Close search"
      >
        <X size={16} />
      </button>
    </div>

    <div class="px-4 py-2 border-b border-border">
      <div class="relative">
        <Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        <input
          bind:this={searchInputRef}
          type="text"
          bind:value={bufferSearchQuery}
          onkeydown={handleKeyDown}
          placeholder="Search buffers..."
          class="w-full pl-8 pr-2 py-1.5 text-sm bg-input-bg border border-border rounded text-text placeholder-text-muted focus:outline-none focus:border-accent"
          autofocus
        />
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-2">
      {#each filteredBuffers as buffer, idx (buffer.id)}
        <button
          onclick={() => handleBufferClick(buffer)}
          class="w-full px-3 py-2 text-left flex items-center justify-between rounded hover:bg-surface-raised transition-colors"
          class:bg-accent={idx === selectedIndex}
          data-search-index={idx}
        >
          <div class="flex-1 min-w-0">
            <div class="text-sm text-text truncate">{buffer.shortName}</div>
            <div class="text-xs text-text-muted truncate">{buffer.fullName}</div>
          </div>
          {#if buffer.$jumpKey}
            <span class="mr-2 px-1 py-0.5 text-[10px] font-bold rounded bg-purple-600 text-white">
              {buffer.$jumpKey}
            </span>
          {/if}
          {#if buffer.notification >= 3}
            <span class="px-1.5 py-0.5 text-xs font-bold text-white bg-danger rounded">
              {buffer.unread + buffer.notification}
            </span>
          {:else if (buffer.unread + buffer.notification) > 0}
            <span class="px-1.5 py-0.5 text-xs font-bold text-white bg-accent rounded">
              {buffer.unread + buffer.notification}
            </span>
          {/if}
        </button>
      {/each}
      {#if filteredBuffers.length === 0 && bufferSearchQuery}
        <div class="px-3 py-8 text-center text-text-muted text-sm">No buffers found</div>
      {/if}
    </div>
  </div>
</BaseDialog>
