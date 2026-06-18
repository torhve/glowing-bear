<script lang="ts">
  import type { BufferLine } from '$lib/types';
  import { tick } from 'svelte';
  import { get } from 'svelte/store';
  import { currentBuffer, saveScrollPosition, activeBufferId } from '$lib/stores/models';
  import { settings } from '$lib/stores/settings';
  import { fetchMoreLines } from '$lib/stores/connectionManager';
  import { buildMentionText, isFreeBuffer } from '$lib/utils';
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
  let maxScrollValBeforeFetch = $state(0);
  // Tracks whether the chat is scrolled to the bottom (AngularJS bufferBottom equivalent).
  // Used to avoid unnecessary scroll operations when already at bottom.
  let isAtBottom = $state(true);
  let prevActiveBufferId = $state<string>('');
  let prevLinesLength = $state(0);

  function handleScroll() {
    if (!containerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef;

    // Update isAtBottom tracking (AngularJS bufferBottom equivalent)
    isAtBottom = scrollTop >= scrollHeight - clientHeight - 3;

    if (scrollTop < 50 && !isLoadingMore && $currentBuffer && !$currentBuffer.allLinesFetched) {
      isLoadingMore = true;
      maxScrollValBeforeFetch = scrollHeight - clientHeight;

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
            isAtBottom = false;
          }
          isLoadingMore = false;
        });
      }).catch(err => {
        console.error('Failed to fetch more lines:', err);
        isLoadingMore = false;
      });
    }
  }

  $effect(() => {
    // Save scroll position when leaving a buffer
    if (prevActiveBufferId && containerRef) {
      saveScrollPosition(prevActiveBufferId, containerRef.scrollTop);
    }
  });

 $effect.pre(() => {
    // Auto-scroll when buffer changes or new lines arrive
    // Skip if loading more lines or was scrolled up during fetch
    if (!$currentBuffer || isLoadingMore || messages.length === 0 || !containerRef) {
      prevActiveBufferId = get(activeBufferId);
      prevLinesLength = messages.length;
      return;
    }

    (async () => {
      await tick();

      const currentBufferId = get(activeBufferId);
      const bufferChanged = prevActiveBufferId !== currentBufferId;
      const linesAdded = messages.length > prevLinesLength;
      // Determine if there are unread messages with a readmarker (lastSeen >= 0 and not at end)
      const hasUnreadMessages = $currentBuffer.lastSeen >= 0 && $currentBuffer.lastSeen < messages.length - 1;

      console.log(
        '[ChatView] scroll effect — buffer:', $currentBuffer.shortName,
        '| totalLines:', messages.length,
        '| prevLinesLength:', prevLinesLength,
        '| bufferChanged:', bufferChanged,
        '| linesAdded:', linesAdded,
        '| currentScrollTop:', containerRef.scrollTop,
        '| scrollHeight:', containerRef.scrollHeight,
        '| clientHeight:', containerRef.clientHeight,
        '| isAtBottom:', isAtBottom,
        '| hasUnreadMessages:', hasUnreadMessages,
        '| lastSeen:', $currentBuffer.lastSeen
      );

      if ((bufferChanged || linesAdded) && !hasUnreadMessages) {
        // No unread messages — always scroll to bottom
        containerRef.scrollTop = containerRef.scrollHeight;
        isAtBottom = true;
        console.log(
          '[ChatView] scroll → bottom — scrollTop:', containerRef.scrollTop,
          '| scrollHeight:', containerRef.scrollHeight,
          '| bufferLines:', messages.length
        );
      } else if (hasUnreadMessages) {
        // Buffer has unread messages — scroll to readmarker
        const rm = document.getElementById('readmarker');
        if (rm && rm.parentElement) {
          const targetScrollTop = rm.offsetTop - rm.parentElement.scrollHeight + rm.scrollHeight;
          if (targetScrollTop > 0) {
            containerRef.scrollTop = targetScrollTop;
            console.log(
              '[ChatView] scroll → readmarker — scrollTop:', containerRef.scrollTop,
              '| bufferLines:', messages.length
            );
          } else {
            containerRef.scrollTop = containerRef.scrollHeight;
            console.log(
              '[ChatView] scroll → bottom (readmarker fallback) — scrollTop:', containerRef.scrollTop,
              '| bufferLines:', messages.length
            );
          }
        }
      }

      prevActiveBufferId = currentBufferId;
      prevLinesLength = messages.length;
    })();
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
      class="h-8 bg-input-bg border-b border-border flex items-center px-3 text-sm hover:bg-surface transition-colors w-full text-left"
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
    class="flex-1 overflow-y-auto overflow-x-hidden bg-bg"
    class:favorite-font={!$currentBuffer || !isFreeBuffer($currentBuffer)}
    class:free-font={$currentBuffer && isFreeBuffer($currentBuffer)}
    class:hideTime={$currentBuffer?.hideBufferLineTimes}
    style="font-size: var(--font-size, 13px);"
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
                 <button type="button" class="fetchmorelines flex items-center gap-1 px-3 py-1 rounded text-xs font-medium text-text-secondary hover:text-text hover:bg-surface-raised transition-colors" onclick={handleFetchMore}>
                    <ChevronUp size={14} class="text-text-muted" />
                    Fetch more lines
                  </button>
                <span class={['loading-spinner', { hidden: !isLoadingMore }]}>
                  Fetching more lines...
                </span>
              </td>
            </tr>
          {/if}

          <!-- Readmarker splits read/unread lines -->
          {#if $currentBuffer.lastSeen >= 0 && $currentBuffer.lastSeen < messages.length - 1}
            <!-- Read lines (up to and including lastSeen) -->
            {#each messages.slice(0, $currentBuffer.lastSeen + 1) as message, i (i)}
              <BufferLineRow
                {message}
                index={i}
                {messages}
                {noembed}
                onMention={handleMention}
              />
            {/each}
            <!-- Readmarker row between read and unread -->
            <tr class="readmarker" data-testid="readmarker">
              <td colspan="3">
                <hr id="readmarker">
              </td>
            </tr>
            <!-- Unread lines (after lastSeen) -->
            {#each messages.slice($currentBuffer.lastSeen + 1) as message, i ($currentBuffer.lastSeen + 1 + i)}
              <BufferLineRow
                {message}
                index={$currentBuffer.lastSeen + 1 + i}
                {messages}
                {noembed}
                onMention={handleMention}
              />
            {/each}
          {:else}
            <!-- All lines visible (no readmarker needed) -->
            {#each messages as message, i (i)}
              <BufferLineRow
                {message}
                index={i}
                {messages}
                {noembed}
                onMention={handleMention}
              />
            {/each}
          {/if}
        </tbody>
      </table>
      <span bind:this={endOfBufferRef}></span>
    {/if}
  </div>

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

  @media (max-width: 640px) {
    table {
      border-collapse: separate;
      border-spacing: 2px 3px;
    }
  }

  .fetchmore-row td {
    text-align: center;
    padding: 4px 0;
  }

   .loading-spinner {
    color: var(--gb-text-muted, #888);
    font-size: 0.85em;
  }

  .loading-spinner.hidden {
    display: none;
  }

  .readmarker {
    padding: 0 !important;
    height: 1px !important;
  }

  #readmarker {
    border: none;
    border-top: 1px solid var(--gb-ribbon, #f0ad4e) !important;
    margin: 0;
  }
</style>
