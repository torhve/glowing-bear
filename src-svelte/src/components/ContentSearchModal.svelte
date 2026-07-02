<script lang="ts">
  import BaseDialog from '$components/BaseDialog.svelte';
  import FormInput from '$components/FormInput.svelte';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';

  interface Props {
    onSearch(query: string): void;
  }

  let { onSearch }: Props = $props();

  let searchQuery = $state('');
  let dialogRef = $state<HTMLDialogElement>();

  function handleSearch() {
    const query = searchQuery.trim();
    if (query) {
      onSearch(query);
      searchQuery = '';
      (document.getElementById('content-search-modal') as HTMLElement)?.hidePopover();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  }

  function handleToggle(event: ToggleEvent) {
    if (event.newState === 'open') {
      const input = document.getElementById('content-search-input') as HTMLInputElement;
      input?.focus();
    }
  }

  export { dialogRef as dialog };
</script>

<BaseDialog id="content-search-modal" labelledby="content-search-title" noAnimation ontoggle={handleToggle}>
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
