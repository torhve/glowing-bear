<script lang="ts">
  import type { BufferLine } from '$lib/types';
  import { get } from 'svelte/store';
  import { currentBuffer, saveScrollPosition, activeBufferId, bufferBottom } from '$lib/stores/models';
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
  let prevScrollKey = $state<string>('');
  // Read end index for readmarker positioning. setActiveBuffer folds localUnread
  // into lastSeen at switch time, so lastSeen alone gives the correct boundary.
  let readEndIndex = $derived($currentBuffer?.lastSeen ?? -1);
  let hasUnreadMessages = $derived($currentBuffer && readEndIndex >= 0 && readEndIndex < messages.length - 1);
  let unreadCount = $derived(readEndIndex >= 0 ? messages.length - readEndIndex - 1 : 0);

  function handleScroll() {
    if (!containerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef;

    // Update isAtBottom tracking (AngularJS bufferBottom equivalent)
    isAtBottom = scrollTop >= scrollHeight - clientHeight - 3;

    if (scrollTop < 50 && !isLoadingMore && $currentBuffer && !$currentBuffer.allLinesFetched) {
      isLoadingMore = true;
      maxScrollValBeforeFetch = scrollHeight - clientHeight;

      void (async () => {
        try {
          await fetchMoreLines();
        } catch (err) {
          console.error('Failed to fetch more lines:', err);
        } finally {
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
        }
      })();
    }
  }

  $effect(() => {
    // Save scroll position when leaving a buffer
    if (prevActiveBufferId && containerRef) {
      saveScrollPosition(prevActiveBufferId, containerRef.scrollTop);
    }
  });

  $effect(() => {
    // Sync local isAtBottom state to shared bufferBottom store
    bufferBottom.set(isAtBottom);
  });

  $effect.pre(() => {
    // Auto-scroll when buffer changes or new lines arrive
    // Skip if loading more lines or was scrolled up during fetch
    if (!$currentBuffer || isLoadingMore || messages.length === 0 || !containerRef) {
      prevActiveBufferId = get(activeBufferId);
      prevLinesLength = messages.length;
      return;
    }

    // Read reactive values BEFORE any await to avoid stale snapshots.
    // $derived values do NOT re-evaluate after await in async functions (Svelte 5 limitation).
    const currentBufferId = get(activeBufferId);
    const curHasUnreadMessages = hasUnreadMessages;
    const curReadEndIndex = readEndIndex;
    const curLinesLength = messages.length;
    const curBufferShortName = $currentBuffer.shortName;
    const bufferChanged = prevActiveBufferId !== currentBufferId;
    const linesAdded = curLinesLength > prevLinesLength;

    // If nothing changed, skip scroll operations entirely
    if (!bufferChanged && !linesAdded) return;

    // Dedup guard: run synchronously to prevent cascading effect re-runs.
    const scrollKey = `${currentBufferId}-${curLinesLength}`;
    if (prevScrollKey === scrollKey) return;

    // Update tracking state SYNCHRONOUSLY (not inside async IIFE) so that
    // when the effect re-runs from other reactive changes, the dedup guard catches it.
    prevScrollKey = scrollKey;
    prevActiveBufferId = currentBufferId;
    prevLinesLength = curLinesLength;

    console.log(
      '[ChatView] scroll effect — buffer:', curBufferShortName,
      '| totalLines:', curLinesLength,
      '| prevLinesLength:', prevLinesLength,
      '| bufferChanged:', bufferChanged,
      '| linesAdded:', linesAdded,
      '| scrollTop:', containerRef!.scrollTop,
      '| scrollHeight:', containerRef!.scrollHeight,
      '| clientHeight:', containerRef!.clientHeight,
      '| isAtBottom:', isAtBottom,
      '| hasUnreadMessages:', curHasUnreadMessages,
      '| readEndIndex:', curReadEndIndex
    );

    if (!curHasUnreadMessages) {
      // No unread messages — scroll to bottom
      // Use rAF so DOM has updated after new lines were added.
      requestAnimationFrame(() => {
        containerRef!.scrollTop = containerRef!.scrollHeight;
        isAtBottom = true;
        console.log(
          '[ChatView] scroll → bottom — scrollTop:', containerRef!.scrollTop,
          '| scrollHeight:', containerRef!.scrollHeight,
          '| bufferLines:', curLinesLength
        );
      });
    } else {
      // Unread messages present — scroll to readmarker
      // Double rAF: first cycle lets Svelte render readmarker DOM, second positions it
      requestAnimationFrame(() => {
        const rmRow = document.querySelector('.readmarker');
        if (!rmRow || !rmRow.parentElement) {
          console.warn('[ChatView] readmarker row not in DOM yet');
          isAtBottom = false;
          return;
        }

        // Second rAF ensures layout is computed after Svelte's DOM insert
        requestAnimationFrame(() => {
          // Use getBoundingClientRect for accurate viewport-relative positioning.
          // offsetTop is unreliable inside collapsed tables (relative to td, not container).
          const rmRect = rmRow.getBoundingClientRect();
          const containerRect = containerRef!.getBoundingClientRect();

          if (containerRef!.scrollHeight > containerRef!.clientHeight) {
            // Position readmarker near middle of viewport (~45%) so it's visible with unread context below.
            // targetY = container top + 0.45 * viewport height
            const targetY = containerRect.top + containerRef!.clientHeight * 0.45;
            // diff = how far to scroll: positive means scroll down, negative means scroll up
            const diff = rmRect.top - targetY;
            containerRef!.scrollTop = containerRef!.scrollTop + diff;
          }
          isAtBottom = false;
          console.log(
            '[ChatView] scroll → readmarker — scrollTop:', containerRef!.scrollTop,
            '| bufferLines:', curLinesLength,
            '| rmViewportY:', rmRect.top.toFixed(1),
            '| containerViewportTop:', containerRect.top.toFixed(1),
            '| clientHeight:', containerRef!.clientHeight
          );
        });
      });
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

  async function handleFetchMore() {
    if (isLoadingMore || $currentBuffer?.allLinesFetched) return;
    isLoadingMore = true;
    try {
      await fetchMoreLines();
    } catch (err) {
      console.warn('[fetchMoreLines] fetch failed:', err);
    } finally {
      isLoadingMore = false;
    }
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

          {#if readEndIndex >= 0 && readEndIndex < messages.length - 1}
            <!-- Read lines (up to and including readEndIndex) -->
            {#each messages.slice(0, readEndIndex + 1) as message, i (i)}
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
                <div class="readmarker-container">
                  <div class="readmarker-line"></div>
                  <span class="readmarker-badge">{unreadCount} new</span>
                  <div class="readmarker-line"></div>
                </div>
              </td>
            </tr>
            <!-- Unread lines (after readEndIndex) -->
            {#each messages.slice(readEndIndex + 1) as message, i (readEndIndex + 1 + i)}
              <BufferLineRow
                {message}
                index={readEndIndex + 1 + i}
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

  .readmarker td {
    padding: 8px 0 !important;
  }

  .readmarker {
    height: auto !important;
  }

  .readmarker-container {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    position: relative;
  }

  .readmarker-line {
    flex: 1;
    height: 1px;
    background: linear-gradient(to right, transparent, var(--gb-ribbon, #f0ad4e), var(--gb-ribbon, #f0ad4e), transparent);
    opacity: 0.6;
  }

  .readmarker-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 10px;
    border-radius: 9999px;
    background-color: var(--gb-ribbon-light, rgba(240, 173, 78, 0.15));
    border: 1px solid var(--gb-ribbon, #f0ad4e);
    color: var(--gb-ribbon, #f0ad4e);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

</style>
