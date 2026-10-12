<script lang="ts">
  import type { BufferPresentation } from '#lib/types.ts';
  import { buffers, activeBufferId, getEffectiveUnread } from '#lib/stores/models.ts';
  import { sidebarOrder, sidebarRows } from '#lib/stores/bufferProjections.ts';
  import { switchBuffer } from '#lib/stores/connectionManager.ts';
  import { chatDisplay, retainedRows } from '#lib/stores/chatPresentation.ts';
  import { selectRetainedBuffer } from '#lib/stores/retainedChat.ts';
  import { settings, updateSettings } from '#lib/stores/settings.ts';
  import { getBufferIconName, getDisplayName } from '#lib/utils.ts';
  import { get } from 'svelte/store';
  import { tooltipAttachment } from '#lib/utils/bufferTooltip.ts';
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

  // Rows come pre-filtered and pre-sorted from the projection: membership under
  // onlyUnread is part of what the list *is*, and the projection can suppress a
  // publication the component could not.
  // The sidebar has to describe the conversation the chat is showing. A retained
  // view has no live buffers, so the live projection is empty — and an empty
  // sidebar beside a readable chat reads as if the session itself had gone, not
  // as a connection that dropped.
  const isLive = $derived($chatDisplay.live);
  let sortedBuffers = $derived(isLive ? $sidebarRows : $retainedRows);
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

  function groupByServer(bufs: BufferPresentation[]) {
    const groups: Record<string, BufferPresentation[]> = {};
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
    // A retained row is a frozen conversation: selecting it moves the retained
    // view. `switchBuffer` would fetch history and publish a live selection for a
    // buffer the relay is not currently serving.
    if (!get(chatDisplay).live) selectRetainedBuffer(bufferId);
    else void switchBuffer(bufferId);
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
  function getNotifyClass(buffer: BufferPresentation): string {
    if (buffer.id === $activeBufferId) return 'text-text font-semibold';
    const eff = getEffectiveUnread(buffer);
    if (buffer.notification >= 3) return 'text-accent font-bold';
    if (eff > 0) return 'text-accent font-medium';
    return 'text-text-secondary font-medium group-hover:text-text';
  }

  // Return icon color class — follows active/hover state for visual cohesion
    // Active icons use full opacity; inactive icons are slightly muted
  function getIconClass(buffer: BufferPresentation): string {
    if (buffer.id === $activeBufferId) return 'text-accent opacity-100';
    return 'text-text-muted opacity-75 group-hover:opacity-100 transition-colors';
  }


  function getQuickKeyIndex(buffer: BufferPresentation): number | null {
    if (!altKeyPressed && (!$settings.showQuickKeys || !$settings.enableQuickKeys)) return null;
    // Quick keys are positions in the sorted buffer list, not positions in the
    // filtered list the sidebar happens to show, so they do not move when
    // onlyUnread hides rows.
    const order = get(sidebarOrder);
    const idx = order.indexOf(buffer.id);
    if (idx === -1 || idx >= 9) return null;
    return idx + 1;
  }

  function getBufferIcon(buffer: BufferPresentation) {
    const iconName = getBufferIconName(buffer);
    if (iconName === 'hash') return Hash;
    if (iconName === 'user') return User;
    if (iconName === 'server') return Server;
    if (iconName === 'monitor') return Monitor;
    return Square;
  }
</script>

<div class="w-56 sm:w-48 lg:w-52 bg-panel border-r border-border flex flex-col" data-testid="buffer-list">
  <div class="buffer-list-header h-[var(--spacing-buffer-list-header-height,40px)] bg-surface-raised border-b border-border flex items-center justify-between px-2">
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
          <div class="buffer-group-label text-xs font-bold text-text-muted bg-input-bg flex items-center gap-1">
            <Server size={12} />{groupName}
          </div>
        {/if}
        <div class="buffer-item-list">
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
              class="buffer-item-enter buffer-item group flex items-center gap-0.5 cursor-pointer rounded-r-md hover:bg-surface-raised active:bg-accent/10 transition-colors duration-150 touch-manipulation select-none {buffer.id === $activeBufferId ? 'border-s-[3px] border-s-accent bg-surface-raised' : 'border-s-[3px] border-s-transparent'}"
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

            <style>
                        /* Spacing — overridable by themes via --spacing-* vars */
                        .buffer-item {
                          padding: var(--spacing-buffer-item-padding-y, 8px) var(--spacing-buffer-item-padding-x, 12px);
                        }

                        .buffer-item-list {
                          display: flex;
                          flex-direction: column;
                          gap: var(--spacing-buffer-group-gap, 2px);
                        }

                        .buffer-group-label {
                          padding: var(--spacing-buffer-group-label-padding, 4px 8px);
                        }
             </style>
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
