<script lang="ts">
  import type { BufferData } from '$lib/types';
  import { buffers, activeBufferId, sortedVisibleBuffers, getEffectiveUnread } from '$lib/stores/models';
  import { switchBuffer } from '$lib/stores/connectionManager';
  import { closeBufferOnWeeChat, pinBuffer, unpinBuffer } from '$lib/stores/connectionManager';
  import { settings, updateSettings } from '$lib/stores/settings';
  import { getBufferIconName, getDisplayName } from '$lib/utils';
  import { get } from 'svelte/store';
  import { tooltipAttachment } from '$lib/utils/bufferTooltip';
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

  let sortedBuffers = $derived(
    $sortedVisibleBuffers.filter(buf => !$settings.onlyUnread || getEffectiveUnread(buf) > 0 || buf.id === $activeBufferId || buf.pinned)
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
    switchBuffer(bufferId);
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
        if (buffer.id === $activeBufferId) return 'text-accent';
        const eff = getEffectiveUnread(buffer);
        if (buffer.notification >= 3) return 'text-white font-bold';
        if (eff > 0) return 'text-accent';
        return 'text-text-secondary';
    }

   function getQuickKeyIndex(buffer: BufferData): number | null {
      if (!altKeyPressed && (!$settings.showQuickKeys || !$settings.enableQuickKeys)) return null;
       const sorted = get(sortedVisibleBuffers) as BufferData[];
      const idx = sorted.findIndex(b => b.id === buffer.id);
      if (idx === -1 || idx >= 9) return null;
      return idx + 1;
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

<div class="w-48 sm:w-32 lg:w-36 bg-surface border-r border-border flex flex-col" data-testid="buffer-list">
  <div class="buffer-list-header h-10 bg-surface-raised border-b border-border flex items-center justify-between px-2">
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
      <div class="buffer-group border-b border-border">
          {#if $settings.orderbyserver}
            <div class="buffer-group-label px-2 py-1 text-xs font-bold text-text-muted bg-input-bg flex items-center gap-1">
              <Server size={12} />{groupName}
            </div>
         {/if}
         {#each groupBufs as buffer (buffer.id)}
                <div
                    role="button"
                    tabindex="0"
                    onclick={() => handleBufferClick(buffer.id)}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleBufferClick(buffer.id); }}
                    data-testid="buffer-item"
                    {@attach tooltipAttachment(buffer)}
                    class="group relative flex items-center px-2 py-1 cursor-pointer hover:bg-accent/10 {buffer.id === $activeBufferId ? 'border-l-[3px] border-l-accent bg-accent/20' : ''}"
                  >
                  {#if getBufferIcon(buffer)}
                    {@const Icon = getBufferIcon(buffer)}
                   <Icon size={12} class="buffer-icon text-text-muted flex-shrink-0" />
                 {/if}
<span class="buffer-name text-xs {getNotifyClass(buffer)} min-w-0 ml-0.5 truncate">
                      {getDisplayName(buffer)}
                    </span>
{#if getEffectiveUnread(buffer) > 0}
                          <span
                            class="buffer-notification-badge absolute right-1 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] font-semibold rounded-full shadow-sm {buffer.id === $activeBufferId ? (buffer.notification > 0 ? '!bg-red-600 !text-white' : '!bg-warning !text-black') : (buffer.notification > 0 ? 'bg-red-600/15 text-red-600' : 'bg-accent/15 text-accent')}"
                            data-testid="unread-badge"
                          >
                             {getEffectiveUnread(buffer)}
                           </span>
                        {/if}
                   <span class="ml-auto flex items-center gap-1 flex-shrink-0 z-10">
                        {#if getQuickKeyIndex(buffer) !== null}
                             <span class="buffer-quickkey inline-flex items-center justify-center px-1 h-4 text-[10px] font-bold rounded-full bg-accent/90 text-white shadow-sm">
                               {getQuickKeyIndex(buffer)}
                             </span>
                           {/if}
                 <button
                      onclick={(e) => { e.stopPropagation(); handleTogglePin(buffer.id); }}
                       class="text-text-muted hover:text-text-secondary opacity-0 group-hover:opacity-100 focus:opacity-100"
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
                       class="text-text-muted hover:text-text-secondary opacity-0 group-hover:opacity-100 focus:opacity-100 invisible"
                       class:visible={(buffer.notification === 0 && buffer.unread === 0) || buffer.id === $activeBufferId}
                       class:opacity-100={buffer.id === $activeBufferId}
                      data-testid="close-buffer"
                    >
                      <X size={14} />
                    </button>
                  </span>
            </div>
        {/each}
      </div>
    {/each}
  </div>
</div>
