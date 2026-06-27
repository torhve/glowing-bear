<script lang="ts">
  import type { BufferData } from '$lib/types';
  import { buffers, activeBufferId, sortedVisibleBuffers, getEffectiveUnread } from '$lib/stores/models';
  import { switchBuffer } from '$lib/stores/connectionManager';
  import { settings, updateSettings } from '$lib/stores/settings';
  import { getBufferIconName, getDisplayName } from '$lib/utils';
  import { get } from 'svelte/store';
  import { tooltipAttachment } from '$lib/utils/bufferTooltip';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import List from '@lucide/svelte/icons/list';
  import Hash from '@lucide/svelte/icons/hash';
  import User from '@lucide/svelte/icons/user';
  import Server from '@lucide/svelte/icons/server';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Square from '@lucide/svelte/icons/square';
import Copy from '@lucide/svelte/icons/copy';
import Badge from './Badge.svelte';

let { altKeyPressed = false, onBufferSelect = () => {} } = $props();

  let sortedBuffers = $derived(
    $sortedVisibleBuffers.filter(buf => !$settings.onlyUnread || getEffectiveUnread(buf) > 0 || buf.id === $activeBufferId || buf.pinned)
  );

  let groupedBuffers = $derived(
    $settings.orderbyserver
      ? groupByServer(sortedBuffers)
      : { 'All': sortedBuffers }
  );

  // Long-press context menu state
  let longPressBufferId = $state<string | null>(null);
  let longPressMenuX = $state(0);
  let longPressMenuY = $state(0);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

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
    clearLongPress();
    switchBuffer(bufferId);
    onBufferSelect();
  }

  function toggleServers() {
    updateSettings({ orderbyserver: !$settings.orderbyserver });
  }

  function copyBufferName(name: string) {
    navigator.clipboard.writeText(name).catch(() => {});
    longPressBufferId = null;
  }

  function handleLongPressStart(bufferId: string, event: TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches?.[0];
    if (!touch) return;
    longPressMenuX = touch.clientX;
    longPressMenuY = touch.clientY;

    longPressTimer = setTimeout(() => {
      longPressBufferId = bufferId;
      longPressTimer = null;
    }, 500);
  }

  function clearLongPress() {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressBufferId = null;
  }

  function handleLongPressEnd() {
    clearLongPress();
  }

    // Text color follows Tailwind nav pattern: active = full brightness,
    // inactive = muted, hover brightens. Notifications still use accent.
    function getNotifyClass(buffer: BufferData): string {
        if (buffer.id === $activeBufferId) return 'text-text font-semibold';
        const eff = getEffectiveUnread(buffer);
        if (buffer.notification >= 3) return 'text-accent font-bold';
        if (eff > 0) return 'text-accent font-medium';
        return 'text-text-secondary font-medium group-hover:text-text';
    }

    // Return icon color class — follows active/hover state for visual cohesion
    // Active icons use full opacity; inactive icons are slightly muted
    function getIconClass(buffer: BufferData): string {
        if (buffer.id === $activeBufferId) return 'text-accent opacity-100';
        return 'text-text-muted opacity-75 group-hover:opacity-100 transition-colors';
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

<div class="w-56 sm:w-48 lg:w-52 bg-panel border-r border-border flex flex-col" data-testid="buffer-list">
  <div class="buffer-list-header h-10 bg-surface-raised border-b border-border flex items-center justify-between px-2">
    <div class="flex items-center space-x-1">
      <button
        onclick={toggleServers}
        class="text-text-muted hover:text-text p-2 rounded transition-colors"
        title={$settings.orderbyserver ? 'Switch to list view' : 'Group by server'}
        data-testid="toggle-server-groups"
      >
        {#if $settings.orderbyserver}
          <List size={16} />
        {:else}
          <LayoutGrid size={16} />
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
          <div class="space-y-0.5">
          {#each groupBufs as buffer, i (buffer.id)}
                 <div
                     role="button"
                     tabindex="0"
                     onclick={() => handleBufferClick(buffer.id)}
                     onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleBufferClick(buffer.id); }}
                     ontouchstart={(e) => handleLongPressStart(buffer.id, e)}
                     ontouchend={handleLongPressEnd}
                     ontouchcancel={handleLongPressEnd}
                     data-testid="buffer-item"
                     {@attach tooltipAttachment(buffer)}
                     style="--i: {i}"
                     class="buffer-item-enter group flex items-center gap-0.5 px-3 py-2 sm:px-4 sm:py-2.5 md:px-5 md:py-3 cursor-pointer rounded-r-md hover:bg-surface-raised active:bg-accent/10 transition-colors duration-150 touch-manipulation select-none {buffer.id === $activeBufferId ? 'border-s-[3px] border-s-accent bg-surface-raised' : 'border-s-[3px] border-s-transparent'}"
                   >
                  {#if getBufferIcon(buffer)}
                    {@const Icon = getBufferIcon(buffer)}
                   <div class="w-5 flex-shrink-0 inline-flex items-center justify-center">
                     <Icon size={18} class="-translate-y-[1px] {getIconClass(buffer)}" />
                   </div>
                 {/if}
<span class="buffer-name align-middle text-sm sm:text-xs {getNotifyClass(buffer)} min-w-0 truncate">
                      {getDisplayName(buffer)}
                    </span>
{#if getEffectiveUnread(buffer) > 0}
                          <Badge
                            variant={buffer.notification > 0 ? 'danger' : 'warning'}
                            mode="subtle"
                            class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold"
                            data-testid="unread-badge"
                          >
                            {getEffectiveUnread(buffer)}
                          </Badge>
                        {/if}
{#if getQuickKeyIndex(buffer) !== null}
                          <Badge
                            mode="bright"
                            class="absolute left-1 top-1/2 -translate-y-1/2 h-4 text-[10px] font-bold shadow-sm px-1"
                            data-testid="quick-key"
                          >
                            {getQuickKeyIndex(buffer)}
                          </Badge>
                        {/if}
             </div>
         {/each}
          </div>
      </div>
    {/each}
  </div>

  {#if longPressBufferId}
    {@const targetBuffer = $buffers[longPressBufferId]}
    <div
      onclick={(e) => { e.stopPropagation(); clearLongPress(); }}
      onkeydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') clearLongPress(); }}
      role="button"
      tabindex="0"
      aria-label="Dismiss menu"
      class="absolute inset-0 z-50 outline-none focus:bg-black/20"
    >
      <div
        class="absolute bg-surface-raised border border-border rounded-lg shadow-xl py-1 min-w-[140px] z-50"
        style="left: {longPressMenuX}px; top: {longPressMenuY}px;"
      >
        {#if targetBuffer}
          <button
            onclick={(e) => { e.stopPropagation(); copyBufferName(getDisplayName(targetBuffer)); clearLongPress(); }}
            data-testid="context-copy-name"
            class="w-full flex items-center gap-2 px-3 py-2 text-sm text-text hover:bg-accent/10 transition-colors"
          >
            <Copy size={14} /> Copy name
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>
