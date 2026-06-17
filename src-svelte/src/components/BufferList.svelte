<script lang="ts">
  import type { BufferData, HotlistEntry } from '$lib/types';
  import { buffers, activeBufferId, setActiveBuffer, hotlist } from '$lib/stores/models';
  import { closeBufferOnWeeChat, pinBuffer, unpinBuffer } from '$lib/stores/connectionManager';
  import { settings, updateSettings } from '$lib/stores/settings';
  import { sortBuffers, computeJumpKeys, getBufferIconName } from '$lib/utils';
  import Pin from '@lucide/svelte/icons/pin';
  import PinOff from '@lucide/svelte/icons/pin-off';
  import X from '@lucide/svelte/icons/x';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import List from '@lucide/svelte/icons/list';
  import Hash from '@lucide/svelte/icons/hash';
  import User from '@lucide/svelte/icons/user';
  import Server from '@lucide/svelte/icons/server';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Square from '@lucide/svelte/icons/square';

  let { altKeyPressed = false, onBufferSelect = () => {} } = $props();

  function getHighlightCount(buf: BufferData): number {
    const entry = $hotlist.find((h: HotlistEntry) => h.buffer === buf.id);
    return entry?.count?.[3] ?? 0;
  }

  function getUnreadCount(buf: BufferData): number {
    return buf.unread + buf.notification - (getHighlightCount(buf) || 0);
  }

  let sortedBuffers = $derived(
    sortBuffers(
      Object.values($buffers)
        .filter(buf => !buf.hidden)
        .filter(buf => !$settings.onlyUnread || buf.unread > 0 || buf.notification > 0 || buf.active || buf.pinned),
      $settings.orderbyserver
    )
  );

  let groupedBuffers = $derived(
    $settings.orderbyserver
      ? groupByServer(sortedBuffers)
      : { 'All': sortedBuffers }
  );

  function groupByServer(bufs: BufferData[]) {
    const groups: Record<string, BufferData[]> = {};
    for (const buf of bufs) {
      const server = buf.server || 'General';
      if (!groups[server]) {
        groups[server] = [];
      }
      groups[server].push(buf);
    }
    return groups;
  }

  function handleBufferClick(bufferId: string) {
    setActiveBuffer(bufferId);
    onBufferSelect();
  }

  function handleCloseBuffer(bufferId: string) {
    closeBufferOnWeeChat(bufferId);
  }

  function handleTogglePin(bufferId: string) {
    const buffer = $buffers[bufferId];
    if (!buffer) return;
    const wasPinned = buffer.pinned;
    buffers.update(current => {
      const existing = current[bufferId];
      if (!existing) return current;
      const updated = { ...current };
      updated[bufferId] = { ...existing, pinned: !wasPinned };
      return updated;
    });
    if (wasPinned) {
      unpinBuffer(bufferId);
    } else {
      pinBuffer(bufferId);
    }
  }

  function toggleServers() {
    updateSettings({ orderbyserver: !$settings.orderbyserver });
  }

 function getNotifyClass(buffer: BufferData): string {
      if (buffer.id === $activeBufferId) return 'text-[var(--gb-ribbon)]';
      if (buffer.notification >= 3) return 'text-white font-bold';
      if (buffer.unread > 0) return 'text-accent';
      return 'text-text-secondary';
    }

   function getQuickKeyIndex(buffer: BufferData): number | null {
      if (!altKeyPressed && (!$settings.showQuickKeys || !$settings.enableQuickKeys)) return null;
      const sorted = sortBuffers((Object.values($buffers) as BufferData[]).filter(b => !b.hidden), $settings.orderbyserver);
      const idx = sorted.findIndex(b => b.id === buffer.id);
      if (idx === -1) return null;
      return idx === 9 ? 0 : idx + 1;
    }

    let _jumpKeys = $derived(
      computeJumpKeys(Object.values($buffers) as BufferData[])
    );

    function getJumpKey(buffer: BufferData): string | null {
      if (!altKeyPressed && !($settings.showJumpKeys && $settings.enableQuickKeys)) return null;
      return buffer.$jumpKey ?? null;
    }

    function getBufferIcon(buffer: BufferData) {
      const iconName = getBufferIconName(buffer);
      if (iconName === 'hash') return Hash;
      if (iconName === 'user') return User;
      if (iconName === 'server') return Server;
      if (iconName === 'monitor') return Monitor;
      return Square;
    }
