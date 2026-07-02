<script lang="ts">
  import type { BufferData } from '$lib/types';
  import { visibleBuffers, sortBuffers } from '$lib/stores/models';
  import { switchBuffer } from '$lib/stores/connectionManager';

  import BaseDialog from '$components/BaseDialog.svelte';
  import FormInput from '$components/FormInput.svelte';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';

  interface BufferGroup {
    number: number;
    buffers: BufferData[];
  }

  let { onBufferSelect = () => {} } = $props();
  let bufferSearchQuery = $state('');
  let selectedIndex = $state(0);

  let filteredBuffers = $derived(
    $visibleBuffers.filter((buf: BufferData) => {
      if (!bufferSearchQuery) return true;
      const query = bufferSearchQuery.toLowerCase();
      return buf.shortName.toLowerCase().includes(query) ||
        buf.fullName.toLowerCase().includes(query) ||
        (buf.rtitle || '').toLowerCase().includes(query) ||
        String(buf.number).includes(query);
    })
  );

  // Group merged buffers by their shared number, sorted by first buffer's priority
  let groupedBuffers = $derived(
    sortBuffers(filteredBuffers, false).reduce<BufferGroup[]>((groups, buf) => {
      const existing = groups.find(g => g.number === buf.number);
      if (existing) {
        existing.buffers.push(buf);
      } else {
        groups.push({ number: buf.number, buffers: [buf] });
      }
      return groups;
    }, [])
  );

  async function handleBufferClick(buffer: BufferData) {
    const switched = await switchBuffer(buffer.id);
    if (!switched) return;
    bufferSearchQuery = '';
    selectedIndex = 0;
    (document.getElementById('buffer-search-modal') as HTMLElement)?.hidePopover();
    onBufferSelect();
  }

  function handleKeyDown(e: KeyboardEvent) {
    const key = e.key;

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      if (groupedBuffers.length === 0) return;
      if (key === 'ArrowDown') {
        selectedIndex = (selectedIndex + 1) % groupedBuffers.length;
      } else {
        selectedIndex = (selectedIndex - 1 + groupedBuffers.length) % groupedBuffers.length;
      }
      return;
    }

    if (key === 'Enter') {
      e.preventDefault();
      if (groupedBuffers.length > 0) {
        const selectedGroup = groupedBuffers[selectedIndex]!;
        handleBufferClick(selectedGroup.buffers[0]!);
      }
    }
  }

  function handleToggle(event: ToggleEvent) {
    if (event.newState === 'open') {
      const input = document.getElementById('buffer-search') as HTMLInputElement;
      input?.focus();
      input?.select();
    }
    else if (event.newState === 'closed') {
      bufferSearchQuery = '';
      selectedIndex = 0;
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
  <div class="buffer-search-content flex flex-col max-h-[85vh]">
    <div class="buffer-search-header px-4 py-3 border-b border-border flex items-center justify-between">
      <h2 id="buffer-search-title" class="text-sm font-bold text-text">Search Buffers</h2>
      <button
        data-testid="buffer-search-close"
        type="button"
        popovertarget="buffer-search-modal"
        popovertargetaction="hide"
        class="text-text-muted hover:text-text p-1 rounded"
        aria-label="Close search"
      >
        <X size={16} />
      </button>
    </div>

    <div class="buffer-search-input-area px-4 py-2 border-b border-border">
      <div class="relative">
        <Search size={14} class="buffer-search-icon absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
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

    <div class="buffer-search-results flex-1 overflow-y-auto p-2">
      {#each groupedBuffers as group, idx (group.number)}
        <button
          onclick={() => handleBufferClick(group.buffers[0]!)}
          class="buffer-search-item w-full px-3 py-3 text-left flex items-center relative rounded hover:bg-surface-raised transition-colors {idx === selectedIndex ? '!bg-accent' : ''}"
          data-search-index={idx}
        >
          <div class="flex items-center gap-2 min-w-0">
            <span class="buffer-search-number flex-shrink-0 px-1.5 py-0.5 text-xs font-bold rounded bg-surface-raised border border-border text-white">
              {group.number}
            </span>
            <div class="min-w-0 flex-1">
              <div class="buffer-search-shortname text-base font-bold truncate text-white">{group.buffers.map(b => b.shortName).join(', ')}</div>
              <div class="buffer-search-fullname text-sm truncate text-white/70">{group.buffers.map(b => b.fullName).join(', ')}</div>
            </div>
          </div>

          {#if group.buffers.some(b => b.notification >= 3)}
            <span class="buffer-search-badge notification-badge absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs font-bold rounded bg-danger/60 text-white">
              {group.buffers.reduce((sum, b) => sum + b.notification, 0)}
            </span>
          {:else if group.buffers.some(b => b.notification > 0 || b.unread > 0)}
            <span class="buffer-search-badge unread-badge absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs font-bold rounded bg-warning/60 text-white">
              {group.buffers.reduce((sum, b) => sum + (b.notification > 0 ? b.notification : b.unread), 0)}
            </span>
          {/if}
        </button>
      {/each}
      {#if groupedBuffers.length === 0 && bufferSearchQuery}
        <div class="buffer-search-no-results px-3 py-8 text-center text-white/50 text-sm">No buffers found</div>
      {/if}
    </div>
  </div>
</BaseDialog>
