<script lang="ts">

  import { connected, weechatVersion } from '$lib/stores/models';
  import { connectionState, connectionStats, formatBytes, timeAgo, formatDuration } from '$lib/stores/connectionStore';
  import { settings } from '$lib/stores/settings';
  import { disconnect } from '$lib/stores/connectionManager';
  import SettingsModal from '$components/SettingsModal.svelte';
  import BufferSearchModal from '$components/BufferSearchModal.svelte';
  import BufferHotlist from '$components/BufferHotlist.svelte';
  import Search from '@lucide/svelte/icons/search';
  import Users from '@lucide/svelte/icons/users';
  import Settings from '@lucide/svelte/icons/settings';
  import Power from '@lucide/svelte/icons/power';
  import TauriTitlebar from '$components/TauriTitlebar.svelte';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import { base } from '$app/paths';

  let { onBufferSelect = () => {}, onSearchOpen = () => {}, onNicklistToggle = () => {}, bufferListVisible = true } = $props();

  function handleDisconnect() {
    disconnect();
  }

  let showNicklist = $derived($settings.showNicklist);
  let tick = $state(0);
  $effect(() => {
    const id = setInterval(() => { tick++; }, 1000);
    return () => clearInterval(id);
  });
</script>

<div data-testid="top-bar" style="padding-top: max(20px, env(safe-area-inset-top, 0px)); padding-left: max(env(safe-area-inset-left), env(safe-area-inset-right), 4px); padding-right: max(env(safe-area-inset-left), env(safe-area-inset-right), 4px);">
  <div class="top-bar-inner h-[var(--spacing-topbar-height,40px)] bg-surface-raised border-b border-border flex items-center px-2 space-x-2" data-tauri-drag-region>
    <div class="flex items-center gap-1 flex-1 min-w-0" data-tauri-drag-region>
      <TauriTitlebar variant="inline" />
      <img src={`${base}/glowing-bear.svg`} alt="logo" class="app-logo w-5 h-5 flex-shrink-0" />
      {#if bufferListVisible}
        <span data-testid="app-title" class="text-sm font-bold text-text">Glowing Bear</span>
        {#if $weechatVersion.length > 0}
          <span class="weechat-version text-xs text-text-muted">| WeeChat {$weechatVersion.join('.')}</span>
        {/if}
      {:else}
        <BufferHotlist onBufferSelect={onBufferSelect} />
      {/if}
    </div>

    <div class="flex items-center space-x-1">
      <div class="relative group">
        <div
          id="connection-stats-popover"
          class="absolute right-[50px] top-[calc(100%+6px)] z-50 min-w-[180px] bg-surface-raised border border-border rounded-lg shadow-xl p-3 text-xs opacity-0 transition-opacity duration-150 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto"
        >
          <div class="popover-arrow absolute -top-1.5 right-4 w-3 h-3 bg-surface-raised border-r border-t border-border rotate-45"></div>
          {#if $connectionStats.lastMessageAt > 0}
            <div class="flex items-center gap-2 text-text-secondary mb-2">
              <MessageSquare size={14} />
              <span>Last message: <strong class="text-text">{timeAgo($connectionStats.lastMessageAt, tick)}</strong></span>
            </div>
          {/if}
          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-3 text-text-secondary">
              <span class="flex items-center gap-1"><ArrowUp size={12} class="text-success"/> Sent</span>
              <span class="text-text font-mono">{formatBytes($connectionStats.bytesSent)}</span>
            </div>
            <div class="flex items-center justify-between gap-3 text-text-secondary">
              <span class="flex items-center gap-1"><ArrowDown size={12} class="text-accent"/> Recv</span>
              <span class="text-text font-mono">{formatBytes($connectionStats.bytesReceived)}</span>
            </div>
          </div>
          {#if $connectionStats.connectedSince > 0}
            <div class="mt-2 pt-2 border-t border-border text-text-secondary text-center">
              Uptime: {formatDuration(Date.now() - $connectionStats.connectedSince)}
            </div>
          {/if}
          {#if ($connectionStats.messagesSent + $connectionStats.messagesReceived) > 0}
            <div class="mt-1 pt-2 border-t border-border text-text-secondary text-center">
              {$connectionStats.messagesSent + $connectionStats.messagesReceived} messages
            </div>
          {/if}
        </div>
        <button
          data-tauri-drag-region="false"
          data-testid="connection-status-button"
          popovertarget="connection-stats-popover"
          class="top-bar-btn connection-status-btn flex items-center space-x-1 rounded text-xs hover:text-white hover:bg-surface-raised transition-colors"
          type="button"
        >
          <div class="connection-dot w-2 h-2 rounded-full {
            $connectionState.status === 'connected' ? 'bg-success' :
              $connectionState.status === 'connecting' || $connectionState.status === 'reconnecting' ? 'bg-warning animate-pulse' :
                $connectionState.status === 'error' || $connectionState.status === 'disconnected' ? 'bg-danger' :
                'bg-text-muted'
          }"></div>
          <span class="connection-status-text text-text-secondary">
            {$connectionState.status === 'connected' ? '' :
              $connectionState.status === 'connecting' ? 'Connecting...' :
                $connectionState.status === 'reconnecting' ? 'Reconnecting...' :
                $connectionState.status === 'error' ? 'Error' :
                'Disconnected'}
          </span>
        </button>
      </div>

      <button
        data-tauri-drag-region="false"
        popovertarget="buffer-search-modal"
        class="top-bar-btn text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded transition-colors"
        title="Search buffers (Alt+G)"
        data-testid="search-button"
        onclick={() => onSearchOpen()}
      >
        <Search size={16} />
      </button>

      <button
        data-tauri-drag-region="false"
        onclick={() => onNicklistToggle()}
        class="top-bar-btn text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded transition-colors"
        title="Toggle nicklist (Alt+n)"
        data-testid="nicklist-button"
        class:bg-surface-raised={showNicklist}
      >
        <Users size={16} />
      </button>

      <button
        data-tauri-drag-region="false"
        popovertarget="settings-modal"
        class="top-bar-btn text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded transition-colors"
        title="Settings"
        data-testid="settings-button"
      >
        <Settings size={16} />
      </button>

      {#if $connected}
        <button
          data-tauri-drag-region="false"
          data-testid="disconnect-button"
          onclick={handleDisconnect}
          class="top-bar-btn text-sm text-danger hover:text-danger hover:bg-surface-raised rounded transition-colors"
          title="Disconnect"
        >
          <Power size={16} />
        </button>
      {/if}
    </div>
  </div>

</div>

<BufferSearchModal onBufferSelect={onBufferSelect} />
<SettingsModal />

<style>
      /* Spacing — overridable by themes via --spacing-* vars */
      .top-bar-btn {
        padding: var(--spacing-topbar-button-padding-y, 4px) var(--spacing-topbar-button-padding-x, 8px);
      }
    </style>