</script>

<div class="w-48 sm:w-32 lg:w-36 bg-surface border-r border-border flex flex-col overflow-hidden" data-testid="buffer-list">
  <div class="h-10 bg-surface-raised border-b border-border flex items-center justify-between px-2">
    <div class="flex items-center space-x-1">
      <button
        onclick={toggleServers}
        class="text-text-muted hover:text-text p-1 rounded"
        title={$settings.orderbyserver ? 'Switch to list view' : 'Group by server'}
        data-testid="toggle-server-groups"
      >
        {#if $settings.orderbyserver}
          <List size={14} />
        {:else}
          <LayoutGrid size={14} />
        {/if}
      </button>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto" data-testid="buffer-list-items">
    {#each Object.entries(groupedBuffers) as [groupName, groupBufs] (groupName)}
      <div class="border-b border-border">
        {#if $settings.orderbyserver}
          <div class="px-2 py-1 text-xs font-bold text-text-muted bg-input-bg flex items-center gap-1">
            <Server size={12} />{groupName}
          </div>
        {/if}
        {#each groupBufs as buffer (buffer.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
         <div
               onclick={() => handleBufferClick(buffer.id)}
               data-testid="buffer-item"
                 class="group relative flex items-center px-2 py-1 cursor-pointer hover:bg-surface-raised {buffer.id === $activeBufferId ? 'border-l-[3px] bg-accent/20' : ''}"
                 style:border-left-color={buffer.id === $activeBufferId ? 'var(--gb-ribbon)' : undefined}
             >
             <!-- Quick key overlay, absolutely positioned over the close button area -->
             <span class="absolute right-1.5 top-1/2 -translate-y-1/2 z-10 flex gap-0.5">
                   {#if getQuickKeyIndex(buffer) !== null}
                     <span class="inline-flex items-center justify-center px-1 h-4 text-[10px] font-bold rounded bg-accent text-white">
                       {getQuickKeyIndex(buffer)}
                     </span>
                   {/if}
                   {#if getJumpKey(buffer)}
                     <span class="inline-flex items-center justify-center px-1 h-4 text-[10px] font-bold rounded bg-purple-600 text-white">
                       {getJumpKey(buffer)}
                     </span>
                   {/if}
                 </span>
               {#if getBufferIcon(buffer)}
                 {@const Icon = getBufferIcon(buffer)}
                <Icon size={12} class="text-text-muted flex-shrink-0" />
              {/if}
              <span class="text-xs {getNotifyClass(buffer)} flex-1 min-w-0 ml-0.5 truncate">
                 {buffer.shortName}
               </span>
               {#if (buffer.unread + buffer.notification) > 0}
                <span class="absolute right-10 {buffer.notification > 0 ? 'bg-red-600 text-white' : 'bg-accent/80 text-white'} rounded-full px-1 py-0 text-[10px] font-bold -translate-y-1/2" style="top: 50%;">
                  {buffer.unread + buffer.notification}
                </span>
                {/if}
             <button
                 onclick={(e) => { e.stopPropagation(); handleTogglePin(buffer.id); }}
                  class="mr-0.5 text-text-muted hover:text-text-secondary opacity-0 group-hover:opacity-100 focus:opacity-100"
                 data-testid="pin-buffer"
                title="{buffer.pinned ? 'Unpin buffer' : 'Pin buffer'}"
              >
                {#if buffer.pinned}
                  <PinOff size={14} />
                {:else}
                  <Pin size={14} />
                {/if}
              </button>
             <button
                onclick={(e) => { e.stopPropagation(); handleCloseBuffer(buffer.id); }}
                 class="ml-0.5 text-text-muted hover:text-text-secondary opacity-0 group-hover:opacity-100 focus:opacity-100"
                class:opacity-100={buffer.id === $activeBufferId}
                data-testid="close-buffer"
              >
                <X size={14} />
              </button>
          </div>
        {/each}
      </div>
    {/each}
  </div>
</div>
