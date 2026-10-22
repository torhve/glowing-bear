<script lang="ts">
  import BaseDialog from '#components/BaseDialog.svelte';
  import FormInput from '#components/FormInput.svelte';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import { focusWhenPopoverOpens } from '#lib/dialogFocus.ts';

  interface Props {
    onSearch(query: string): void;
  }

  let { onSearch }: Props = $props();

  let searchQuery = $state('');
  // The dialog element this modal rendered, read back from BaseDialog: closing a
  // popover by looking up its id in the document worked only while this component
  // was the one thing in the page carrying that id.
  let baseDialog: { dialog: HTMLDialogElement | undefined } | undefined = $state();

  function handleSearch() {
    const query = searchQuery.trim();
    if (query) {
      onSearch(query);
      searchQuery = '';
      baseDialog?.dialog?.hidePopover();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  }

  function handleBeforeToggle(event: ToggleEvent) {
    if (event.newState !== 'open') return;
    focusWhenPopoverOpens('content-search-input');
  }


</script>

<BaseDialog bind:this={baseDialog} id="content-search-modal" labelledby="content-search-title" noAnimation onbeforetoggle={handleBeforeToggle}>
  <div class="content-search-content flex flex-col max-h-[85vh]">
    <div class="content-search-header px-4 py-3 border-b border-border flex items-center justify-between">
      <h2 id="content-search-title" class="text-sm font-bold text-text inline-flex items-center gap-2">
        <Search size={18} class="text-text-muted" />
        Search Buffer Content
      </h2>
      <button
        type="button"
        data-testid="content-search-close"
        popovertarget="content-search-modal"
        popovertargetaction="hide"
        class="text-text-muted hover:text-text p-1 rounded"
        aria-label="Close search"
      >
        <X size={16} />
      </button>
    </div>

    <div class="content-search-input-area px-4 py-2 border-b border-border">
      <FormInput
        id="content-search-input"
        type="text"
        value={searchQuery}
        oninput={(e: Event) => { searchQuery = (e.target as HTMLInputElement).value; }}
        onkeydown={handleKeyDown}
        placeholder="Search content..."
        variant="search"
      />
    </div>

    <div class="content-search-hint px-4 py-2 text-xs text-text-muted">
      Press Enter to search current buffer
    </div>
  </div>
</BaseDialog>
