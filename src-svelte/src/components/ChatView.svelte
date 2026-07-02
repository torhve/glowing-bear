<script lang="ts">
  import type { BufferLine } from '$lib/types';
  import { get } from 'svelte/store';
  import { currentBuffer, saveScrollPosition, activeBufferId, bufferBottom, buffers, recalculateLinesPerScreen } from '$lib/stores/models';
  import { settings } from '$lib/stores/settings';
  import { fetchMoreLines, closeBufferOnWeeChat, pinBuffer, unpinBuffer } from '$lib/stores/connectionManager';
  import { buildMentionText, isFreeBuffer, modifyTextareaValue } from '$lib/utils';
  import BufferLineRow from '$components/BufferLineRow.svelte';
  import TopicModal from '$components/TopicModal.svelte';
  import LinkifiedText from '$components/LinkifiedText.svelte';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import Inbox from '@lucide/svelte/icons/inbox';
  import FileText from '@lucide/svelte/icons/file-text';
  import Pin from '@lucide/svelte/icons/pin';
  import PinOff from '@lucide/svelte/icons/pin-off';
  import X from '@lucide/svelte/icons/x';

  let containerRef = $state<HTMLDivElement>();
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
  // Readmarker visibility based solely on lastSeen position relative to message count.
  // Do NOT depend on effectiveUnread — that value can be cleared by hotlist sync
  // while lastSeen (and thus the readmarker) correctly persists for active buffers.
  let unreadCount = $derived(readEndIndex >= 0 ? messages.length - readEndIndex - 1 : 0);

  // Toggle pin/unpin for the currently active buffer via WeeChat localvar_set.
  function handleTogglePin() {
    const bufId = get(activeBufferId);
    if (!bufId) return;
    const bufferData = get(buffers)[bufId];
    if (!bufferData) return;
    const wasPinned = bufferData.pinned;
    buffers.update(current => {
      const existing = current[bufId];
      if (!existing) return current;
      const updated = { ...current };
      updated[bufId] = { ...existing, pinned: !wasPinned };
      return updated;
    });
    if (wasPinned) {
      unpinBuffer(bufId);
    } else {
      pinBuffer(bufId);
    }
  }

  // Close the currently active buffer via WeeChat /close command.
  function handleCloseBuffer() {
    const bufId = get(activeBufferId);
    if (!bufId) return;
    closeBufferOnWeeChat(bufId);
  }

  function handleScroll() {
    if (!containerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef;

    // Update isAtBottom tracking (AngularJS bufferBottom equivalent)
    // Tolerance of 10px accounts for sub-pixel scroll lag when new lines grow scrollHeight
    isAtBottom = scrollTop >= scrollHeight - clientHeight - 10;

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
    /*
         * Scroll decision tree:
         *
         * +------------------------------------------------------+
         * |  bufferChanged?                                     |
         * |                                                      |
         * |  YES ==>  +------------------------------------+     |
         * |           | linesAdded?                          |     |
         * |           |                                      |     |
         * |           | YES ==> rAF: check hasUnread        |     |
         * |           |          +- no unread               |     |
         * |           |          |  ==> scroll to bottom       |     |
         * |           |          +- has unread, fail>=2      |     |
         * |           |          |  ==> fallback to bottom     |     |
         * |           |          +- has unread               |     |
         * |           |             ==> position readmarker    |     |
         * |           +-+------------------------------------+     |
         * |              |                                        |
         * |  NO  ==>  +--+----------------------------------+     |
         * |           | linesAdded?                          |     |
         * |           |                                      |     |
         * |           | YES ==> wasFollowing?                |     |
         * |           |          +- true  ==> scroll to bottom |     |
         * |           |          |         absorb unread       |     |
         * |           |          +- false ==> do nothing (stop) |     |
         * |           |            (user manually scrolled)     |     |
         * |           |                                      |     |
         * |           | NO ==> skip                          |     |
         * |           +--------------------------------------+     |
         * +------------------------------------------------------+
         *
         * Key insight: same-buffer auto-scroll is governed entirely by wasFollowing.
         * Buffer-switch logic uses readmarker positioning. No ownMessage detection.
         */

    // Skip if no buffer, loading more lines, or empty buffer
    if (!$currentBuffer || isLoadingMore || messages.length === 0 || !containerRef) {
      prevActiveBufferId = get(activeBufferId);
      prevLinesLength = messages.length;
      return;
    }

    // Read reactive values synchronously before any await to avoid stale snapshots.
    // $derived values do NOT re-evaluate after await in async functions (Svelte 5 limitation).
    const currentBufferId = get(activeBufferId);
    const curLinesLength = messages.length;
    const bufferChanged = prevActiveBufferId !== currentBufferId;
    const linesAdded = curLinesLength > prevLinesLength;

    // Initialize from scroll handler's authoritative state (50px tolerance).
    // Only attempt synchronous re-check if scroll handler hasn't detected "following".
    // $effect runs AFTER Svelte renders new rows, so scrollHeight has already grown —
    // a fresh scrollTop check would falsely report "not at bottom".
    let wasFollowing = isAtBottom;
    if (containerRef && linesAdded && !wasFollowing) {
      wasFollowing = containerRef.scrollTop >= containerRef.scrollHeight - containerRef.clientHeight - 3;
      if (isAtBottom !== wasFollowing) {
        isAtBottom = wasFollowing;
        bufferBottom.set(wasFollowing);
      }
    }

    // If nothing changed, skip scroll operations entirely
    if (!bufferChanged && !linesAdded) return;

    // DEBUG: log scroll state on each effect run
    console.log('[scroll-effect]',
      `buf=${$currentBuffer?.shortName}`, { bufferChanged, linesAdded, wasFollowing,
        scrollTop: containerRef?.scrollTop ?? '?',
        scrollHeight: containerRef?.scrollHeight ?? '?',
        clientHeight: containerRef?.clientHeight ?? '?',
        threshold: containerRef ? containerRef.scrollHeight - containerRef.clientHeight - 3 : '?',
        isAtBottom, lastSeen: $currentBuffer?.lastSeen ?? -1,
        lines: curLinesLength },
    );

    // Dedup guard: run synchronously to prevent cascading effect re-runs.
    // Bypass when readmarker lookup previously failed, allowing retry.
    const scrollKey = `${currentBufferId}-${curLinesLength}`;
    if (prevScrollKey === scrollKey && readmarkerFailures === 0) return;

    // Update tracking state SYNCHRONOUSLY (not inside async IIFE) so that
    // when the effect re-runs from other reactive changes, the dedup guard catches it.
    prevScrollKey = scrollKey;
    prevActiveBufferId = currentBufferId;
    prevLinesLength = curLinesLength;

    // Same buffer + lines added: defer to rAF for layout, but decision is simple.
    // wasFollowing is authoritative - captured synchronously before render.
    if (!bufferChanged && linesAdded) {
      requestAnimationFrame(() => {
        // Auto-scroll if either pre-capture or continuous scroll handler says 'following'.
        // Pre-capture uses strict 3px tolerance; handleScroll uses generous 50px.
        // Using OR ensures we don't miss cases where user is near-bottom but outside 3px.
        if (wasFollowing || isAtBottom) {
          readmarkerFailures = 0;
          isAtBottom = true;
          // Double-rAF: first after Svelte renders, second after layout computes.
          requestAnimationFrame(() => {
            if (containerRef) containerRef.scrollTop = containerRef.scrollHeight;
          });
          // Absorb unread by updating lastSeen since user caught up.
          const buf = get(currentBuffer);
          if (buf && buf.lastSeen >= 0) {
            buf.lastSeen = buf.lines.length - 1;
            buffers.set({ ...get(buffers), [buf.id]: { ...buf } });
          }
        } else {
          // User manually scrolled away from bottom - do nothing.
              // Preserve their reading position; unread accumulates behind readmarker.
          console.log('[scroll-effect SKIP]',
            `buf=${$currentBuffer?.shortName}`,
            'wasFollowing=false, not scrolling',
          );
        }
      });
      return;
    }

    // Buffer changed (with or without line changes) - defer to rAF so that
    // Svelte has time to render the new buffer's content (including readmarker)
    // before we check for unread messages or try to position the scroll.
    requestAnimationFrame(() => {
      // Re-compute readmarker state from live reactive values inside rAF.
      // $derived does NOT re-evaluate after async boundaries in Svelte 5,
      // so we read $currentBuffer directly (reactive access works inside rAF).
      // Use lastSeen position directly (not effectiveUnread) - hotlist sync
      // can clear effectiveUnread while lastSeen correctly persists for active buffers.
      const freshReadEndIndex = $currentBuffer?.lastSeen ?? -1;
      const freshMessages = $currentBuffer?.lines ?? [];
      const freshHasUnread = freshReadEndIndex >= 0 && freshReadEndIndex < freshMessages.length - 1;

      if (!freshHasUnread) {
        // No unread messages - scroll to bottom.
        readmarkerFailures = 0;
        containerRef!.scrollTop = containerRef!.scrollHeight;
        isAtBottom = true;
      } else if (readmarkerFailures >= 2) {
        // Readmarker fallback - scroll to bottom after repeated failures.
        readmarkerFailures = 0;
        containerRef!.scrollTop = containerRef!.scrollHeight;
        isAtBottom = true;
      } else {
        // Unread messages present - scroll to readmarker.
        // Second rAF ensures layout is computed after Svelte's DOM insert.
        requestAnimationFrame(() => {
          const rmRow = document.querySelector('.readmarker');
          if (!rmRow || !rmRow.parentElement) {
            readmarkerFailures++;
            prevScrollKey = '';
            isAtBottom = false;
            return;
          }

          readmarkerFailures = 0;
          // Use getBoundingClientRect for accurate viewport-relative positioning.
          // offsetTop is unreliable inside collapsed tables (relative to td, not container).
          const rmRect = rmRow.getBoundingClientRect();
          const containerRect = containerRef!.getBoundingClientRect();

          const remainingScroll = containerRef!.scrollHeight - containerRef!.scrollTop;
          if (rmRect.bottom <= containerRect.bottom && remainingScroll <= containerRef!.clientHeight) {
            // Readmarker + unread fit in viewport and everything below fits - scroll to bottom.
            containerRef!.scrollTop = containerRef!.scrollHeight;
            isAtBottom = true;
          } else if (rmRect.bottom <= containerRect.bottom) {
            // Readmarker visible but many unread below - position readmarker at ~45%.
            const targetY = containerRect.top + containerRef!.clientHeight * 0.45;
            const diff = rmRect.top - targetY;
            containerRef!.scrollTop = containerRef!.scrollTop + diff;
            isAtBottom = false;
          } else {
            // Readmarker not fully visible - position it at ~45% of viewport.
            const targetY = containerRect.top + containerRef!.clientHeight * 0.45;
            const diff = rmRect.top - targetY;
            containerRef!.scrollTop = containerRef!.scrollTop + diff;
            isAtBottom = false;
          }
        });
      }
    });
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
    <div class="h-[var(--spacing-topicbar-height,32px)] bg-input-bg border-b border-border flex items-center px-3 w-full" data-testid="topic-bar-container">
      <!-- Left zone: clickable to open topic modal -->
      <button
        type="button"
        data-testid="topic-bar"
        popovertarget="topic-modal"
        class="flex items-center flex-1 min-w-0 text-left text-sm hover:bg-surface transition-colors rounded py-1"
        title="Click to view topic"
      >
        <FileText size={14} class="text-text-muted mr-1 flex-shrink-0" />
        <span class="topic-channel-name text-text flex-shrink-0 whitespace-nowrap">{$currentBuffer.shortName}</span>
        <span class="topic-separator text-text-muted mx-2 flex-shrink-0">-</span>
        <span class="topic-text text-text-secondary truncate overflow-hidden min-w-0">
          <LinkifiedText text={topicText} />
        </span>
      </button>

      <!-- Right zone: action controls (always visible) -->
      <div class="flex items-center gap-0.5 flex-shrink-0 ml-2" data-testid="topic-controls">
        <!-- Pin/Unpin button -->
        <button
          type="button"
          onclick={handleTogglePin}
          class="text-text-muted hover:text-text p-1 rounded transition-colors"
          data-testid="pin-buffer"
          title={$currentBuffer.pinned ? 'Unpin buffer' : 'Pin buffer'}
        >
          {#if $currentBuffer.pinned}
            <PinOff size={16} />
          {:else}
            <Pin size={16} />
          {/if}
        </button>

        <!-- Close button — only show if buffer has no activity (no unread/notification) -->
        {#if $currentBuffer.notification === 0 && $currentBuffer.unread === 0}
          <button
            type="button"
            onclick={handleCloseBuffer}
            class="text-text-muted hover:text-danger p-1 rounded transition-colors"
            data-testid="close-buffer"
            title="Close buffer"
          >
            <X size={16} />
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <div
    bind:this={containerRef}
    onscroll={handleScroll}
    data-testid="chat-messages"
    class="chat-messages flex-1 overflow-y-auto overflow-x-hidden bg-bg"
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
    <span data-end-of-buffer></span>
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

    /* Ensure tbody spans full table width so flex-based bufferlines align left */
    tbody,
    .chat-tbody {
      display: block;
      width: 100%;
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
    padding-block: var(--spacing-line-padding-y, 8px);
  }

  .readmarker {
    height: auto;
  }

  /* Chat messages container bottom padding (gap between last line and input bar) */
  .chat-messages {
    padding-bottom: var(--spacing-chat-container-padding-bottom, 4px);
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
    min-width: 20px;
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

  /* Bubble mode layout styles — overridable by themes via --spacing-* vars */
  .chat-bubble-container {
    display: flex;
    flex-direction: column;
    padding: var(--spacing-bubble-container-padding, 10px 14px);
    gap: var(--spacing-bubble-gap, 2px);
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
