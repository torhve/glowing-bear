<script lang="ts">
  import type { BufferData } from '$lib/types';
  import { buffers, hotlist } from '$lib/stores/models';
  import { switchBuffer } from '$lib/stores/connectionManager';
  
  import BaseDialog from '$components/BaseDialog.svelte';
  import FormInput from '$components/FormInput.svelte';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';

  let { onBufferSelect = () => {} } = $props();
  let bufferSearchQuery = $state('');
  let selectedIndex = $state(0);

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
    switchBuffer(buffer.id);
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

    if (key === 'Enter' && filteredBuffers.length > 0) {
      e.preventDefault();
      const selected = filteredBuffers[selectedIndex]!;
      handleBufferClick(selected);
    }
  }

  function handleToggle(event: ToggleEvent) {
    if (event.newState === 'open') {
      const input = document.getElementById('buffer-search') as HTMLInputElement;
      input?.focus();
      input?.select();
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

<BaseDialog id="buffer-search-modal" labelledby="buffer-search-title" noAnimation ontoggle={handleToggle}>
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
        <FormInput
          id="buffer-search"
          type="text"
          value={bufferSearchQuery}
          oninput={(e: Event) => { bufferSearchQuery = (e.target as HTMLInputElement).value; }}
          onkeydown={handleKeyDown}
          placeholder="Search buffers..."
          variant="search"
          extraClass="pr-2"
        />
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-2">
      {#each filteredBuffers as buffer, idx (buffer.id)}
        <button
          onclick={() => handleBufferClick(buffer)}
          class="w-full px-3 py-3 text-left flex items-center relative rounded hover:bg-surface-raised transition-colors"
          class:bg-accent={idx === selectedIndex}
          data-search-index={idx}
        >
          <div class="flex-1 min-w-0">
            <div class="text-lg text-text truncate">{buffer.shortName}</div>
            <div class="text-sm text-text-muted truncate">{buffer.fullName}</div>
          </div>
          {#if buffer.$jumpKey}
            <span class="mr-2 px-1.5 py-0.5 text-xs font-bold rounded bg-surface-raised border border-border">
              {buffer.$jumpKey}
            </span>
          {/if}
          {#if buffer.notification >= 3}
            <span class="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs font-bold text-text bg-danger rounded">
              {buffer.notification}
            </span>
          {:else if buffer.notification > 0 || buffer.unread > 0}
            <span class="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs font-bold text-text bg-warning rounded">
              {buffer.notification > 0 ? buffer.notification : buffer.unread}
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
