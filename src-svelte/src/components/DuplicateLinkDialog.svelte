<script lang="ts">
  import BaseDialog from '#components/BaseDialog.svelte';
  import LinkifiedText from '#components/LinkifiedText.svelte';
  import X from '@lucide/svelte/icons/x';
  import type { DuplicateMatch } from '#lib/duplicateLinks.ts';

  let {
    matches = [] as DuplicateMatch[],
    bufferName = '',
    windowSize = 0,
    onSendAnyway = () => {},
    onEdit = () => {},
  }: {
    matches?: DuplicateMatch[];
    bufferName?: string;
    /** How many of this buffer's lines the scan read — the reach the dialog can claim. */
    windowSize?: number;
    onSendAnyway?: () => void;
    onEdit?: () => void;
  } = $props();

  // Hold ref to BaseDialog component to access its <dialog> element
  let baseDialogRef = $state<{ dialog: HTMLDialogElement | undefined }>();
  let dialog = $derived(baseDialogRef?.dialog);
  export { dialog };

  // Escape and a backdrop click close the popover without running a button. Routing that
  // through onEdit is what makes them mean "Edit" rather than an undecided third thing.
  function handleToggle(event: Event) {
    if ((event as ToggleEvent).newState === 'closed') onEdit();
  }

  // Default focus on Edit: the safe answer is the one Enter confirms.
  let editButtonRef = $state<HTMLButtonElement>();
  $effect(() => {
    if (matches.length > 0) editButtonRef?.focus();
  });

  /** True when the line's own timestamp falls on another local day, so the row shows a date. */
  function isOlderThanToday(date: number): boolean {
    return new Date(date).toDateString() !== new Date().toDateString();
  }
</script>

<BaseDialog bind:this={baseDialogRef} id="duplicate-link-dialog" labelledby="duplicate-link-title" ontoggle={handleToggle}>
  <div class="flex flex-col max-h-[85vh]">
    <!-- Header -->
    <div class="flex items-center justify-between px-6 py-4 border-b border-border">
      <h3 id="duplicate-link-title" class="text-lg font-bold text-text">
        Post this link again?{matches.length > 1 ? ` (${matches.length} previous posts)` : ''}
      </h3>
      <button
        type="button"
        popovertarget="duplicate-link-dialog"
        popovertargetaction="hide"
        onclick={onEdit}
        class="text-text-secondary hover:text-text p-1 rounded transition-colors"
        aria-label="Close"
        data-testid="duplicate-link-close"
      >
        <X size={18} />
      </button>
    </div>

    <!-- Content area -->
    <div class="px-6 py-4 overflow-y-auto flex-1">
      <p class="text-sm text-text-secondary mb-3">
        This link is already in the last {windowSize} messages of {bufferName}.
      </p>
      <ul class="space-y-3">
        {#each matches as match (match.line)}
          <li class="bg-input-bg border border-border rounded p-3" data-testid="duplicate-link-row">
            <div class="flex flex-wrap items-baseline gap-2 text-xs text-text-muted">
              {#if match.line.prefixtext}
                <span class="font-semibold text-text-secondary">{match.line.prefixtext}</span>
              {/if}
              <span>{match.line.shortTime}</span>
              {#if isOlderThanToday(match.line.date)}
                <span>{new Date(match.line.date).toLocaleDateString()}</span>
              {/if}
              <span class="break-all">{match.url}</span>
            </div>
            <p class="text-sm text-text mt-1 break-words overflow-y-auto max-h-40">
              <LinkifiedText text={match.line.text} />
            </p>
          </li>
        {/each}
      </ul>
    </div>

    <!-- Footer actions -->
    <div class="px-6 py-4 border-t border-border flex flex-wrap justify-end gap-2">
      <button
        type="button"
        bind:this={editButtonRef}
        onclick={onEdit}
        class="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm font-medium transition-colors"
        data-testid="duplicate-link-edit"
        aria-keyshortcuts="Enter"
      >
        Edit
      </button>
      <button
        type="button"
        onclick={onSendAnyway}
        class="px-4 py-2 border border-border text-text hover:bg-border rounded text-sm transition-colors"
        data-testid="duplicate-link-send-anyway"
      >
        Send anyway
      </button>
    </div>
  </div>
</BaseDialog>
