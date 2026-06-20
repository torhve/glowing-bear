<script lang="ts">

  import { connected, weechatVersion } from '$lib/stores/models';
  import { connectionState, connectionStats, formatBytes, timeAgo, formatDuration } from '$lib/stores/connectionStore';
  import { settings, updateSettings } from '$lib/stores/settings';
  import { disconnect } from '$lib/stores/connectionManager';
  import { isWindowsTauri, minimizeWindow, toggleMaximizeWindow, closeWindow } from '$lib/tauriWindow';
  import SettingsModal from '$components/SettingsModal.svelte';
  import BufferSearchModal from '$components/BufferSearchModal.svelte';
  import BufferHotlist from '$components/BufferHotlist.svelte';
  import Search from '@lucide/svelte/icons/search';
  import Users from '@lucide/svelte/icons/users';
  import Settings from '@lucide/svelte/icons/settings';
  import Power from '@lucide/svelte/icons/power';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import Minimize2 from '@lucide/svelte/icons/minimize-2';
  import Maximize2 from '@lucide/svelte/icons/maximize-2';
  import X from '@lucide/svelte/icons/x';

  let { onBufferSelect = () => {}, onSearchOpen = () => {}, bufferListVisible = true } = $props();

  let windowsTauri = $derived(isWindowsTauri());

  function handleDisconnect() {
    disconnect();
  }

  function toggleNicklist() {
    updateSettings({ showNicklist: !$settings.showNicklist });
  }

  let showNicklist = $derived($settings.showNicklist);
</script>

<div data-testid="top-bar" style="padding-top: env(safe-area-inset-top, 0px);">
  <div class="h-10 bg-surface-raised border-b border-border flex items-center px-2 space-x-2" data-tauri-drag-region>
    <div class="flex items-center gap-1 flex-1 min-w-0">
      <img src="/glowing-bear.svg" alt="logo" class="w-5 h-5 flex-shrink-0" />
      {#if bufferListVisible}
        <span data-testid="app-title" class="text-sm font-bold text-text">Glowing Bear</span>
        {#if $weechatVersion.length > 0}
          <span class="text-xs text-text-muted">| WeeChat {$weechatVersion.join('.')}</span>
        {/if}
      {:else}
        <BufferHotlist onBufferSelect={onBufferSelect} />
      {/if}
    </div>

    <div class="flex items-center space-x-1">
      {#if windowsTauri}
        <button
          data-tauri-drag-region="false"
          onclick={() => minimizeWindow()}
          class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-danger rounded"
          title="Minimize"
          data-testid="minimize-button"
        >
          <Minimize2 size={14} />
        </button>
        <button
          data-tauri-drag-region="false"
          onclick={() => toggleMaximizeWindow()}
          class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
          title="Maximize"
          data-testid="maximize-button"
        >
          <Maximize2 size={14} />
        </button>
        <button
          data-tauri-drag-region="false"
          onclick={() => closeWindow()}
          class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-danger rounded"
          title="Close"
          data-testid="close-button"
        >
          <X size={14} />
        </button>
      {/if}

      <div class="relative group">
        <div
          id="connection-stats-popover"
          class="absolute right-[50px] top-[calc(100%+6px)] z-50 min-w-[180px] bg-surface-raised border border-border rounded-lg shadow-xl p-3 text-xs opacity-0 transition-opacity duration-150 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto"
        >
          <div class="absolute -top-1.5 right-4 w-3 h-3 bg-surface-raised border-r border-t border-border rotate-45"></div>
          {#if $connectionStats.lastMessageAt > 0}
            <div class="flex items-center gap-2 text-text-secondary mb-2">
              <MessageSquare size={14} />
              <span>Last message: <strong class="text-text">{timeAgo($connectionStats.lastMessageAt)}</strong></span>
            </div>
          {/if}
          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-3 text-text-secondary">
              <span class="flex items-center gap-1"><ArrowUp size={12} class="text-success"/> Sent</span>
              <span class="text-text font-mono">{formatBytes($connectionStats.bytesSent)}</span>
            </div>
            <div class="flex items-center justify-between gap-3 text-text-secondary">
              <span class="flex items-center gap-1"><ArrowDown size={12} class="text-blue-400"/> Recv</span>
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
          popovertarget="connection-stats-popover"
          class="flex items-center space-x-1 px-2 py-1 rounded text-xs hover:text-white hover:bg-surface-raised"
          type="button"
        >
          <div class="w-2 h-2 rounded-full {
            $connectionState.status === 'connected' ? 'bg-success' :
            $connectionState.status === 'connecting' || $connectionState.status === 'reconnecting' ? 'bg-warning animate-pulse' :
            $connectionState.status === 'error' ? 'bg-danger' :
            'bg-text-muted'
          }"></div>
          <span class="text-text-secondary hidden sm:inline">
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
        class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
        title="Search buffers (Alt+G)"
        data-testid="search-button"
        onclick={() => onSearchOpen()}
      >
        <Search size={16} />
      </button>

      <button
        data-tauri-drag-region="false"
        onclick={toggleNicklist}
        class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
        title="Toggle nicklist (Alt+n)"
        data-testid="nicklist-button"
        class:bg-surface-raised={showNicklist}
      >
        <Users size={16} />
      </button>

      <button
        data-tauri-drag-region="false"
        popovertarget="settings-modal"
        class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
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
          class="px-2 py-1 text-sm text-danger hover:text-danger hover:bg-surface-raised rounded"
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
