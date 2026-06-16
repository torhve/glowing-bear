<script lang="ts">
  import type { BufferData } from '$lib/types';
  import { connected, buffers, weechatVersion, setActiveBuffer } from '$lib/stores/models';
  import { connectionState } from '$lib/stores/connectionStore';
  import { settings, updateSettings } from '$lib/stores/settings';
  import { disconnect } from '$lib/stores/connectionManager';
  import SettingsModal from '$components/SettingsModal.svelte';
  import BufferSearchModal from '$components/BufferSearchModal.svelte';
  import Search from '@lucide/svelte/icons/search';
  import Users from '@lucide/svelte/icons/users';
  import Settings from '@lucide/svelte/icons/settings';
  import Power from '@lucide/svelte/icons/power';

  let { onBufferSelect = () => {}, onSearchOpen = () => {} } = $props();

  function handleDisconnect() {
    disconnect();
  }

  function toggleNicklist() {
    const current = $settings;
    updateSettings({ showNicklist: !current.showNicklist });
  }

  let showNicklist = $derived($settings.showNicklist);
</script>

<div data-testid="top-bar">
  <div class="h-10 bg-surface-raised border-b border-border flex items-center px-2 space-x-2">
    <div class="flex items-center space-x-2 flex-1">
      <div class="flex items-center space-x-2">
       <img src="/glowing-bear.svg" alt="logo" class="w-6 h-6 inline-block mr-1 flex-shrink-0" />
        <span class="text-sm font-bold text-text">Glowing Bear</span>
        {#if $weechatVersion.length > 0}
          <span class="text-xs text-text-muted">| WeeChat {$weechatVersion.join('.')}</span>
        {/if}
      </div>


    </div>

    <div class="flex items-center space-x-1">
      <div class="flex items-center space-x-1 px-2 py-1 rounded text-xs">
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
      </div>

      <button
        popovertarget="buffer-search-modal"
        class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
        title="Search buffers (Alt+G)"
        data-testid="search-button"
        onclick={() => onSearchOpen()}
      >
        <Search size={16} />
      </button>

      <button
        onclick={toggleNicklist}
        class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
        title="Toggle nicklist (Alt+n)"
        data-testid="nicklist-button"
        class:bg-surface-raised={showNicklist}
      >
        <Users size={16} />
      </button>

      <button
        popovertarget="settings-modal"
        class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
        title="Settings"
        data-testid="settings-button"
      >
        <Settings size={16} />
      </button>

      {#if $connected}
        <button
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
