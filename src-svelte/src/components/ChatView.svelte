<script lang="ts">
  import type { BufferLine } from '$lib/types';
  import { currentBuffer } from '$lib/stores/models';
  import { settings } from '$lib/stores/settings';
  import { fetchMoreLines } from '$lib/stores/connectionManager';
  import { buildMentionText, insertNickIntoInput, isFreeBuffer } from '$lib/utils';
  import BufferLineRow from '$components/BufferLineRow.svelte';
  import TopicModal from '$components/TopicModal.svelte';
  import LinkifiedText from '$components/LinkifiedText.svelte';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import Inbox from '@lucide/svelte/icons/inbox';
  import FileText from '@lucide/svelte/icons/file-text';

  let containerRef = $state<HTMLDivElement>();
  let endOfBufferRef = $state<HTMLSpanElement>();
  let messages = $derived($currentBuffer?.lines ?? []);
  let noembed = $derived($settings.noembed);
  let topicText = $derived($currentBuffer?.title?.map(t => t.text).join('') || '');

  let isLoadingMore = $state(false);
  let wasScrolledUpDuringFetch = $state(false);
  let maxScrollValBeforeFetch = $state(0);
  let scrollHeightBeforeFetch = $state(0);
  let scrollTopBeforeFetch = $state(0);

  function handleScroll() {
    if (!containerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef;

    if (scrollTop < 50 && !isLoadingMore && $currentBuffer && !$currentBuffer.allLinesFetched) {
      isLoadingMore = true;
      wasScrolledUpDuringFetch = scrollTop > clientHeight * 0.5 || scrollTop > 200;
      maxScrollValBeforeFetch = scrollHeight - clientHeight;
      scrollHeightBeforeFetch = scrollHeight;
      scrollTopBeforeFetch = scrollTop;

      fetchMoreLines().then(() => {
        // Defer scroll adjustment to rAF so DOM has updated and we avoid
        // race with $effect which runs synchronously on store changes.
        // Set isLoadingMore=false AFTER scroll correction to prevent $effect
        // from auto-scrolling before the position is restored (AngularJS pattern).
        requestAnimationFrame(() => {
          if (containerRef) {
            const newScrollHeight = containerRef.scrollHeight;
            const newMaxScrollVal = newScrollHeight - containerRef.clientHeight;
            // Preserve user's visual position using same formula as AngularJS version
            // Keeps the user at the same point in the buffer (not scrolled to bottom)
            containerRef.scrollTop = newMaxScrollVal - maxScrollValBeforeFetch;
          }
          isLoadingMore = false;
          wasScrolledUpDuringFetch = false;
        });
      }).catch(err => {
        console.error('Failed to fetch more lines:', err);
        isLoadingMore = false;
      });
    }
  }

  $effect(() => {
    // Auto-scroll when new lines arrive on active buffer
    // Skip if loading more lines or was scrolled up during fetch
    if ($currentBuffer && !isLoadingMore && !wasScrolledUpDuringFetch && messages.length > 0 && containerRef) {
      containerRef.scrollTop = containerRef.scrollHeight;
      wasScrolledUpDuringFetch = false;
    }
  });

  function handleMention(message: BufferLine) {
    if (!message.showHiddenBrackets) return;
    const prefixParts = message.prefix || [];
    const lastPart = prefixParts[prefixParts.length - 1];
    const nickName = lastPart?.text?.trim() || message.prefixtext?.trim() || '';
    if (!nickName) return;
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    if (!textarea) return;
    const result = buildMentionText(textarea.value, nickName, $currentBuffer?.nicklist?.root?.nicks);
    textarea.value = result.text;
    textarea.focus();
    textarea.setSelectionRange(result.caretPos, result.caretPos);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function handleFetchMore() {
    if (isLoadingMore || $currentBuffer?.allLinesFetched) return;
    isLoadingMore = true;
    fetchMoreLines().finally(() => {
      isLoadingMore = false;
    });
  }
</script>

<div class="flex-1 flex flex-col overflow-hidden">
  {#if $currentBuffer}
    <button
      type="button"
      data-testid="topic-bar"
      popovertarget="topic-modal"
      class="h-8 bg-input-bg border-b border-border flex items-center px-3 text-sm cursor-pointer hover:bg-surface transition-colors w-full text-left"
      title="Click to view topic"
    >
      <FileText size={14} class="text-text-muted mr-1 flex-shrink-0" />
      <span class="text-text">{$currentBuffer.shortName}</span>
      <span class="text-text-muted mx-2">-</span>
      <span class="text-text-secondary truncate">
        <LinkifiedText text={topicText} />
      </span>
    </button>
  {/if}

  <div
    bind:this={containerRef}
    onscroll={handleScroll}
    data-testid="chat-messages"
    class="flex-1 overflow-y-auto overflow-x-hidden"
    class:favorite-font={!$currentBuffer || !isFreeBuffer($currentBuffer)}
    class:free-font={$currentBuffer && isFreeBuffer($currentBuffer)}
    class:hideTime={$currentBuffer?.hideBufferLineTimes}
    style="background-color: var(--gb-bg, #181818); font-size: var(--font-size, 13px);"
  >
    {#if !$currentBuffer}
      <div class="flex items-center justify-center h-full text-text-muted">
        <div class="text-center">
          <Inbox size={48} class="mx-auto mb-3 opacity-50" />
          <p class="text-lg mb-2">No buffer selected</p>
          <p class="text-sm">Select a buffer from the buffer list</p>
        </div>
      </div>
    {:else}
      <table>
        <tbody>
          <!-- Fetch more lines row -->
          {#if !$currentBuffer.allLinesFetched && messages.length > 0}
            <tr class="bufferline fetchmore-row">
              <td class="text-center py-1" colspan=3>
                 <button type="button" class="fetchmorelines btn btn-xs btn-primary cursor-pointer flex items-center gap-1" onclick={handleFetchMore}>
                   <ChevronUp size={14} />Fetch more lines
                 </button>
                <span class={['loading-spinner', { hidden: !isLoadingMore }]}>
                  Fetching more lines...
                </span>
              </td>
            </tr>
          {/if}

          <!-- Message rows -->
          {#each messages as message, i (i)}
            <BufferLineRow
              {message}
              index={i}
              {messages}
              {noembed}
              onMention={handleMention}
            />
          {/each}

          <!-- Readmarker -->
          {#if $currentBuffer.lastSeen >= 0 && $currentBuffer.lastSeen < messages.length}
            <tr class="readmarker" data-testid="readmarker">
              <td colspan="3">
                <hr id="readmarker">
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
      <span bind:this={endOfBufferRef}></span>
    {/if}
  </div>

  {#if $currentBuffer && $currentBuffer.unread > 0}
    <div class="px-3 py-1 bg-surface-raised border-t border-border text-xs text-text-secondary">
      {$currentBuffer.unread} unread message{$currentBuffer.unread !== 1 ? 's' : ''}
    </div>
  {/if}
</div>

<TopicModal
  topic={$currentBuffer?.title || []}
  bufferName={$currentBuffer?.shortName || $currentBuffer?.fullName || ''}
/>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
  }

  .fetchmore-row td {
    text-align: center;
    padding: 4px 0;
  }

  .fetchmorelines {
    color: var(--gb-accent, #4a90d9);
    text-decoration: none;
    font-size: 0.85em;
  }

  .fetchmorelines:hover {
    text-decoration: underline;
  }

  .loading-spinner {
    color: var(--gb-text-muted, #888);
    font-size: 0.85em;
  }

  .loading-spinner.hidden {
    display: none;
  }

  .readmarker {
    background-color: var(--gb-surface-raised, #2a2a2a);
  }

  #readmarker {
    border: none;
    border-top: 2px solid var(--gb-highlight, #e74c3c);
    margin: 2px 0;
  }
</style>
