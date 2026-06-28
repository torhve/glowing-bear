<script lang="ts">
  import { get } from 'svelte/store';
  import type { NickGroup, Nick } from '$lib/types';
  import Users from '@lucide/svelte/icons/users';
  import Search from '@lucide/svelte/icons/search';
  import { currentBuffer, pendingBufferSwitch } from '$lib/stores/models';
  import { sendBufferCommand } from '$lib/stores/connectionManager';
  import { settings } from '$lib/stores/settings';
  import { insertNickIntoInput, bufferHasNicklist, makeKeyboardActivatable } from '$lib/utils';
  import { DEBUG_NICKLIST } from '$lib/debug';

  let { onClose, forceShow }: { onClose?: () => void; forceShow?: boolean } = $props();
  let searchQuery = $state('');

  // Whether settings allow showing the nicklist (bypassed when forceShow is true for mobile overlay)
  let showNicklist = $derived(forceShow ?? $settings.showNicklist);

  // Whether current buffer actually has nick data to display
      let hasNicklist = $derived(bufferHasNicklist($currentBuffer));

      /* Use $derived.by() for explicit dependency tracking — ensures Svelte 5
         tracks all reactive reads (searchQueryLower, $currentBuffer) even when
         accessed inside nested callbacks like .filter() and .some(). */
      let filteredNickGroups = $derived.by(() => {
        const query = searchQuery.toLowerCase();
        const nicklist = $currentBuffer?.nicklist;
        if (!nicklist) return [];
        return (Object.entries(nicklist) as [string, NickGroup][])
            // Skip root group (it's just a placeholder, not displayed in Angular either)
            .filter(([name]) => name !== 'root')
            .filter(([name, group]) => {
              if (!query) return true;
              return name.toLowerCase().includes(query) ||
                     group.nicks.some((nick: Nick) => nick.name.toLowerCase().includes(query));
            });
      });

  function getPrefixClass(prefix: string): string {
    switch (prefix) {
      case '~': return 'text-[var(--gb-accent)]';
      case '&': return 'text-[var(--gb-danger)]';
      case '@': return 'text-[var(--gb-success)]';
      case '%': return 'text-[var(--gb-warning)]';
      case '+': return 'text-[var(--gb-text-muted)]';
      default: return 'text-text-muted';
    }
  }

  function getPrefix(prefix: string): string {
    return prefix || '';
  }
</script>

{#if showNicklist && hasNicklist}
<div class="w-52 sm:w-28 lg:w-30 bg-panel border-l border-border flex flex-col overflow-hidden" data-testid="nicklist">
  <div class="nicklist-header h-10 bg-surface-raised border-b border-border flex items-center justify-between px-3">
    <span class="nicklist-title flex items-center gap-1.5"><Users size={14} />Nicklist</span>
    {#if onClose}
      <button
        onclick={onClose}
        data-testid="mobile-nicklist-close"
        class="px-1 py-0.5 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded transition-colors"
        title="Close nicklist"
      >
        ✕
      </button>
    {/if}
  </div>

  <div class="nicklist-search-area px-2 py-1 border-b border-border">
    <div class="relative">
      <Search size={14} class="nicklist-search-icon absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <!-- Uncontrolled input: oninput reads from DOM and updates $state.
               Avoids Svelte 5 controlled-input re-render conflict with Playwright .fill() -->
          <input
            type="text"
            id="nicklist-search"
            data-testid="nicklist-search"
            placeholder="Search nicks..."
            autocapitalize="off"
            oninput={(e) => { searchQuery = (e.target as HTMLInputElement).value; }}
            class="form-input w-full bg-input-bg border border-border rounded text-text focus:outline-none focus:border-accent hover:border-text-muted placeholder-text-muted transition-colors pl-8 pr-2 py-1 text-xs"
          />
    </div>
  </div>

  <div class="flex-1 overflow-y-auto" data-testid="nicklist-items">
    {#each filteredNickGroups as [groupName, group], gi (gi)}
        {#if groupName !== 'root'}
      <div class="nick-group border-b border-border">
        {#each group.nicks as nick (nick.name)}
          <div
            data-testid="nick-item"
            class="nick-item px-3 py-0.5 flex items-center hover:bg-surface-raised transition-colors"
            onclick={() => {
              if (DEBUG_NICKLIST) console.log('[nicklist] clicked', nick.name);
              pendingBufferSwitch.set(nick.name);
              sendBufferCommand(nick.buffer, `/query ${nick.name}`);
              setTimeout(() => {
                if (get(pendingBufferSwitch) === nick.name) {
                  pendingBufferSwitch.set(null);
                }
              }, 5000);
            }}
            role="button"
            tabindex="0"
            onkeydown={makeKeyboardActivatable(() => insertNickIntoInput(nick.name))}
          >
            <span class="nick-prefix text-xs {getPrefixClass(getPrefix(nick.prefix))} mr-1">
              {getPrefix(nick.prefix)}
            </span>
            <span class="nick-name text-sm truncate {nick.nameClasses.join(' ')}">
              {nick.name}
            </span>
          </div>
        {/each}
      </div>
        {/if}
    {/each}
  </div>
</div>
{:else if showNicklist && !hasNicklist && onClose}
<div class="w-52 sm:w-28 lg:w-30 bg-panel border-l border-border flex flex-col overflow-hidden" data-testid="nicklist">
  <div class="nicklist-header h-10 bg-surface-raised border-b border-border flex items-center justify-between px-3">
    <span class="nicklist-title flex items-center gap-1.5"><Users size={14} />Nicklist</span>
    {#if onClose}
      <button
        onclick={onClose}
        data-testid="mobile-nicklist-close"
        class="px-1 py-0.5 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
        title="Close nicklist"
      >
        ✕
      </button>
    {/if}
  </div>
  <div class="flex-1 flex items-center justify-center p-4">
    <p class="text-sm text-text-muted text-center">No nicklist for this buffer</p>
  </div>
</div>
{/if}
