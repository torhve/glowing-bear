<script lang="ts">
  import BaseDialog from '$components/BaseDialog.svelte';
  import X from '@lucide/svelte/icons/x';

  let {
    text = '',
    onJoin = () => {},
    onSeparate = () => {},
    onCancel = () => {},
  }: {
    text?: string;
    onJoin?: () => void;
    onSeparate?: () => void;
    onCancel?: () => void;
  } = $props();

  // Hold ref to BaseDialog component to access its <dialog> element
  let baseDialogRef = $state<{ dialog: HTMLDialogElement | undefined }>();
  let dialog = $derived(baseDialogRef?.dialog);
  export { dialog };

  // Default action — "Paste each line separately" gets initial focus so Enter confirms it
  let separateButtonRef = $state<HTMLButtonElement>();

  // Focus the default action button whenever the dialog is shown with new text
  $effect(() => {
    if (text.length > 0) {
      separateButtonRef?.focus();
    }
  });

  // How many lines to show in the preview before truncating
  const PREVIEW_MAX_LINES = 8;

  // Count of lines in the pasted text (matches the threshold counting used in InputBar)
  let lineCount = $derived(text.split(/\r?\n/).length);
  let previewText = $derived(text.split(/\r?\n/).slice(0, PREVIEW_MAX_LINES).join('\n'));
  let hiddenLines = $derived(Math.max(0, lineCount - PREVIEW_MAX_LINES));
</script>

<BaseDialog bind:this={baseDialogRef} id="multiline-paste-dialog" labelledby="multiline-paste-title">
  <div class="flex flex-col max-h-[85vh]">
    <!-- Header -->
    <div class="flex items-center justify-between px-6 py-4 border-b border-border">
      <h3 id="multiline-paste-title" class="text-lg font-bold text-text">
        Paste {lineCount} lines?
      </h3>
      <button
        type="button"
        popovertarget="multiline-paste-dialog"
        popovertargetaction="hide"
        onclick={onCancel}
        class="text-text-secondary hover:text-text p-1 rounded transition-colors"
        aria-label="Close"
        data-testid="multiline-paste-close"
      >
        <X size={18} />
      </button>
    </div>

    <!-- Content area -->
    <div class="px-6 py-4 overflow-y-auto flex-1">
      <p class="text-sm text-text-secondary mb-3">
        This text has {lineCount} lines. If you send it as-is, each line will be sent as a separate
        message.
      </p>
      <pre
        data-testid="multiline-paste-preview"
        class="bg-input-bg border border-border rounded p-3 text-sm font-mono text-text whitespace-pre-wrap break-words max-h-60 overflow-y-auto"
      >{previewText}</pre>
      {#if hiddenLines > 0}
        <p class="text-xs text-text-muted mt-2">… and {hiddenLines} more line{hiddenLines > 1 ? 's' : ''}</p>
      {/if}
    </div>

    <!-- Footer actions -->
    <div class="px-6 py-4 border-t border-border flex flex-wrap justify-end gap-2">
      <button
        type="button"
        onclick={onCancel}
        class="px-4 py-2 border border-border text-text hover:bg-border rounded text-sm transition-colors"
        data-testid="multiline-paste-cancel"
      >
        Cancel
      </button>
      <button
        type="button"
        onclick={onJoin}
        class="px-4 py-2 border border-border text-text hover:bg-border rounded text-sm transition-colors"
        data-testid="multiline-paste-join"
      >
        Join into one message
      </button>
      <button
        type="button"
        bind:this={separateButtonRef}
        onclick={onSeparate}
        class="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm font-medium transition-colors"
        data-testid="multiline-paste-separate"
        aria-keyshortcuts="Enter"
      >
        Paste each line separately
      </button>
    </div>
  </div>
</BaseDialog>
