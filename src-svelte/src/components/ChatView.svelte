<script lang="ts">
  import type { BufferLine } from '$lib/types';
  import { get } from 'svelte/store';
  import { currentBuffer, saveScrollPosition, activeBufferId, bufferBottom, buffers, recalculateLinesPerScreen } from '$lib/stores/models';
  import { settings } from '$lib/stores/settings';
  import { fetchMoreLines } from '$lib/stores/connectionManager';
  import { buildMentionText, isFreeBuffer, modifyTextareaValue } from '$lib/utils';
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
  // Bubble mode: enabled when setting is on AND buffer is a private chat type.
  // Only 'private' type buffers (DCC chats and IRC PMs) get bubbles;
  // server, channel, and other system buffers always use table layout.
  let bubbleMode = $derived(
    $settings.stylizePrivateChats &&
    $currentBuffer &&
    $currentBuffer.type === 'private'
  );

  // Other person's nick for self-message detection in bubble mode.
  // Query buffers: shortName IS the other person's nick.
  // Private buffers: fullName is like "server.nicks.other_nick" — extract last segment.
  let otherNick = $derived(
    $currentBuffer ? (
      $currentBuffer.type === 'query'
        ? $currentBuffer.shortName
        : $currentBuffer.fullName.split('.').pop() ?? ''
    ) : ''
  );

  // My nick: prefer buffer's own localVariables.nick; fall back to matching server buffer's nick.
  let myNick = $derived(
    $currentBuffer?.localVariables?.nick ??
    ($currentBuffer ? (
      Object.values(get(buffers)).find(b =>
        b.type === 'server' &&
        b.plugin === $currentBuffer.plugin &&
        b.server === $currentBuffer.server
      )?.localVariables?.nick ?? ''
    ) : '')
  );

  let isLoadingMore = $state(false);
  let maxScrollValBeforeFetch = $state(0);
  // Tracks whether the chat is scrolled to the bottom (AngularJS bufferBottom equivalent).
  // Used to avoid unnecessary scroll operations when already at bottom.
  let isAtBottom = $state(true);
  let prevActiveBufferId = $state<string>('');
  let prevLinesLength = $state(0);
  let prevScrollKey = $state<string>('');
  let readmarkerFailures = $state(0);
  // Read end index for readmarker positioning. lastSeen stays fixed when new messages
  // arrive on active buffer — readmarker persists until user scrolls to bottom (absorbed)
  // or switches buffers (recalculated by setActiveBuffer).
  let readEndIndex = $derived($currentBuffer?.lastSeen ?? -1);
  let hasUnreadMessages = $derived($currentBuffer && readEndIndex >= 0 && readEndIndex < messages.length - 1);
  let unreadCount = $derived(readEndIndex >= 0 ? messages.length - readEndIndex - 1 : 0);

  function handleScroll() {
    if (!containerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef;

    // Update isAtBottom tracking (AngularJS bufferBottom equivalent)
    // Tolerance of 50px accounts for scroll lag when new lines grow scrollHeight
    isAtBottom = scrollTop >= scrollHeight - clientHeight - 50;

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

  // Measure visible lines from actual DOM dimensions, matching AngularJS's calculateNumLines.
  // Samples line height from rendered .bufferline elements and divides container height by it.
  function measureLinesPerScreen() {
    if (!containerRef) return;
    const areaHeight = containerRef.clientHeight;
    const sampleLine = containerRef.querySelector('.bufferline');
    // Fallback line height of 16px when no rendered lines exist yet
    const lineHeight = sampleLine?.clientHeight ?? 16;
    if (lineHeight === 0) return;
    // Fetch 10 lines more than theoretically needed so scrolling up triggers loading of more lines
    const numLines = Math.ceil(areaHeight / lineHeight + 10);
    recalculateLinesPerScreen(numLines);
  }

  // Measure after first render with content — before this, handlers use default (210)
  $effect(() => {
    if (containerRef && messages.length > 0) {
      // Defer to rAF so DOM has fully rendered
      requestAnimationFrame(() => measureLinesPerScreen());
    }
  });

  // Recalculate on window resize (debounced)
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        measureLinesPerScreen();
      }, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
    };
  });

  // Recalculate when font size setting changes
  $effect(() => {
    void $settings.fontsize;
    measureLinesPerScreen();
  });

  $effect(() => {
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
    const curLinesLength = messages.length;
    const bufferChanged = prevActiveBufferId !== currentBufferId;
    const linesAdded = curLinesLength > prevLinesLength;

    // Refresh isAtBottom from actual DOM before handler processes new lines.
    // The handler checks bufferBottom to decide lastSeen update strategy,
    // but the sync effect hasn't fired yet (it runs after buffers.set).
    // This ensures bufferBottom reflects current scroll position when handler reads it.
    if (containerRef && linesAdded) {
      const domAtBottom = containerRef.scrollTop >= containerRef.scrollHeight - containerRef.clientHeight - 3;
      if (isAtBottom !== domAtBottom) {
        isAtBottom = domAtBottom;
        bufferBottom.set(domAtBottom);
      }
    }

    // If nothing changed, skip scroll operations entirely
    if (!bufferChanged && !linesAdded) return;

    // Dedup guard: run synchronously to prevent cascading effect re-runs.
    // Bypass when readmarker lookup previously failed, allowing retry.
    const scrollKey = `${currentBufferId}-${curLinesLength}`;
    if (prevScrollKey === scrollKey && readmarkerFailures === 0) return;

    // Update tracking state SYNCHRONOUSLY (not inside async IIFE) so that
    // when the effect re-runs from other reactive changes, the dedup guard catches it.
    prevScrollKey = scrollKey;
    prevActiveBufferId = currentBufferId;
    prevLinesLength = curLinesLength;

    // When lines are added, defer all scroll decisions to rAF so that:
    // 1) The browser has time to compute layout (getBoundingClientRect works)
    // 2) Scroll events fire and update isAtBottom from handleScroll
    // This ensures reliable at-bottom detection in both headed and headless mode.
    if (linesAdded) {
      requestAnimationFrame(() => {
        // Re-read scroll state after rAF for accurate DOM measurements.
        // Tolerance of 200px accounts for cumulative scrollHeight growth when multiple
        // lines render before the user's scroll event fires (typical line ~20-30px).
        const curIsAtBottom = containerRef!.scrollTop >= containerRef!.scrollHeight - containerRef!.clientHeight - 200;

        // Re-compute hasUnreadMessages from fresh store values inside rAF.
        // $derived does NOT re-evaluate after async boundaries in Svelte 5,
        // so the pre-captured curHasUnreadMessages may be stale by now.
        const freshReadEndIndex = $currentBuffer?.lastSeen ?? -1;
        const freshHasUnread = $currentBuffer && freshReadEndIndex >= 0 && freshReadEndIndex < messages.length - 1;

        if (!freshHasUnread) {
          // No unread messages — scroll to bottom regardless of scroll position.
          // Covers both "at bottom following" and "buffer just switched, scrollTop=0" cases.
          readmarkerFailures = 0;
          containerRef!.scrollTop = containerRef!.scrollHeight;
          isAtBottom = true;
        } else if (curIsAtBottom) {
          // At bottom with unread — absorb by updating lastSeen to cover all lines.
          // User explicitly caught up by scrolling to bottom, so clear the readmarker.
          const buf = get(currentBuffer);
          if (buf) {
            buf.lastSeen = messages.length - 1;
            buffers.set({ ...get(buffers), [buf.id]: { ...buf } });
          }
          containerRef!.scrollTop = containerRef!.scrollHeight;
          isAtBottom = true;
          readmarkerFailures = 0;
        } else if (readmarkerFailures >= 2) {
          // Readmarker fallback.
          readmarkerFailures = 0;
          containerRef!.scrollTop = containerRef!.scrollHeight;
          isAtBottom = true;
        } else {
          // Has unread and not at bottom — scroll to readmarker.
          const rmRow = document.querySelector('.readmarker');
          if (!rmRow || !rmRow.parentElement) {
            readmarkerFailures++;
            prevScrollKey = '';
            isAtBottom = false;
            return;
          }
          requestAnimationFrame(() => {
            readmarkerFailures = 0;
            const rmRect = rmRow.getBoundingClientRect();
            const contRect = containerRef!.getBoundingClientRect();
            const remainingScroll = containerRef!.scrollHeight - containerRef!.scrollTop;
            if (rmRect.bottom <= contRect.bottom && remainingScroll <= containerRef!.clientHeight) {
              // Readmarker + unread fit in viewport and everything below fits — scroll to bottom.
              containerRef!.scrollTop = containerRef!.scrollHeight;
              isAtBottom = true;
            } else if (rmRect.bottom <= contRect.bottom) {
              // Readmarker visible but many unread below — position readmarker at ~45%.
              const targetY = contRect.top + containerRef!.clientHeight * 0.45;
              const diff = rmRect.top - targetY;
              containerRef!.scrollTop = containerRef!.scrollTop + diff;
              isAtBottom = false;
            } else {
              // Readmarker not fully visible — position it at ~45% of viewport.
              const targetY = contRect.top + containerRef!.clientHeight * 0.45;
              const diff = rmRect.top - targetY;
              containerRef!.scrollTop = containerRef!.scrollTop + diff;
              isAtBottom = false;
            }
          });
        }
      });
      return;
    }

    // Buffer changed but no lines added — handle synchronously as before.
    if (!curHasUnreadMessages) {
      // No unread messages — scroll to bottom.
      readmarkerFailures = 0;
      requestAnimationFrame(() => {
        containerRef!.scrollTop = containerRef!.scrollHeight;
        isAtBottom = true;
      });
    } else if (readmarkerFailures >= 2) {
      // Readmarker fallback — scroll to bottom after repeated failures.
      readmarkerFailures = 0;
      requestAnimationFrame(() => {
        containerRef!.scrollTop = containerRef!.scrollHeight;
        isAtBottom = true;
      });
    } else {
      // Unread messages present — scroll to readmarker.
      // Double rAF: first cycle lets Svelte render readmarker DOM, second positions it.
      requestAnimationFrame(() => {
        const rmRow = document.querySelector('.readmarker');
        if (!rmRow || !rmRow.parentElement) {
          readmarkerFailures++;
          prevScrollKey = '';
          isAtBottom = false;
          return;
        }

        // Second rAF ensures layout is computed after Svelte's DOM insert
        requestAnimationFrame(() => {
          readmarkerFailures = 0;
          // Use getBoundingClientRect for accurate viewport-relative positioning.
          // offsetTop is unreliable inside collapsed tables (relative to td, not container).
          const rmRect = rmRow.getBoundingClientRect();
          const containerRect = containerRef!.getBoundingClientRect();

          const remainingScroll = containerRef!.scrollHeight - containerRef!.scrollTop;
          if (rmRect.bottom <= containerRect.bottom && remainingScroll <= containerRef!.clientHeight) {
            // Readmarker + unread fit in viewport and everything below fits — scroll to bottom.
            containerRef!.scrollTop = containerRef!.scrollHeight;
            isAtBottom = true;
          } else if (rmRect.bottom <= containerRect.bottom) {
            // Readmarker visible but many unread below — position readmarker at ~45%.
            const targetY = containerRect.top + containerRef!.clientHeight * 0.45;
            const diff = rmRect.top - targetY;
            containerRef!.scrollTop = containerRef!.scrollTop + diff;
            isAtBottom = false;
          } else {
            // Readmarker not fully visible — position it at ~45% of viewport.
            const targetY = containerRect.top + containerRef!.clientHeight * 0.45;
            const diff = rmRect.top - targetY;
            containerRef!.scrollTop = containerRef!.scrollTop + diff;
            isAtBottom = false;
          }
        });
      });
    }
  });

  // Handle mention click: extract nick from message prefix, insert into input at cursor.
  function handleMention(message: BufferLine) {
    if (!message.showHiddenBrackets) return;
    const prefixParts = message.prefix || [];
    const lastPart = prefixParts[prefixParts.length - 1];
    const nickName = lastPart?.text?.trim() || message.prefixtext?.trim() || '';
    if (!nickName) return;
    modifyTextareaValue('[data-testid="message-input"]', (value: string, start: number, end: number) => {
      const result = buildMentionText(value.substring(0, start) + value.substring(end), nickName, $currentBuffer?.nicklist?.root?.nicks);
      return { value: result.text, cursor: result.caretPos };
    });
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

<div class="chat-view-container flex-1 flex flex-col overflow-hidden">
  {#if $currentBuffer}
    <button
      type="button"
      data-testid="topic-bar"
      popovertarget="topic-modal"
      class="h-8 bg-input-bg border-b border-border flex items-center px-3 text-sm hover:bg-surface transition-colors w-full text-left"
      title="Click to view topic"
    >
      <FileText size={14} class="text-text-muted mr-1 flex-shrink-0" />
      <span class="topic-channel-name text-text">{$currentBuffer.shortName}</span>
      <span class="topic-separator text-text-muted mx-2">-</span>
      <span class="topic-text text-text-secondary truncate">
        <LinkifiedText text={topicText} />
      </span>
    </button>
  {/if}

  <div
    bind:this={containerRef}
    onscroll={handleScroll}
    data-testid="chat-messages"
    class="flex-1 overflow-y-auto overflow-x-hidden bg-bg pb-1"
    class:favorite-font={!$currentBuffer || !isFreeBuffer($currentBuffer)}
    class:free-font={$currentBuffer && isFreeBuffer($currentBuffer)}
    class:hideTime={$currentBuffer?.hideBufferLineTimes}
    style="font-size: var(--font-size, 13px);"
  >
    {#if !$currentBuffer}
      <div class="chat-empty-state flex items-center justify-center h-full text-text-muted">
        <div class="text-center">
          <Inbox size={48} class="mx-auto mb-3 opacity-50" />
          <p class="chat-empty-title text-lg mb-2">No buffer selected</p>
          <p class="chat-empty-subtitle text-sm">Select a buffer from the buffer list</p>
        </div>
      </div>
    {:else if bubbleMode}
      <!-- Bubble mode layout (private/query buffers with stylizePrivateChats enabled) -->
      <div class="chat-bubble-container">
        <!-- Fetch more lines -->
        {#if !$currentBuffer.allLinesFetched && messages.length > 0}
          <div class="bubble-fetchmore-row">
            <button type="button" class="fetchmorelines flex items-center gap-1 px-3 py-1 rounded text-xs font-medium text-text-secondary hover:text-text hover:bg-surface-raised transition-colors" onclick={handleFetchMore}>
              <ChevronUp size={14} class="text-text-muted" />
              Fetch more lines
            </button>
            <span class={['loading-spinner', { hidden: !isLoadingMore }]}>
              Fetching more lines<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>
            </span>
          </div>
        {/if}

        {#if readEndIndex >= 0 && readEndIndex < messages.length - 1}
          <!-- Read lines (up to and including readEndIndex) -->
          {#each messages.slice(0, readEndIndex + 1) as message, i (i)}
            <BufferLineRow
              {message}
              index={i}
              {messages}
              {noembed}
              bubbleMode={true}
              {otherNick}
              {myNick}
              onMention={handleMention}
            />
          {/each}
          <!-- Readmarker between read and unread -->
          <div class="readmarker" data-testid="readmarker">
            <div class="readmarker-container">
              <div class="readmarker-line"></div>
              <span class="readmarker-badge">{unreadCount} new</span>
              <div class="readmarker-line"></div>
            </div>
          </div>
          <!-- Unread lines (after readEndIndex) -->
          {#each messages.slice(readEndIndex + 1) as message, i (readEndIndex + 1 + i)}
            <BufferLineRow
              {message}
              index={readEndIndex + 1 + i}
              {messages}
              {noembed}
              bubbleMode={true}
              {otherNick}
              {myNick}
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
              bubbleMode={true}
              {otherNick}
              {myNick}
              onMention={handleMention}
            />
          {/each}
        {/if}
      </div>
    {:else}
      <!-- Table layout (channels, servers, free buffers) -->
      <table class="chat-table">
        <tbody class="chat-tbody">
          <!-- Fetch more lines row -->
          {#if !$currentBuffer.allLinesFetched && messages.length > 0}
            <tr class="bufferline fetchmore-row">
              <td class="text-center py-1" colspan=3>
                 <button type="button" class="fetchmorelines flex items-center gap-1 px-3 py-1 rounded text-xs font-medium text-text-secondary hover:text-text hover:bg-surface-raised transition-colors" onclick={handleFetchMore}>
                    <ChevronUp size={14} class="text-text-muted" />
                    Fetch more lines
                  </button>
                <span class={['loading-spinner', { hidden: !isLoadingMore }]}>
                  Fetching more lines<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>
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
              <td colspan="3" class="py-2">
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
    {/if}
    <span bind:this={endOfBufferRef} data-end-of-buffer></span>
  </div>

</div>

<TopicModal
  topic={$currentBuffer?.title || []}
  bufferName={$currentBuffer?.shortName || $currentBuffer?.fullName || ''}
/>

<style>
  table,
  .chat-table {
    width: 100%;
    border-collapse: collapse;
  }

  @media (max-width: 640px) {
    table,
    .chat-table {
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
    padding: 8px 0;
  }

  .readmarker {
    height: auto;
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

  /* Bubble mode layout styles */
  .chat-bubble-container {
    display: flex;
    flex-direction: column;
    padding: 10px 14px;
    gap: 2px;
  }

  .bubble-fetchmore-row {
    text-align: center;
    padding: 6px 0;
  }

  /* Readmarker in bubble mode (div-based instead of table tr/td) */
  .readmarker:not(.readmarker td):not(tr) {
    padding: 8px 0;
  }

  .readmarker:not(tr) .readmarker-container {
    max-width: 100%;
  }

</style>
