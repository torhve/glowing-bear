<script lang="ts">
  import { isMacOSTauri, isWindowsTauri, minimizeWindow, toggleMaximizeWindow, closeWindow } from '$lib/tauriWindow';
  import Minimize2 from '@lucide/svelte/icons/minimize-2';
  import Maximize2 from '@lucide/svelte/icons/maximize-2';
  import X from '@lucide/svelte/icons/x';

  let { variant = 'inline' } = $props();

  let windowsTauri = $derived(isWindowsTauri());
  let macosTauri = $derived(isMacOSTauri());
</script>

{#if variant === 'inline'}
  {#if macosTauri}
    <div class="flex items-center gap-1 mr-1">
      <button data-tauri-drag-region="false" onclick={() => closeWindow()} class="w-3 h-3 rounded-full bg-[#ff5f57] border border-[#e54b3f]/30 cursor-pointer" title="Close" data-testid="traffic-light-close"></button>
      <button data-tauri-drag-region="false" onclick={() => minimizeWindow()} class="w-3 h-3 rounded-full bg-[#febc26] border border-[#dfca1d]/30 cursor-default" title="Minimize" data-testid="traffic-light-minimize"></button>
      <button data-tauri-drag-region="false" onclick={() => toggleMaximizeWindow()} class="w-3 h-3 rounded-full bg-[#27c93f] border border-[#1aab29]/30 cursor-default" title="Full Screen" data-testid="traffic-light-maximize"></button>
    </div>
  {/if}
{:else}
  {#if windowsTauri}
    <div class="tauri-titlebar h-8 bg-surface-raised border-b border-border flex items-center justify-end px-2 space-x-1 flex-shrink-0" data-tauri-drag-region>
      <div data-tauri-drag-region="false">
        <button onclick={() => minimizeWindow()} class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-danger rounded" title="Minimize" data-testid="minimize-button"><Minimize2 size={14} /></button>
      </div>
      <div data-tauri-drag-region="false">
        <button onclick={() => toggleMaximizeWindow()} class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded" title="Maximize" data-testid="maximize-button"><Maximize2 size={14} /></button>
      </div>
      <div data-tauri-drag-region="false">
        <button onclick={() => closeWindow()} class="px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-danger rounded" title="Close" data-testid="close-button"><X size={14} /></button>
      </div>
    </div>
  {/if}
  {#if macosTauri}
    <div class="tauri-titlebar h-8 bg-surface-raised border-b border-border flex items-center px-4 flex-shrink-0" data-tauri-drag-region>
      <div class="flex items-center gap-1.5">
        <button data-tauri-drag-region="false" onclick={() => closeWindow()} class="w-3 h-3 rounded-full bg-[#ff5f57] border border-[#e54b3f]/30 cursor-pointer" title="Close" data-testid="traffic-light-close"></button>
        <button data-tauri-drag-region="false" onclick={() => minimizeWindow()} class="w-3 h-3 rounded-full bg-[#febc26] border border-[#dfca1d]/30 cursor-default" title="Minimize" data-testid="traffic-light-minimize"></button>
        <button data-tauri-drag-region="false" onclick={() => toggleMaximizeWindow()} class="w-3 h-3 rounded-full bg-[#27c93f] border border-[#1aab29]/30 cursor-default" title="Full Screen" data-testid="traffic-light-maximize"></button>
      </div>
    </div>
  {/if}
{/if}
